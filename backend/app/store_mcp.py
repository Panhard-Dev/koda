"""A Store de conectores MCP: catálogo, instalação e login.

**O que isto é.** A aba MCPs da Store mostra conectores — Supabase, Cloudflare, Firebase — e
cada um tem um caminho de três passos, que é o que o dono pediu:

1. **Baixar** — o servidor entra em `data/mcps.json` **desligado** e o pacote é pré-baixado,
   para o primeiro início não sair caro. Baixar não é ativar: nada sobe agora.
2. **Entrar** — o conector precisa de credencial, e o login é o **do provedor**, pelo
   navegador. O Koda roda o comando de login que o próprio provedor publica (`supabase
   login`), lê a URL que ele imprime, **abre ela no navegador** e mostra na tela o código de
   uso único quando o provedor pede um (o device flow do GitHub é assim). O token de verdade
   não passa pela interface: o provedor guarda o dele, e o Koda só lê o resultado.
3. **Ativar** — liga o servidor. Daqui em diante ele é um MCP como qualquer outro: aparece
   em *Ajustes → MCPs* e no submenu MCPs do cabeçalho.

**O catálogo é publicado pelo painel** (`GET /api/public/mcps`), e não escrito no app — foi
a escolha dele. A lista da casa aqui embaixo é o **plano B**: sem resposta da nuvem a tela
não fica vazia, pelo mesmo motivo de sempre (o app abre e conversa sem internet). Quem
quiser corrigir um conector corrige no painel, sem release.

**Nada de credencial em texto na resposta.** A rota devolve `credencial: true/false` e nada
mais; o valor vai para o `env` do servidor e mora no `mcps.json`.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from .config import Settings
from .nuvem import ServicoNuvem

#: A lista da casa, usada quando a nuvem não responde.
#:
#: Cada entrada é o que o Koda precisa saber para os três passos: o `pacote` que se baixa, o
#: `comando`/`params` que sobem o servidor, e o `login` do provedor. A `credencial` diz **como**
#: o token que o login produziu chega ao processo: lendo um arquivo que o CLI do provedor
#: escreveu, ou rodando um comando que o imprime. Conector que o provedor já autentica por
#: conta própria (o Firebase lê a credencial do `firebase-tools`) simplesmente não tem
#: `credencial` — para ele, `login` basta.
#:
#: Esta lista é o plano B e por isso é deliberadamente curta: o painel publica a de verdade.
CONECTORES_DA_CASA: list[dict[str, Any]] = [
    {
        "slug": "supabase",
        "nome": "Supabase",
        "descricao": "Banco, autenticação e storage do seu projeto — o agente consulta e migra.",
        "pacote": "@supabase/mcp-server-supabase",
        "comando": "npx",
        "params": "-y @supabase/mcp-server-supabase@latest",
        "login": "npx -y supabase login",
        "credencial": {"arquivo": "~/.supabase/access-token", "env": "SUPABASE_ACCESS_TOKEN"},
        "doc": "https://supabase.com/docs/guides/getting-started/mcp",
    },
    {
        "slug": "firebase",
        "nome": "Firebase",
        "descricao": "Firestore, Auth e Storage pelo `firebase-tools`.",
        "pacote": "firebase-tools",
        "comando": "npx",
        "params": "-y firebase-tools@latest mcp",
        "login": "npx -y firebase-tools@latest login",
        "doc": "https://firebase.google.com/docs/ai-assistance/mcp-server",
    },
    {
        "slug": "cloudflare",
        "nome": "Cloudflare",
        "descricao": "Workers, KV, D1 e R2 da sua conta.",
        "pacote": "@cloudflare/mcp-server-cloudflare",
        "comando": "npx",
        "params": "-y @cloudflare/mcp-server-cloudflare@latest",
        "login": "npx -y wrangler@latest login",
        "credencial": {"comando": "npx -y wrangler@latest whoami", "env": "CLOUDFLARE_API_TOKEN"},
        "doc": "https://developers.cloudflare.com/agents/model-context-protocol/",
    },
    {
        "slug": "github",
        "nome": "GitHub",
        "descricao": "Issues, pull requests e arquivos dos repositórios que você alcança.",
        "pacote": "@modelcontextprotocol/server-github",
        "comando": "npx",
        "params": "-y @modelcontextprotocol/server-github@latest",
        "login": "gh auth login --web",
        "credencial": {"comando": "gh auth token", "env": "GITHUB_PERSONAL_ACCESS_TOKEN"},
        "doc": "https://github.com/modelcontextprotocol/servers",
    },
]

URL_NA_LINHA = re.compile(r"https?://[^\s)\]\"'<>]+")
"""O que procurar na saída do login: a URL que o provedor manda abrir.

