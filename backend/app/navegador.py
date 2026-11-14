"""Peças do Navegador do celular: arquivos, PDF, hosts locais e reescrita de páginas.

O celular não alcança o `127.0.0.1` do PC. Tudo aqui roda no PC e sai pelo link (túnel ou
Wi-Fi); o celular só conhece o endereço do link. Para abrir um host local dentro do
navegador do celular, o proxy busca a página no PC e **reescreve** os endereços para o
caminho prefixado do link — inclusive os `import` dos módulos do Vite e as chamadas de
`fetch`/XHR em tempo de execução. Sem isso, o front do Koda abriria em branco: os recursos
apontariam para `localhost` do próprio celular.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

#: Um HTML/CSS/JS maior que isto não é reescrito: devolve o corpo como veio. É o suficiente
#: para páginas de desenvolvimento e evita carregar um bundle de dezenas de MB na memória.
MAX_REESCRITA = 12 * 1024 * 1024

#: Tempo de espera do host local. Curto de propósito: host que não responde não pode
#: segurar a tela do celular.
ESPERA_S = 30.0

#: Resolução das páginas de PDF. 110 dpi deixa o texto legível no celular sem gerar PNGs
#: gigantes (uma página A4 fica perto de 900×1270).
PDF_DPI = 110

#: Portas que não são sites: DNS, impressão, adb, os depuradores dos navegadores e o
#: WebSocket do agente. Ficam fora da lista para não poluir o navegador do celular.
PORTAS_IGNORADAS = frozenset({53, 631, 5037, 9223, 9333, 38289})

#: Nome carinhoso das portas que a pessoa reconhece de imediato.
PORTAS_CONHECIDAS = {
    3425: "Agente do Koda",
    5173: "Koda no PC",
    5174: "Koda no PC",
    8787: "Backend do Koda",
    8794: "Servidor de modelos",
}

#: O prefixo que o link manda no cabeçalho para o proxy saber onde ele está montado.
PREFIXO_CABECALHO = "x-koda-prefixo"
_PREFIXO_VALIDO = re.compile(r"^/[A-Za-z0-9._~/-]*$")


def prefixo_valido(valor: str) -> bool:
    """O prefixo entra cru dentro do HTML; só aceita o formato de caminho que o link usa."""
    return bool(valor) and bool(_PREFIXO_VALIDO.fullmatch(valor)) and ".." not in valor


# ---------------------------------------------------------------------------
# Arquivos do projeto
# ---------------------------------------------------------------------------


def resolver(base: Path, sub: str) -> Path:
    """Resolve `sub` dentro de `base` e recusa qualquer fuga por `..` ou symlink."""
    raiz = base.expanduser().resolve()
    alvo = (raiz / sub).resolve() if sub else raiz
    if alvo != raiz and raiz not in alvo.parents:
        raise ValueError("caminho fora da pasta de trabalho")
    return alvo


def listar(base: Path, sub: str) -> dict[str, Any]:
    """Uma pasta do projeto, com pastas primeiro e o caminho relativo de cada item."""
    raiz = base.expanduser().resolve()
    pasta = resolver(raiz, sub)
    if not pasta.is_dir():
        raise ValueError("essa pasta não existe")
    itens: list[dict[str, Any]] = []
    for filho in pasta.iterdir():
        try:
            info = filho.stat()
        except OSError:
            continue
        e_pasta = filho.is_dir()
        itens.append(
            {
                "nome": filho.name,
                "caminho": str(filho.relative_to(raiz)),
                "pasta": e_pasta,
                "tamanho": 0 if e_pasta else info.st_size,
                "mime": "" if e_pasta else (mimetypes.guess_type(filho.name)[0] or ""),
            }
        )
    itens.sort(key=lambda item: (not item["pasta"], item["nome"].lower()))
    return {
        "raiz": str(raiz),
        "caminho": str(pasta.relative_to(raiz)) if pasta != raiz else "",
        "itens": itens,
    }


# ---------------------------------------------------------------------------
# PDF: o WebView do Android não abre PDF, então o PC entrega a página como imagem
# ---------------------------------------------------------------------------


def info_pdf(caminho: Path) -> dict[str, Any]:
    """Quantas páginas o PDF tem. `pypdf` já é dependência do backend."""
    try:
        from pypdf import PdfReader

        leitor = PdfReader(str(caminho))
        return {"paginas": len(leitor.pages)}
    except Exception as erro:  # PDF protegido, corrompido ou biblioteca ausente
        return {"paginas": 0, "erro": str(erro) or "não consegui ler o PDF"}


def pagina_pdf(caminho: Path, pagina: int) -> bytes:
    """Rasteriza **uma** página com o `pdftoppm` do sistema (poppler)."""
    if pagina < 1:
        raise ValueError("página inválida")
    if not shutil.which("pdftoppm"):
        raise RuntimeError("o PC não tem o pdftoppm para mostrar PDF")
    with tempfile.TemporaryDirectory(prefix="koda-pdf-") as tmp:
        saida = Path(tmp) / "pagina"
        processo = subprocess.run(
            [
                "pdftoppm",
                "-f",
                str(pagina),
                "-l",
                str(pagina),
                "-png",
                "-r",
                str(PDF_DPI),
                "-singlefile",
                str(caminho),
                str(saida),
            ],
            capture_output=True,
            timeout=40,
        )
        if processo.returncode != 0:
            raise RuntimeError("não consegui abrir essa página do PDF")
        imagem = saida.with_suffix(".png")
        if not imagem.is_file():
            raise RuntimeError("não consegui abrir essa página do PDF")
        return imagem.read_bytes()


# ---------------------------------------------------------------------------
# Hosts locais
# ---------------------------------------------------------------------------

_cache_hosts: tuple[float, list[dict[str, Any]]] = (0.0, [])


def _portas_do_ss() -> list[tuple[int, str]]:
    """Portas em LISTEN e o processo dono, lidos do `ss` (iproute2)."""
    try:
        saida = subprocess.run(
            ["ss", "-ltnp"], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    vistos: dict[int, str] = {}
    proprio = os.getpid()
    for linha in saida.splitlines()[1:]:
        campos = linha.split()
        if len(campos) < 4 or campos[0] != "LISTEN":
            continue
        achado = re.search(r":(\d+)$", campos[3])
        if not achado:
            continue
        porta = int(achado.group(1))
        if porta in PORTAS_IGNORADAS:
            continue
        processo = ""
        nome = re.search(r'users:\(\("([^"]+)"', linha)
        if nome:
            processo = nome.group(1)
        pid = re.search(r"pid=(\d+)", linha)
        # O link roda no mesmo processo do backend; abrir o próprio link dentro do
        # navegador seria uma tela dentro da outra. O backend (8787) fica.
        if pid and int(pid.group(1)) == proprio and porta != 8787:
            continue
        vistos.setdefault(porta, processo)
    return sorted(vistos.items())


async def portas_locais() -> list[dict[str, Any]]:
    """Hosts HTTP que respondem no PC, com o nome que a pessoa reconhece.

    A sondagem é paralela e curta: a lista aparece junto com a tela, não depois dela.
    """
    global _cache_hosts
    agora = time.monotonic()
    if agora - _cache_hosts[0] < 5.0:
        return _cache_hosts[1]

    portas = await asyncio.to_thread(_portas_do_ss)

    async def sondar(porta: int, processo: str) -> dict[str, Any] | None:
        try:
            async with httpx.AsyncClient(timeout=1.5, follow_redirects=False) as cliente:
                resposta = await cliente.get(f"http://127.0.0.1:{porta}/")
        except httpx.HTTPError:
            return None
        # 404/407 e afins são portas de serviço (métricas do túnel, proxy do
        # editor): respondem, mas não são sites que a pessoa quer abrir. As
        # portas conhecidas do Koda entram mesmo que peçam autenticação.
        if resposta.status_code >= 400 and porta not in PORTAS_CONHECIDAS:
            return None
        tipo = (resposta.headers.get("content-type") or "").split(";")[0].strip().lower()
        if tipo and not (
            tipo.startswith("text/")
            or "json" in tipo
            or "xml" in tipo
            or "html" in tipo
        ):
            return None
        return {
            "porta": porta,
            "rotulo": PORTAS_CONHECIDAS.get(porta) or processo or f"Porta {porta}",
            "processo": processo,
            "tipo": tipo or "desconhecido",
            "status": resposta.status_code,
        }

    achados = await asyncio.gather(
        *(sondar(porta, processo) for porta, processo in portas)
    )
    lista = [item for item in achados if item is not None]
    # As portas conhecidas primeiro, na ordem em que a pessoa pensa nelas.
    ordem = {porta: indice for indice, porta in enumerate(PORTAS_CONHECIDAS)}
    lista.sort(key=lambda item: (ordem.get(item["porta"], 99), item["porta"]))
    _cache_hosts = (agora, lista)
    return lista


# ---------------------------------------------------------------------------
# Reescrita do HTML/CSS/JS
# ---------------------------------------------------------------------------

_ATRIBUTO = re.compile(
    r"(?P<pre>\b(?:src|href|action|poster)\s*=\s*)(?P<q>[\"'])(?P<url>/[^\"']*)(?P=q)",
    re.IGNORECASE,
)
_SRCSET = re.compile(r"(?P<pre>\bsrcset\s*=\s*)(?P<q>[\"'])(?P<valor>[^\"']*)(?P=q)", re.IGNORECASE)
_CSS_URL = re.compile(r"url\(\s*(?P<q>[\"']?)(?P<url>/[^)\"']*)(?P=q)\s*\)", re.IGNORECASE)
_CSS_IMPORT = re.compile(
    r"(?P<pre>@import\s+)(?P<q>[\"'])(?P<url>/[^\"']*)(?P=q)", re.IGNORECASE
)
_JS_IMPORT = re.compile(
    r"(?P<pre>\b(?:from|import)\s*\(?\s*)(?P<q>[\"'])(?P<url>/[^\"']*)(?P=q)",
    re.IGNORECASE,
)
#: O preâmbulo do React Refresh e o CSS do Vite vêm **dentro** da página, não como
#: recurso externo: sem reescrever o corpo, o `import "/@react-refresh"` aponta para
#: a raiz do link e o app do PC não monta.
_SCRIPT_MODULO = re.compile(
    r"(<script\b[^>]*\btype\s*=\s*[\"']module[\"'][^>]*>)(?P<corpo>.*?)(</script>)",
    re.IGNORECASE | re.DOTALL,
)
_ESTILO = re.compile(
    r"(<style\b[^>]*>)(?P<corpo>.*?)(</style>)",
    re.IGNORECASE | re.DOTALL,
)


def _prefixar(url: str, prefixo: str) -> str:
    if not url.startswith("/") or url.startswith("//"):
        return url
    if url == prefixo or url.startswith(prefixo + "/"):
        return url
    return prefixo + url


def _trocar_atributo(achado: re.Match[str], prefixo: str) -> str:
    url = _prefixar(achado.group("url"), prefixo)
    return f"{achado.group('pre')}{achado.group('q')}{url}{achado.group('q')}"


def _trocar_srcset(achado: re.Match[str], prefixo: str) -> str:
    partes = []
    for candidato in achado.group("valor").split(","):
        pedacos = candidato.strip().split(None, 1)
        if not pedacos:
            continue
        pedacos[0] = _prefixar(pedacos[0], prefixo)
        partes.append(" ".join(pedacos))
    return f"{achado.group('pre')}{achado.group('q')}{', '.join(partes)}{achado.group('q')}"


def _trocar_css_url(achado: re.Match[str], prefixo: str) -> str:
    url = _prefixar(achado.group("url"), prefixo)
    return f"url({achado.group('q')}{url}{achado.group('q')})"


def _trocar_import(achado: re.Match[str], prefixo: str) -> str:
    url = _prefixar(achado.group("url"), prefixo)
    return f"{achado.group('pre')}{achado.group('q')}{url}{achado.group('q')}"


def reescrever_css(texto: str, prefixo: str) -> str:
    texto = _CSS_URL.sub(lambda achado: _trocar_css_url(achado, prefixo), texto)
    return _CSS_IMPORT.sub(lambda achado: _trocar_import(achado, prefixo), texto)


def reescrever_js(texto: str, prefixo: str) -> str:
    """`import "/x"` e `from "/x"` dos módulos do Vite também são absolutos do host."""
    return _JS_IMPORT.sub(lambda achado: _trocar_import(achado, prefixo), texto)


def _script_do_navegador(prefixo: str, prefixo_api: str) -> str:
    """Corrige em tempo de execução o que não dá para corrigir no texto.

    O `fetch`, o XHR e o `history` do app chamam caminhos absolutos (`/api/chat`). O
    `<base>` resolve os relativos, mas não os absolutos; este script prefixa os dois e
    desvia as chamadas do front para o backend (`localhost:8787`) pelo mesmo proxy.
    """
    return (
        "<script>(function(){"
        f"var P={json.dumps(prefixo)};var API={json.dumps(prefixo_api)};"
        'var LOCAIS=["http://localhost:8787","http://127.0.0.1:8787"];'
        "function fix(u){"
        'if(typeof u!=="string")return u;'
        "for(var i=0;i<LOCAIS.length;i++){"
        "if(u.indexOf(LOCAIS[i])===0)return API+u.slice(LOCAIS[i].length);}"
        'if(u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf(P+"/")!==0)return P+u;'
        "return u;}"
        "var f=window.fetch;"
        "if(f)window.fetch=function(e,n){"
        'try{if(typeof e==="string")e=fix(e);'
        'else if(e&&typeof e==="object"&&e.url){var novo=fix(e.url);'
        "if(novo!==e.url)e=new Request(novo,e);}}catch(x){}"
        "return f.call(this,e,n);};"
        "var o=XMLHttpRequest.prototype.open;"
        "XMLHttpRequest.prototype.open=function(){"
        "try{if(arguments.length>1)arguments[1]=fix(arguments[1]);}catch(x){}"
        "return o.apply(this,arguments);};"
        '["pushState","replaceState"].forEach(function(n){var h=history[n];'
        "if(!h)return;history[n]=function(s,t,u){"
        'try{if(typeof u==="string")u=fix(u);}catch(x){}'
        "return h.call(this,s,t,u);};});"
        "})();</script>"
    )


def reescrever_html(texto: str, prefixo: str, prefixo_api: str) -> str:
    """Prefixa os recursos, ancora os relativos e injeta o corretor de runtime."""
    texto = _ATRIBUTO.sub(lambda achado: _trocar_atributo(achado, prefixo), texto)
    texto = _SRCSET.sub(lambda achado: _trocar_srcset(achado, prefixo), texto)
    texto = _SCRIPT_MODULO.sub(
        lambda achado: (
            f"{achado.group(1)}{reescrever_js(achado.group('corpo'), prefixo)}{achado.group(3)}"
        ),
        texto,
    )
    texto = _ESTILO.sub(
        lambda achado: (
            f"{achado.group(1)}{reescrever_css(achado.group('corpo'), prefixo)}{achado.group(3)}"
        ),
        texto,
    )
    # O `<base>` precisa ser o **primeiro** da página: o navegador usa o primeiro que vê.
    base = f'<base href="{prefixo}/">'
    script = _script_do_navegador(prefixo, prefixo_api)
    cabeca = re.search(r"<head[^>]*>", texto, re.IGNORECASE)
    if cabeca:
        return texto[: cabeca.end()] + base + script + texto[cabeca.end() :]
    return base + script + texto


def reescrever_location(location: str, prefixo: str, porta: int) -> str:
    """Redirecionamento do host local continua dentro do proxy."""
    alvo = location.strip()
    if alvo.startswith("/") and not alvo.startswith("//"):
        return _prefixar(alvo, prefixo)
    try:
        partes = urlsplit(alvo)
    except ValueError:
        return alvo
    if partes.hostname in {"127.0.0.1", "localhost", "::1", "0.0.0.0"} and partes.port == porta:
        caminho = partes.path or "/"
        if partes.query:
            caminho += "?" + partes.query
        return _prefixar(caminho, prefixo)
    return alvo


def url_do_alvo(porta: int, caminho: str) -> str:
    return f"http://127.0.0.1:{porta}/{caminho.lstrip('/')}"


def cotar(valor: str) -> str:
    """Token em segmento de caminho, sem deixar `/` virar separador."""
    return quote(valor, safe="")
