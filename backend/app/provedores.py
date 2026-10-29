"""Os provedores que entram por login — e o estado vem **só** do login que o Koda fez.

Regra do dono (26/10/2026), depois de ver a tela marcando contas que ele não tinha conectado
ali: **nada de ler credencial do PC**. Nada de `~/.codex`, `~/.gemini`, `~/.qoder`, chaveiro,
banco de IDE. Quem entra é ele, no site do provedor, e o que fica guardado é o token que o
próprio Koda recebeu de volta — em `data/provedores/<id>.json` (0600).

O catálogo de modelos por provedor está em `provedores_catalogo.json` (extraído do 9router,
que é a referência de lista por provedor); o fluxo de login está em `oauth_login.py`.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from . import oauth_login
from .config import Settings

#: Os provedores, um por **fornecedor** — sem repetir marca. Antes havia dois Google (Gemini
#: CLI e Antigravity) e dois da OpenAI (Codex e ChatGPT); para quem olha a lista, era o mesmo
#: nome duas vezes, e ele reclamou com razão.
_manifesto = json.loads(Path(__file__).with_name("provedores_9router.json").read_text(encoding="utf-8"))
PROVEDORES: list[dict[str, Any]] = _manifesto["provedores"]

POR_ID = {item["id"]: item for item in PROVEDORES}

#: O que cada provedor **conversa** e **pensa**, conferido um por um na documentação.
#:
#: `chat` é o estado real do adaptador no Koda: `True` só onde já existe caminho de conversa
#: implementado e testado. O resto é o que falta, escrito com o nome do campo que o fornecedor
#: usa — para ninguém achar que «mapeado» quer dizer «funcionando».
#:
#: `pensamento` é o campo nativo de raciocínio: `None` quando o provedor não tem parâmetro de
#: esforço (o modelo pensa se quiser, e não há o que pedir).
CAPACIDADES: dict[str, dict[str, Any]] = {
    "anthropic": {
        "protocolo": "Anthropic Messages",
        "chat": True,
        "pensamento": "thinking.budget_tokens",
        "niveis": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        "nota": "orçamento em tokens; max_tokens tem de ser maior. Haiku 4.5+ recusa "
                "orçamento manual (pensamento adaptativo).",
    },
    "openai": {
        "protocolo": "OpenAI Responses",
        "chat": True,
        "pensamento": "reasoning.effort",
        "niveis": ["none", "minimal", "low", "medium", "high"],
        "nota": "a API só tem minimal/low/medium/high; xhigh e max caem em high.",
    },
    "google": {
        "protocolo": "Google Code Assist (Gemini)",
        "chat": False,
        "pensamento": "generationConfig.thinkingConfig.thinkingBudget",
        "niveis": ["none", "low", "medium", "high"],
        "nota": "o endpoint compatível com OpenAI usa reasoning_effort; o nativo usa "
                "thinkingBudget (0 desliga, -1 é dinâmico).",
    },
    "github": {
        "protocolo": "GitHub Copilot (OpenAI compatível)",
        "chat": True,
        "pensamento": None,
        "niveis": [],
        "nota": "o Copilot troca o token do GitHub por um token de sessão e fala "
                "chat/completions; não expõe parâmetro de raciocínio.",
    },
    "xai": {
        "protocolo": "xAI (OpenAI compatível)",
        "chat": True,
        "pensamento": "reasoning_effort",
        "niveis": ["low", "high"],
        "nota": "grok-3-mini/grok-4 aceitam reasoning_effort; o resto ignora.",
    },
    "cursor": {
        "protocolo": "Cursor agent API",
        "chat": False,
        "pensamento": None,
        "niveis": [],
        "nota": "API própria de agente; não há parâmetro de esforço exposto.",
    },
    "devin": {
        "protocolo": "Devin API",
        "chat": False,
        "pensamento": None,
        "niveis": [],
        "nota": "API de sessão de agente; sem parâmetro de raciocínio.",
    },
    "qoder": {
        "protocolo": "Qoder (device + envelope COSY)",
        "chat": True,
        "pensamento": "reasoning_effort",
        "niveis": ["low", "medium", "high"],
        "nota": "o gateway aceita o campo nos modelos que raciocinam; nos outros é ignorado.",
    },
    "kiro": {
        "protocolo": "AWS CodeWhisperer",
        "chat": False,
        "pensamento": None,
        "niveis": [],
        "nota": "protocolo da AWS; sem parâmetro de esforço.",
    },
    "factory": {
        "protocolo": "Factory/Droid (OpenAI compatível)",
        "chat": False,
        "pensamento": "reasoning_effort",
        "niveis": ["low", "medium", "high"],
        "nota": "BYOK OpenAI compatível; o campo vale para os modelos de raciocínio.",
    },
    "zcode": {
        "protocolo": "ZCode (Anthropic compatível)",
        "chat": False,
        "pensamento": "thinking.budget_tokens",
        "niveis": ["none", "low", "medium", "high"],
        "nota": "fala o protocolo da Anthropic, então herda o orçamento de pensamento.",
    },
    "xiaomi": {
        "protocolo": "Xiaomi MiMo (OpenAI compatível)",
        "chat": False,
        "pensamento": "reasoning_effort",
        "niveis": ["low", "medium", "high"],
        "nota": "token plan compatível com OpenAI.",
    },
}


def _carregar_catalogo() -> dict[str, list[dict[str, str]]]:
    """Modelos do mesmo manifesto que define os provedores de login."""
    return {item["id"]: item["modelos"] for item in PROVEDORES}


CATALOGO = _carregar_catalogo()

#: Os modelos que cada conta logada publicou na última consulta (id → provedor).
#:
#: Serve para o chat saber **de quem** é o modelo escolhido sem uma chamada de rede por
#: mensagem: o catálogo da conta é atualizado quando a tela abre o provedor, e é esse retrato
#: que vale aqui. Vazio significa «não sei», e aí o pedido segue o caminho de sempre.
_CACHE: dict[str, str] = {}


def dono_do_modelo(modelo: str) -> str | None:
    """Qual conta logada publica este modelo — `None` quando é do host."""
    return _CACHE.get(modelo)


def _expirado(iso: str | None) -> bool | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso) <= datetime.now(tz=timezone.utc)
    except ValueError:
        return None


def _estado(provedor: dict[str, Any], settings: Settings | None) -> dict[str, Any]:
    """O que a tela mostra: o login **do Koda**, não o do PC.

    `garantir` renova o token quando ele venceu e há refresh — é o que mantém a conta viva
    sem pedir login de novo. Sem login guardado, o estado é «não conectado», e nada mais é
    consultado.
    """
    dado = oauth_login.garantir(settings, provedor["id"]) if settings is not None else None
    conectado = bool(dado and dado.get("access"))
    # A lista de contas vai junto: é ela que a tela mostra (uma linha por conta, com
    # «testar» e «sair»), e sem ela o empilhamento não teria onde aparecer.
    contas = [
        {
            "id": item["id"],
            "conta": item.get("conta"),
            "expiraEm": item.get("expiraEm"),
            "esgotadaAte": item.get("esgotadaAte"),
            "motivo": item.get("motivo"),
            "atual": bool(dado and item["id"] == dado.get("id")),
        }
        for item in (oauth_login.contas(settings, provedor["id"]) if settings is not None else [])
    ]
    return {
        "id": provedor["id"],
        "nome": provedor["nome"],
        "sigla": provedor["sigla"],
        "cli": provedor["cli"],
        "conectado": conectado,
        "conta": (dado or {}).get("conta"),
        "plano": (dado or {}).get("plano"),
        "planoAte": (dado or {}).get("planoAte"),
        "expiraEm": (dado or {}).get("expiraEm"),
        "expirado": _expirado((dado or {}).get("expiraEm")),
        "renova": bool((dado or {}).get("refresh")),
        "detalhe": "login feito no Koda" if conectado else "entre para conectar",
        "contas": contas,
        # O que este provedor sabe fazer hoje — a tela usa para não prometer conversa onde
        # ainda não há adaptador.
        "capacidades": CAPACIDADES.get(provedor["id"], {}),
    }


def listar(settings: Settings | None = None) -> list[dict[str, Any]]:
    return [_estado(provedor, settings) for provedor in PROVEDORES]


def testar(identificador: str, settings: Settings | None = None) -> dict[str, Any]:
    """Confere o login guardado: existe, tem token e ele vale (ou renova sozinho).

    Não lê arquivo de CLI e não fala com o fornecedor: quem valida token de verdade é ele, na
    primeira chamada. O que se pode afirmar aqui é o que o nosso próprio arquivo diz.
    """
    provedor = POR_ID.get(identificador)
    if provedor is None:
        return {"ok": False, "detalhe": "provedor desconhecido"}
    estado = _estado(provedor, settings)
    if not estado["conectado"]:
        return {"ok": False, "estado": estado, "detalhe": "não há login do Koda para este provedor"}
    if estado["expirado"] and not estado["renova"]:
        return {"ok": False, "estado": estado,
                "detalhe": "o token venceu e não há refresh — entre de novo"}
    if estado["expirado"]:
        return {"ok": True, "estado": estado,
                "detalhe": "login válido: o token de acesso venceu, mas há refresh token"}
    return {"ok": True, "estado": estado, "detalhe": "login válido"}


MAGPIE_URL = "http://127.0.0.1:3425/v1"

#: Onde o binário do gateway costuma estar nesta máquina. O primeiro que existir é usado.
MAGPIE_CAMINHOS = (
    Path.home() / "Desktop" / "magpie-windows-amd64.exe",
    Path.home() / "Downloads" / "magpie-windows-amd64.exe",
    Path.home() / "magpie-windows-amd64.exe",
)

#: Só tenta subir o gateway uma vez por processo; falhar não pode virar laço de spawn.
_tentou_subir = False


def _porta_aberta() -> bool:
    """A porta do gateway está escutando? (TCP puro, sem esperar resposta HTTP.)

    É a pergunta certa para decidir «preciso abrir?»: um gateway ocupado pode demorar mais que
    o timeout do HTTP e ainda assim estar no ar — tratá-lo como ausente fazia o Koda tentar
    abrir um segundo processo e desistir do pedido.
    """
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as conexao:
        conexao.settimeout(1.0)
        return conexao.connect_ex(("127.0.0.1", 3425)) == 0


def _gateway_responde() -> bool:
    try:
        with httpx.Client(timeout=10) as cliente:
            return cliente.get(f"{MAGPIE_URL}/models").status_code < 400
    except httpx.HTTPError:
        return False


def garantir_gateway() -> bool:
    """Sobe o gateway do Qoder se ele não estiver no ar. `True` quando ele responde.

    O pedido do Qoder vai assinado (envelope COSY) e quem assina é o gateway — por isso ele
    precisa estar rodando. Em vez de pedir que a pessoa abra o programa à mão, o Koda abre:
    é uma dependência interna, não uma tarefa para quem está conversando.
    """
    global _tentou_subir
    if _porta_aberta():
        # Já está de pé: pode estar só ocupado. Não abrir um segundo.
        return True
    if _tentou_subir:
        return _porta_aberta()
    _tentou_subir = True
    binario = next((caminho for caminho in MAGPIE_CAMINHOS if caminho.is_file()), None)
    if binario is None:
        return False
    try:
        import subprocess

        subprocess.Popen(  # noqa: S603 — binário local, caminho fixo da própria máquina
            [str(binario)],
            cwd=str(binario.parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError:
        return False
    # A porta leva alguns segundos para abrir; espera em pedaços, sem segurar por muito tempo.
    for _ in range(20):
        if _gateway_responde():
            return True
        time.sleep(0.5)
    return False


def _modelos_do_magpie(prefixo: str | None = None) -> dict[str, Any] | None:
    """O catálogo do gateway do magpie, se ele estiver no ar (opcionalmente por prefixo)."""
    try:
        with httpx.Client(timeout=5) as cliente:
            resposta = cliente.get(f"{MAGPIE_URL}/models")
            if resposta.status_code >= 400:
                return None
            dados = resposta.json().get("data") or []
    except (httpx.HTTPError, ValueError):
        return None
    itens = [
        item
        for item in dados
        if isinstance(item, dict)
        and item.get("id")
        and (prefixo is None or str(item["id"]).startswith(f"{prefixo}/"))
    ]
    if not itens:
        return None
    modelos = [str(item["id"]) for item in itens]
    return {
        "modelos": modelos,
        "nomes": {
            str(item["id"]): str(item.get("display_name") or item.get("magpie_label") or item["id"])
            for item in itens
        },
        "esforcos": {modelo: ["none", "low", "medium", "high"] for modelo in modelos},
        "fonte": f"gateway do magpie ({MAGPIE_URL})",
        "motivo": "",
    }


def modelos(identificador: str, settings: Settings | None = None) -> dict[str, Any]:
    if identificador not in POR_ID:
        return {"modelos": [], "fonte": None, "motivo": "provedor desconhecido"}
    vivo = _ao_vivo(identificador, settings)
    if vivo is not None:
        for modelo in vivo["modelos"]:
            _CACHE[modelo] = identificador
        vivo["esforcos"] = _esforcos_por_modelo(identificador, vivo["modelos"])
        return vivo
    itens = CATALOGO.get(identificador) or []
    if not itens:
        return {"modelos": [], "nomes": {}, "fonte": None,
                "motivo": "este provedor não publica catálogo por aqui ainda"}
    modelos = [str(item.get("id")) for item in itens if item.get("id")]
    return {
        "modelos": modelos,
        "nomes": {str(item.get("id")): str(item.get("nome")) for item in itens if item.get("id")},
        "esforcos": _esforcos_por_modelo(identificador, modelos),
        "fonte": "catálogo do 9router",
        "motivo": "",
    }


#: User-Agent e versão que o backend do ChatGPT aceita. Sem eles, `/codex/models`
#: responde 404 «Model not found» para um modelo que ele mesmo lista — é o que o magpie
#: documenta em `codex_request.go`, e o motivo de não ser um GET comum.
CODEX_UA = "codex_cli_rs/0.162.0 (Windows 10; x86_64) vscode"


def _ao_vivo(identificador: str, settings: Settings | None) -> dict[str, Any] | None:
    """A lista de modelos **da conta**, pedida ao fornecedor. `None` quando não há como.

    Vale mais que o catálogo estático: é o que a conta realmente alcança, e é a mesma
    pergunta que o botão «Testar» faz. Onde não existe endpoint público, volta `None` e a
    tela cai no catálogo de referência.
    """
    dado = oauth_login.garantir(settings, identificador) if settings is not None else None
    if not dado or not dado.get("access"):
        return None
    token = str(dado["access"])

    if identificador == "zed":
        from . import engine_9router

        itens = engine_9router.modelos_ao_vivo(settings, identificador, dado)
        if itens is None:
            return None
        return {"modelos": [str(i["id"]) for i in itens if i.get("id")],
                "nomes": {str(i["id"]): str(i.get("name") or i["id"])
                          for i in itens if i.get("id")},
                "fonte": "catálogo da conta Zed", "motivo": ""}

    if identificador == "anthropic":
        try:
            with httpx.Client(timeout=15) as cliente:
                resposta = cliente.get(
                    "https://api.anthropic.com/v1/models?limit=100",
                    headers={
                        "authorization": f"Bearer {token}",
                        "anthropic-version": "2023-06-01",
                        "anthropic-beta": "oauth-2025-04-20",
                    },
                )
        except httpx.HTTPError:
            return None
        if resposta.status_code >= 400:
            return None
        itens = resposta.json().get("data") or []
        ids = [str(item.get("id")) for item in itens if item.get("id")]
        return {
            "modelos": ids,
            "nomes": {str(i.get("id")): str(i.get("display_name") or i.get("id"))
                      for i in itens if i.get("id")},
            "fonte": "API da Anthropic",
            "motivo": "",
        }

    if identificador == "openai":
        claims = oauth_login._claims(dado.get("id_token"))  # noqa: SLF001
        conta = ((claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id"))
        cabecalhos = {
            "authorization": f"Bearer {token}",
            "openai-beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "version": "0.162.0",
            "user-agent": CODEX_UA,
        }
        if conta:
            cabecalhos["chatgpt-account-id"] = str(conta)
        try:
            with httpx.Client(timeout=15) as cliente:
                # `client_version` é obrigatório na query: sem ele o backend responde 400
                # com «Field required» e o teste pareceria falha de login.
                resposta = cliente.get(
                    "https://chatgpt.com/backend-api/codex/models?client_version=0.162.0",
                    headers=cabecalhos,
                )
        except httpx.HTTPError:
            return None
        if resposta.status_code >= 400:
            return None
        itens = resposta.json().get("models") or []
        ids = [str(item.get("slug")) for item in itens if isinstance(item, dict) and item.get("slug")]
        return {
            "modelos": ids,
            "nomes": {str(i.get("slug")): str(i.get("display_name") or i.get("title") or i.get("slug"))
                      for i in itens if isinstance(i, dict) and i.get("slug")},
            "fonte": "API do ChatGPT",
            "motivo": "",
        }
    return None


def testar_modelo(identificador: str, modelo: str, settings: Settings | None = None) -> dict[str, Any]:
    """Manda uma mensagem de verdade para o modelo, com a conta em uso, e conta o que voltou.

    «Testar» que só olha uma lista não prova nada: o modelo pode estar na lista e a conta sem
    cota. Aqui o pedido é uma pergunta curta ao modelo — resposta, `ok`; cota estourada, o
    motivo e até quando; qualquer outra coisa, o erro do fornecedor, como ele escreveu.
    """
    if identificador not in POR_ID:
        return {"ok": False, "detalhe": "provedor desconhecido"}
    if settings is None:
        return {"ok": False, "detalhe": "o serviço local não está pronto"}

    lista = oauth_login.contas(settings, identificador)
    if not lista:
        return {"ok": False, "detalhe": "entre no provedor primeiro — o teste usa a conta"}

    # Rodízio: tenta a conta da frente; se ela estourou a cota, marca e passa para a próxima.
    tentativas: list[str] = []
    for conta in lista:
        if conta.get("esgotadaAte") and _ainda_esgotada(conta["esgotadaAte"]):
            tentativas.append(f"{conta.get('conta') or conta['id']}: sem cota até {conta['esgotadaAte'][:10]}")
            continue
        resultado = _chamar_modelo(identificador, conta, modelo, settings)
        if resultado.get("esgotadaAte"):
            oauth_login._marcar(  # noqa: SLF001 — mesmo pacote, e é o único que grava a marca
                settings, conta["id"],
                esgotada_ate=resultado["esgotadaAte"], motivo=resultado.get("detalhe"),
            )
            tentativas.append(f"{conta.get('conta') or conta['id']}: {resultado.get('detalhe')}")
            continue
        resultado["conta"] = conta.get("conta")
        resultado["tentativas"] = tentativas
        return resultado

    return {
        "ok": False,
        "detalhe": "todas as contas deste provedor estão sem cota agora",
        "tentativas": tentativas,
    }


def _ainda_esgotada(ate: str) -> bool:
    try:
        return datetime.fromisoformat(ate) > datetime.now(tz=timezone.utc)
    except ValueError:
        return False


def _chamar_modelo(
    identificador: str, conta: dict[str, Any], modelo: str, settings: Settings | None = None
) -> dict[str, Any]:
    """Uma mensagem curta ao modelo, com **uma** conta. Devolve ok, texto ou o motivo."""
    token = str(conta.get("access") or "")
    if not token:
        return {"ok": False, "detalhe": "conta sem token de acesso"}

    if identificador == "anthropic":
        try:
            with httpx.Client(timeout=45) as cliente:
                resposta = cliente.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "authorization": f"Bearer {token}",
                        "anthropic-version": "2023-06-01",
                        "anthropic-beta": "oauth-2025-04-20",
                        "content-type": "application/json",
                    },
                    json={
                        "model": modelo,
                        "max_tokens": 24,
                        "messages": [{"role": "user", "content": "responda apenas: ok"}],
                    },
                )
        except httpx.HTTPError as erro:
            return {"ok": False, "detalhe": f"não deu para falar com a Anthropic: {erro}"}
        if resposta.status_code == 429:
            return {"ok": False, "esgotadaAte": _quando_renova(resposta),
                    "detalhe": "limite de uso atingido"}
        if resposta.status_code >= 400:
            return {"ok": False, "detalhe": _motivo(resposta, "Anthropic")}
        texto = ""
        for bloco in resposta.json().get("content") or []:
            if bloco.get("type") == "text":
                texto += str(bloco.get("text") or "")
        return {"ok": True, "detalhe": texto.strip()[:120] or "respondeu"}

    if identificador == "openai":
        return _chamar_chatgpt(conta, modelo)

    if settings is None:
        return {"ok": False, "detalhe": "o serviço local não está pronto"}
    from . import engine_9router

    resposta = engine_9router.chamar(
        settings, identificador, conta, modelo,
        [{"role": "user", "content": "responda apenas: ok"}], max_tokens=24,
    )
    if not resposta["ok"]:
        return {"ok": False, "detalhe": resposta["detalhe"]}
    escolha = (resposta["dados"].get("choices") or [{}])[0]
    texto = (escolha.get("message") or {}).get("content") or ""
    return {"ok": True, "detalhe": str(texto).strip()[:120] or "respondeu"}


def _chamar_chatgpt(conta: dict[str, Any], modelo: str) -> dict[str, Any]:
    """Uma pergunta curta ao backend do ChatGPT, no formato que o Codex CLI usa."""
    claims = oauth_login._claims(conta.get("id_token"))  # noqa: SLF001
    conta_id = ((claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id"))
    cabecalhos = {
        "authorization": f"Bearer {conta.get('access')}",
        "openai-beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "version": "0.162.0",
        "user-agent": CODEX_UA,
        "accept": "text/event-stream",
        "content-type": "application/json",
    }
    if conta_id:
        cabecalhos["chatgpt-account-id"] = str(conta_id)

    corpo = {
        "model": modelo,
        "instructions": "Responda em uma palavra.",
        "input": [{"type": "message", "role": "user",
                   "content": [{"type": "input_text", "text": "responda apenas: ok"}]}],
        "stream": True,
        "store": False,
    }
    try:
        with httpx.Client(timeout=60) as cliente:
            with cliente.stream("POST", "https://chatgpt.com/backend-api/codex/responses",
                                headers=cabecalhos, json=corpo) as resposta:
                if resposta.status_code == 429:
                    resposta.read()
                    return {"ok": False, "esgotadaAte": _quando_renova(resposta),
                            "detalhe": "limite de uso atingido"}
                if resposta.status_code >= 400:
                    resposta.read()
                    return {"ok": False, "detalhe": _motivo(resposta, "ChatGPT")}
                texto = ""
                for linha in resposta.iter_lines():
                    if not linha.startswith("data:"):
                        continue
                    carga = linha[5:].strip()
                    if not carga or carga == "[DONE]":
                        continue
                    try:
                        evento = json.loads(carga)
                    except ValueError:
                        continue
                    tipo = evento.get("type")
                    if tipo == "response.output_text.delta":
                        texto += str(evento.get("delta") or "")
                    if tipo in ("response.completed", "response.failed"):
                        break
                    if len(texto) > 200:
                        break
    except httpx.HTTPError as erro:
        return {"ok": False, "detalhe": f"não deu para falar com o ChatGPT: {erro}"}
    return {"ok": True, "detalhe": texto.strip()[:120] or "respondeu"}


def _quando_renova(resposta: "httpx.Response") -> str:
    """Quando a cota volta, do próprio corpo do 429 — senão, uma hora à frente."""
    try:
        dados = resposta.json()
    except ValueError:
        dados = {}
    # O ChatGPT aninha o motivo em `error` (`{"error": {"resets_in_seconds": …}}`), e ler só
    # o nível de cima fazia a conta parecer sem cota por uma hora quando eram semanas.
    erro = dados.get("error") if isinstance(dados.get("error"), dict) else {}
    segundos = (
        dados.get("resets_in_seconds")
        or dados.get("resets_in")
        or erro.get("resets_in_seconds")
    )
    if not segundos and isinstance(erro.get("resets_at"), (int, float)):
        return datetime.fromtimestamp(float(erro["resets_at"]), tz=timezone.utc).isoformat()
    if isinstance(segundos, (int, float)) and segundos > 0:
        return datetime.fromtimestamp(
            time.time() + float(segundos), tz=timezone.utc
        ).isoformat()
    return datetime.fromtimestamp(time.time() + 3600, tz=timezone.utc).isoformat()


def _motivo(resposta: "httpx.Response", quem: str) -> str:
    if resposta.status_code in (401, 403):
        return f"{quem} recusou o token (HTTP {resposta.status_code}) — entre de novo"
    if resposta.status_code == 429:
        return f"{quem} está no limite agora (HTTP 429) — o login vale, tente mais tarde"
    return f"{quem} respondeu HTTP {resposta.status_code}: {resposta.text[:160]}"


def _achou_na_lista(ids: list[Any], modelo: str) -> dict[str, Any]:
    limpos = [str(item) for item in ids if item]
    if not limpos:
        return {"ok": False, "detalhe": "o fornecedor não devolveu lista de modelos"}
    if modelo in limpos:
        return {"ok": True, "detalhe": f"a conta alcança este modelo ({len(limpos)} na lista)"}
    return {"ok": False, "detalhe": f"a conta não lista este modelo ({len(limpos)} na lista)"}


def _esforcos_por_modelo(identificador: str, modelos: list[str]) -> dict[str, list[str]]:
    """Os níveis de pensamento que **cada** modelo aceita.

    Vem da tabela de capacidades (`providers/conta.aceita_pensar`), que segue a doc de cada
    fornecedor: a Responses API da OpenAI só tem `minimal/low/medium/high`; a Anthropic usa
    orçamento de tokens e aceita do raso ao fundo. Modelo que não raciocina fica com lista
    vazia — e a tela não oferece o que o fornecedor vai recusar.
    """
    from .providers.conta import aceita_pensar

    if identificador == "openai":
        niveis = ["none", "minimal", "low", "medium", "high"]
    elif identificador == "anthropic":
        niveis = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    else:
        niveis = []
    return {modelo: (list(niveis) if aceita_pensar(identificador, modelo) else []) for modelo in modelos}


def entrar(identificador: str, settings: Settings | None = None) -> dict[str, Any]:
    """Começa o login: OAuth no navegador quando existe, senão o login do CLI do fornecedor."""
    if identificador not in POR_ID:
        return {"ok": False, "mensagem": "provedor desconhecido"}
    if settings is None:
        return {"ok": False, "mensagem": "o serviço local não está pronto"}
    return oauth_login.iniciar(settings, identificador)


def sair(identificador: str, settings: Settings | None = None, conta_id: str | None = None) -> dict[str, Any]:
    """Sai da conta — de uma específica, ou de todas as do provedor."""
    if settings is not None:
        oauth_login.esquecer(settings, identificador, conta_id)
    return {"ok": True}


def testar_conta(
    identificador: str, conta_id: str, settings: Settings | None = None
) -> dict[str, Any]:
    """Testa **uma** conta: manda uma mensagem curta e devolve o que ela respondeu.

    Diferente do teste do modelo, este não roda o rodízio: é para saber como *aquela* conta
    está — respondeu, sem cota até quando, ou o erro que o fornecedor deu.
    """
    if settings is None:
        return {"ok": False, "detalhe": "o serviço local não está pronto"}
    conta = next(
        (item for item in oauth_login.contas(settings, identificador) if item["id"] == conta_id),
        None,
    )
    if conta is None:
        return {"ok": False, "detalhe": "conta não encontrada"}
    modelo = next(
        (str(item.get("id")) for item in (CATALOGO.get(identificador) or [])), ""
    )
    vivo = _ao_vivo(identificador, settings)
    if vivo and vivo["modelos"]:
        modelo = vivo["modelos"][0]
    if not modelo:
        return {"ok": False, "detalhe": "não há modelo conhecido para testar esta conta"}
    resultado = _chamar_modelo(identificador, conta, modelo, settings)
    if resultado.get("esgotadaAte"):
        oauth_login._marcar(  # noqa: SLF001
            settings, conta_id, esgotada_ate=resultado["esgotadaAte"],
            motivo=resultado.get("detalhe"),
        )
    else:
        oauth_login._marcar(settings, conta_id, esgotada_ate=None, motivo=None)
    resultado["conta"] = conta.get("conta")
    resultado["modelo"] = modelo
    return resultado