Todo CLI de login imprime alguma coisa parecida — «Opening browser at <url>», «Please visit
<url>» —, mas nenhum promete um formato. Procurar a URL na linha é o que funciona com todos
sem fingir que se sabe o formato de cada um.
"""

CODIGO_DEVICE = re.compile(r"\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b")
"""O código do device flow na forma crua: `1234-5678`."""

CODIGO_ROTULADO = re.compile(
    r"(?:one[- ]time code|user code|c[oó]digo)[\s:=]{0,6}([A-Za-z0-9][A-Za-z0-9-]{3,})",
    re.IGNORECASE,
)
"""O código em qualquer provedor que o **anuncie**: «código: X», «one-time code: X».

O separador só aceita espaço e pontuação (`[\\s:=]`), e **não** qualquer coisa que não seja
dígito: com `\\D` o próprio código servia de separador e «Código: ABCDEF» saía como `BCDEF`
— o regex comia a primeira letra para caber no resto.
"""


def _codigo_na_linha(linha: str) -> str | None:
    """O código que o login manda **digitar** no navegador, quando existe.

    Alguns logins não se resolvem com a URL: a página que abre pede um código de uso único,
    que o CLI imprimiu antes. O do GitHub é assim — «First copy your one-time code:
    1234-5678» —, e sem o código na tela a pessoa abre o navegador e trava num campo que não
    tem o que preencher. Foi exatamente o que o dono viu.

    Duas formas, nesta ordem: a do device flow (o `1234-5678` cru, mais específico) e a
    rotulada (qualquer provedor que escreva «código: …»). Nenhuma inventa: sem casar, devolve
    `None` e a tela mostra só a URL, como antes.
    """
    achado = CODIGO_DEVICE.search(linha)
    if achado:
        return achado.group(1)
    achado = CODIGO_ROTULADO.search(linha)
    return achado.group(1) if achado else None


def _abrir_no_navegador(url: str) -> None:
    """Abre a URL do login no navegador do sistema — uma vez, e sem derrubar nada.

    **Por que daqui, e não da interface.** O `window.open` da tela depende de gesto do
    usuário e esbarra em bloqueio de pop-up: o endereço só chega segundos depois do clique,
    quando a janela já perdeu o gesto. Quem roda o CLI é o backend, na máquina da pessoa —
    abrir daqui funciona igual no app instalado e no navegador de desenvolvimento, e vale
    para **todos** os conectores, que era o pedido.

    Nunca levanta: navegador que não abre (máquina sem ambiente gráfico, política do sistema)
    não pode derrubar um login que está a caminho — a tela continua com o link à mão.
    """
    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001 — ver o motivo acima
        pass

TETO_LOGIN_S = 300.0
"""Quanto um login pode demorar. É o tempo de a pessoa abrir o navegador e autorizar, e não o
de um download — daí ser generoso. Estourado, o processo é derrubado e o estado vira erro."""

MARCADOR_LOGIN = "KODA_MCP_LOGIN"
"""O registro de «o login já correu» para conector que **não** tem regra de credencial.

O Firebase é o caso: quem autentica é o `firebase-tools`, não o Koda, então não há token
nosso para guardar. Sem gravar nada, o passo «Entrar» nunca parecia concluído — a tela ficava
presa nele e o «Ativar» nunca aparecia. O marcador vai para o `env` do servidor como qualquer
credencial (é inofensivo para o provedor) e é o que destrava o passo seguinte."""

_LOGINS: dict[str, dict[str, Any]] = {}
_BAIXAS: dict[str, dict[str, Any]] = {}
_trava = threading.Lock()


# ------------------------------------------------------------------ o arquivo


def caminho_config(settings: Settings) -> Path:
    """Onde ficam os servidores MCP — o mesmo arquivo da rota `/api/mcps`."""
    return settings.database_path.parent / "mcps.json"


def caminho_do_pacote(settings: Settings) -> Path:
    """Onde os pacotes baixados ficam, ao lado do banco (`data/mcp-store`)."""
    return settings.database_path.parent / "mcp-store"


def brutos(caminho: Path) -> list[dict]:
    """Os itens crus do arquivo, sem os que não têm nome."""
    import json

    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(dados, list):
        return []
    return [
        item
        for item in dados
        if isinstance(item, dict) and str(item.get("name", "")).strip()
    ]


def salvar(caminho: Path, itens: list[dict]) -> None:
    import json

    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(itens, ensure_ascii=False, indent=2), encoding="utf-8")


# ------------------------------------------------------------------ catálogo


def _limpar(item: Any) -> dict[str, Any] | None:
    """Um item do catálogo -> o que o app aceita. Item torto é descartado, não corrigido.

    A resposta vem da nuvem, então é dado de fora: nada aqui confia no que chegou. `slug` e
    `comando` são o mínimo — sem os dois não há o que instalar.
    """
    if not isinstance(item, dict):
        return None
    slug = str(item.get("slug", "")).strip()
    comando = str(item.get("comando", "")).strip()
    if not slug or not comando:
        return None
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,39}", slug, flags=re.IGNORECASE):
        return None
    return {
        "slug": slug,
        "nome": str(item.get("nome") or slug).strip()[:60],
        "descricao": str(item.get("descricao", "")).strip()[:280],
        "pacote": str(item.get("pacote", "")).strip()[:120],
        "comando": comando[:120],
        "params": str(item.get("params", "")).strip()[:400],
        "login": str(item.get("login", "")).strip()[:200],
        "credencial": item.get("credencial") if isinstance(item.get("credencial"), dict) else None,
        "doc": str(item.get("doc", "")).strip()[:200] if _doc_vale(item.get("doc")) else "",
    }


def _doc_vale(valor: Any) -> bool:
    """Só link HTTPS entra: a tela abre o que vier daqui, e um `http://` de catálogo
    adulterado mandaria a pessoa para um endereço que não é o do provedor."""
    return isinstance(valor, str) and valor.strip().startswith("https://")


async def catalogo(nuvem: ServicoNuvem) -> tuple[list[dict[str, Any]], str]:
    """O catálogo de conectores, e de onde ele veio. Nunca levanta."""
    dados = await nuvem.catalogo_mcps()
    if dados:
        limpos = [item for item in (_limpar(bruto) for bruto in dados) if item]
        if limpos:
            return limpos, "nuvem"
    return [dict(item) for item in CONECTORES_DA_CASA], "casa"


# ------------------------------------------------------------------ estado


def estado_dos_conectores(
    catalogo_itens: list[dict[str, Any]], instalados: list[dict]
) -> list[dict[str, Any]]:
    """Cada conector do catálogo com o **estado dele nesta máquina**.

    É aqui que os três passos viram dado: `instalado` diz se o «Baixar» já foi, `credencial`
    se o «Entrar» foi, e `ativo` se o «Ativar» foi. Conector sem `login` no catálogo não tem
    credencial para pedir, e vai direto de baixado para ativo.
    """
    por_nome = {str(item.get("name")): item for item in instalados}
    saida: list[dict[str, Any]] = []
    for item in catalogo_itens:
        atual = por_nome.get(item["slug"])
        instalado = atual is not None
        env = atual.get("env") if isinstance(atual, dict) else None
        tem_credencial = isinstance(env, dict) and any(str(v).strip() for v in env.values())
        precisa_login = bool(item.get("login"))
        ativo = bool(atual.get("enabled")) if isinstance(atual, dict) else False
        saida.append(
            {
                **item,
                "instalado": instalado,
                "ativo": ativo,
                "conectado": bool(atual.get("conectado")) if isinstance(atual, dict) else False,
                "erro": atual.get("erro") if isinstance(atual, dict) else None,
                # Sem login publicado não há credencial a exigir: pedir login para um
                # conector que não o tem deixaria a tela num passo sem saída.
                "precisa_login": precisa_login,
                "credencial": tem_credencial,
            }
        )
    return saida


# ------------------------------------------------------------------ baixar


def _npm(settings: Settings) -> str | None:
    """O `npm` que instala os pacotes. Procura ao lado do Node que o Koda conhece, e só
    depois no PATH — o app instalado promete não precisar de Node na máquina."""
    node = settings.node_path
    if node:
        for nome in ("npm.cmd", "npm", "npm.exe"):
            candidato = node.parent / nome
            if candidato.exists():
                return str(candidato)
    for nome in ("npm.cmd", "npm", "npm.exe"):
        achado = _qual(nome)
        if achado:
            return achado
    return None


def _qual(nome: str) -> str | None:
    from shutil import which

    return which(nome)


def _resolver_executavel(nome: str, settings: Settings) -> str:
    """Nome solto que o `Popen` não sabe abrir -> caminho que ele sabe.

    A mesma dor do gerenciador de MCP (`mcp/__init__.py`), e pela mesma razão: no Windows o
    `npx` do PATH é um `npx.cmd` — script de shell que o `CreateProcess` não executa — e o
    login do provedor morre em «não foi possível iniciar 'npx'» com o npx instalado. Pior no
    app instalado: lá o `npx` nem está no PATH, ele mora ao lado do Node que viaja com o Koda.

    Ordem: primeiro o vizinho do Node do app (é o que existe no instalado), depois o PATH
    (é o que existe no dev). Comando que já é caminho (tem pasta) passa intacto — quem
    escreveu escolheu.
    """
    if len(Path(nome).parts) > 1:
        return nome
    base = nome.strip().lower()
    if base in ("node", "node.exe", "npx", "npx.cmd", "npm", "npm.cmd"):
        node = settings.node_path
        if node and Path(node).is_file():
            if base in ("node", "node.exe"):
                return str(node)
            for sufixo in (f"{base}.cmd", base, f"{base}.exe"):
                vizinho = Path(node).parent / sufixo
                if vizinho.is_file():
                    return str(vizinho)
    if os.name == "nt":
        return _qual(nome) or nome
    return nome


def _argv(comando: str, settings: Settings) -> list[str]:
    """O comando do provedor em lista, com o executável resolvido para o `Popen`.

    Sem resolver o primeiro termo, todo conector `npx` da Store falhava no Windows — o passo
    «Entrar» é justamente o que roda `npx … login`.
    """
    partes = shlex.split(comando, posix=os.name != "nt")
    if not partes:
        return partes
    return [_resolver_executavel(partes[0], settings), *partes[1:]]


def _sem_janela() -> dict[str, Any]:
    """Mesma guarda do resto do backend: processo de console sem abrir janela própria."""
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}


def baixar(item: dict[str, Any], settings: Settings) -> tuple[bool, str]:
    """Pré-baixa o pacote do conector. Não sobe nada — só deixa o disco pronto.

    O pacote vai para `data/mcp-store`: é o npm que baixa, não um download nosso, e o comando
    do servidor continua sendo `npx` (que é o que o provedor publica). Baixar **antes** é o
    que faz o primeiro início sair rápido em vez de parecer travado.
    """
    pacote = str(item.get("pacote", "")).strip()
    if not pacote:
        return False, "o catálogo não publicou um pacote para este conector"
    npm = _npm(settings)
    if not npm:
        return False, "npm não encontrado nesta máquina"
    destino = caminho_do_pacote(settings)
    destino.mkdir(parents=True, exist_ok=True)
    argv = [npm, "install", "--no-audit", "--no-fund", "--prefix", str(destino), pacote]
    try:
        concluido = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            cwd=str(destino),
            shell=False,
            **_sem_janela(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"não foi possível baixar: {exc}"
    if concluido.returncode != 0:
        motivo = (concluido.stderr or concluido.stdout or "").strip().splitlines()
        return False, (motivo[-1] if motivo else f"npm saiu com {concluido.returncode}")[:200]
    return True, "pacote baixado"


def _acompanhar_baixa(slug: str, item: dict[str, Any], settings: Settings) -> None:
    """Baixa o pacote numa thread e guarda o resultado. É o corpo do POST «Baixar».

    O `except` largo é deliberado: exceção em thread não aparece em lugar nenhum, e a tela
    ficaria em «Baixando» para sempre sem que ninguém soubesse por quê. Qualquer coisa que
    estoure aqui vira `erro` com o motivo — que é o mínimo que a pessoa precisa ler.
    """
    try:
        ok, motivo = baixar(item, settings)
    except Exception as exc:  # noqa: BLE001 — ver o motivo acima
        ok, motivo = False, f"o download falhou: {exc}"
    with _trava:
        _BAIXAS[slug].update(status="pronto" if ok else "erro", motivo=motivo)


def iniciar_baixa(slug: str, item: dict[str, Any], settings: Settings) -> dict:
    """Baixa **sem prender a requisição**.

    Um `npm install` leva dezenas de segundos, e segurar o POST esse tempo todo fazia a tela
    parecer travada — e a pessoa recarregar no meio. Aqui o registro no `mcps.json` sai na
    hora (é instantâneo e já é o que a tela precisa para mudar de estado) e o download segue
    em segundo plano, com `estado_baixa()` para a tela perguntar.
    """
    registro = registrar(item, settings)
    if registro.get("enabled"):
        return {"status": "pronto", "instalado": True, "ativo": True, "motivo": "já instalado"}
    with _trava:
        atual = _BAIXAS.get(slug)
        if atual and atual.get("status") == "baixando":
            return dict(atual)
        _BAIXAS[slug] = {
            "status": "baixando",
            "instalado": True,
            "ativo": False,
            "motivo": None,
        }
    threading.Thread(
        target=_acompanhar_baixa,
        args=(slug, item, settings),
        name=f"baixa-mcp-{slug}",
        daemon=True,
    ).start()
    with _trava:
        return dict(_BAIXAS[slug])


def estado_baixa(slug: str) -> dict:
    with _trava:
        return dict(
            _BAIXAS.get(slug)
            or {"status": "nenhum", "instalado": False, "ativo": False, "motivo": None}
        )


def registrar(item: dict[str, Any], settings: Settings) -> dict:
    """Grava o servidor em `mcps.json`, **desligado**. Não reconecta: nada sobe agora."""
    caminho = caminho_config(settings)
    itens = brutos(caminho)
    slug = str(item["slug"])
    for atual in itens:
        if str(atual.get("name")) == slug:
            return atual
    novo = {
        "name": slug,
        "description": str(item.get("descricao", "")),
        "command": str(item.get("comando", "")),
        "params": str(item.get("params", "")),
        "enabled": False,
        "env": {},
    }
    salvar(caminho, [*itens, novo])
    return novo


def ativar(slug: str, settings: Settings) -> bool:
    """Liga o servidor no arquivo. Quem sobe o processo é o `preparar()` da rota."""
    caminho = caminho_config(settings)
    itens = brutos(caminho)
    achou = False
    for atual in itens:
        if str(atual.get("name")) == slug:
            atual["enabled"] = True
            achou = True
    if achou:
        salvar(caminho, itens)
    return achou


def guardar_credencial(slug: str, env: dict[str, str], settings: Settings) -> bool:
    """Escreve a credencial no `env` do servidor — e só nele."""
    caminho = caminho_config(settings)
    itens = brutos(caminho)
    achou = False
    for atual in itens:
        if str(atual.get("name")) == slug:
            atual["env"] = {**dict(atual.get("env") or {}), **env}
            achou = True
    if achou:
        salvar(caminho, itens)
    return achou


# ------------------------------------------------------------------ entrar


def _ler_credencial(regra: dict[str, Any], settings: Settings) -> tuple[str, str] | None:
    """Aplica a regra do catálogo e devolve `(variável, valor)`, ou `None`.

    Duas formas, e só duas, porque são as duas que os CLIs de provedor usam: o token fica
    num **arquivo** que o login escreveu (Supabase), ou um **comando** o imprime (`gh auth
    token`). Qualquer outro formato é `None` — e aí a tela diz que não achou a credencial,
    em vez de inventar uma.
    """
    variavel = str(regra.get("env", "")).strip()
    if not variavel:
        return None
    valor = ""
    arquivo = regra.get("arquivo")
    comando = regra.get("comando")
    try:
        if isinstance(arquivo, str) and arquivo.strip():
            caminho = Path(arquivo.strip()).expanduser()
            if caminho.is_file():
                valor = caminho.read_text(encoding="utf-8", errors="replace").strip()
        elif isinstance(comando, str) and comando.strip():
            concluido = subprocess.run(
                _argv(comando.strip(), settings),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                shell=False,
                **_sem_janela(),
            )
            if concluido.returncode == 0:
                valor = concluido.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    # Primeira linha: CLI que imprime banner junto do token entregaria o banner inteiro.
    valor = valor.splitlines()[0].strip() if valor else ""
    return (variavel, valor) if valor else None


def _acompanhar(slug: str, item: dict[str, Any], settings: Settings) -> None:
    """Roda o login do provedor e acompanha a saída — numa thread, fora do laço de eventos."""
    comando = str(item.get("login", "")).strip()
    estado = _LOGINS[slug]
    try:
        processo = subprocess.Popen(
            _argv(comando, settings),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
            **_sem_janela(),
        )
    except (OSError, ValueError) as exc:
        with _trava:
            estado.update(status="erro", motivo=f"não foi possível rodar o login: {exc}")
        return

    linhas: list[str] = []
    inicio = time.monotonic()
    try:
        # `readline` trava até ter linha, então o laço só gira quando o CLI escreve. O teto é
        # o relógio daqui: um login que a pessoa abandonou não fica pendurado para sempre.
        while True:
            if processo.stdout is None:
                break
            linha = processo.stdout.readline()
            if linha == "" and processo.poll() is not None:
                break
            if linha:
                linhas.append(linha.rstrip())
                url = URL_NA_LINHA.search(linha)
                codigo = _codigo_na_linha(linha)
                abrir = ""
                with _trava:
                    if url and not estado.get("url"):
                        estado["url"] = url.group(0).rstrip(".,;")
                        abrir = estado["url"]
                    if codigo and not estado.get("codigo"):
                        estado["codigo"] = codigo
                    estado["saida"] = linhas[-12:]
                # Abrir o navegador **fora** da trava: é chamada de sistema, e segurar o
                # cadeado enquanto ela roda travaria a sondagem da tela.
                if abrir:
                    _abrir_no_navegador(abrir)
            if time.monotonic() - inicio > TETO_LOGIN_S:
                processo.kill()
                with _trava:
                    estado.update(status="erro", motivo="o login demorou demais e foi encerrado")
                return
        processo.wait(timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        with _trava:
            estado.update(status="erro", motivo=f"o login caiu: {exc}")
        return

    if processo.returncode != 0:
        with _trava:
            estado.update(
                status="erro",
                motivo=(linhas[-1] if linhas else f"o login saiu com {processo.returncode}"),
            )
        return

    regra = item.get("credencial")
    if isinstance(regra, dict) and regra:
        achado = _ler_credencial(regra, settings)
        if achado is None:
            with _trava:
                estado.update(
                    status="erro",
                    motivo="o login terminou, mas a credencial não foi encontrada",
                )
            return
        guardar_credencial(slug, {achado[0]: achado[1]}, settings)
    else:
        # Provedor que autentica por conta própria (sem regra de credencial): o login deu
        # certo e é isso que há para registrar. Sem o marcador a tela não sairia do «Entrar».
        guardar_credencial(slug, {MARCADOR_LOGIN: "ok"}, settings)
    with _trava:
        estado.update(status="pronto")


def iniciar_login(slug: str, item: dict[str, Any], settings: Settings) -> dict:
    """Começa o login do provedor. Devolve o estado, com a URL quando ela aparecer."""
    if not str(item.get("login", "")).strip():
        return {"status": "erro", "motivo": "este conector não publica um comando de login"}
    with _trava:
        atual = _LOGINS.get(slug)
        if atual and atual.get("status") == "rodando":
            return dict(atual)
        _LOGINS[slug] = {
            "status": "rodando",
            "url": None,
            "codigo": None,
            "saida": [],
            "motivo": None,
        }

    threading.Thread(
        target=_acompanhar,
        args=(slug, item, settings),
        name=f"login-mcp-{slug}",
        daemon=True,
    ).start()
    # Uma volta curta: o CLI quase sempre imprime a URL nos primeiros instantes, e devolver
    # já com ela poupa a tela de uma sondagem.
    time.sleep(1.5)
    with _trava:
        return dict(_LOGINS[slug])


def estado_login(slug: str) -> dict:
    with _trava:
        return dict(
            _LOGINS.get(slug)
            or {"status": "nenhum", "url": None, "codigo": None, "saida": [], "motivo": None}
        )
