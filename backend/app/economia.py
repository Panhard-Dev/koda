"""Economia de tokens — os cinco modos que a área Economia liga.

O pedido tem duas metades. A primeira é **gastar menos**: RTK, Headroom e Context Mode
encurtam o que vai ao modelo sem tirar o que a pessoa vê na tela. A segunda é **produzir
menos**: Caveman encurta a resposta, Ponytail encurta a mudança de código. As duas metades
moram aqui porque a decisão é uma só — o estado ligado/desligado de cada modo — e quem lê
esse estado é o mesmo lugar: o prompt de sistema e o histórico do agente.

**Ligado vale para tudo.** A compressão acontece no Koda, antes de o pedido sair, e as
instruções entram no prompt de sistema que todo motor recebe. Não há caminho por provedor:
OpenAI oficial, Anthropic, gateway da casa, Accio — todos passam por `agent/loop.py` ou
pelo prompt de sistema em `providers/base.py`.

**Desligado é o comportamento de sempre.** Nada é comprimido, nada é guardado, e o prompt
não ganha instrução nenhuma. O arquivo de estado só existe depois do primeiro clique.

O que cada modo faz, e onde:

- **RTK** (`rtk`): a saída de comando (shell, git, testes) é resumida **no momento em que
  entra no histórico**. A tela continua com a saída inteira; o modelo recebe cabeça, cauda
  e as linhas de erro. O original fica guardado e é recuperável por `consultar_saida`.
- **Headroom** (`headroom`): o contexto antigo encolhe a cada passo. As saídas de
  ferramenta mais velhas viram um resumo curto com o id do original — é o que impede o
  histórico de crescer até estourar, sem perder a possibilidade de consultar.
- **Context Mode** (`contexto`): saídas enormes (acima de 80% do limite de saída das
  ferramentas) não entram inteiras nem na primeira vez: viram um digest com cabeça, cauda
  e o id para pesquisar. É o modo para logs e resultados grandes.
- **Caveman** (`caveman`): instrução de resposta curta no prompt, em três níveis — Lite
  corta o enchimento, Full vira telegráfico e Ultra comprime ao máximo.
- **Ponytail** (`ponytail`): instrução de mudança de código enxuta no prompt, em três
  níveis — Lite sugere a alternativa, Full aplica a escada do menor esforço e Ultra é
  YAGNI extremo.

A regra de ouro: compressão **nunca** é destrutiva. Todo texto encurtado guarda o original
em disco e diz ao modelo o id para recuperá-lo. Um resumo que esconde um detalhe e não dá
como voltar seria pior do que não economizar.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

from .config import Settings, get_settings
from .limits import LIMITES

#: Nome do arquivo de estado, ao lado do banco — o mesmo lugar dos outros ajustes locais
#: (`mcps.json`, `skills-state.json`). Não vai para o banco: é preferência de máquina, não
#: conteúdo de conversa, e assim sobrevive a uma troca de banco sem migração.
ARQUIVO = "economia.json"

#: Pasta dos originais. Fica ao lado do banco, e não no workspace: o projeto da pessoa não
#: é lugar de lixo do Koda. Quem lê é a ferramenta `consultar_saida`, que conhece esta
#: pasta — o `read_file` do agente continua confinado ao projeto.
PASTA = "economia"

#: A ferramenta que devolve o original. O nome é curto porque entra no catálogo de toda
#: rodada com compressão ligada.
FERRAMENTA = "consultar_saida"

#: Marca da instrução no prompt. Serve para não duplicar quando o mesmo texto passa por
#: dois caminhos (o laço do agente e o prompt do provedor).
MARCA = "[economia de tokens]"

#: Os níveis dos dois modos que mudam o **estilo** do modelo. São os mesmos nomes do
#: 9router: `lite` corta o excesso, `full` é o equilíbrio e `ultra` é a compressão máxima.
#: RTK, Headroom e Context Mode não têm nível: o ajuste deles é o limite de compressão, e
#: um nível a mais só criaria duas formas de dizer a mesma coisa.
NIVEIS_CAVEMAN: tuple[dict[str, str], ...] = (
    {
        "id": "lite",
        "nome": "Lite",
        "descricao": "Corta enchimento e hesitação; mantém frases completas.",
    },
    {
        "id": "full",
        "nome": "Full",
        "descricao": "Estilo telegráfico; corta artigos e fluff, mantém a substância.",
    },
    {
        "id": "ultra",
        "nome": "Ultra",
        "descricao": "Compressão máxima; telegráfico, uma palavra quando basta.",
    },
)

NIVEIS_PONYTAIL: tuple[dict[str, str], ...] = (
    {
        "id": "lite",
        "nome": "Lite",
        "descricao": "Faz o pedido e sugere a alternativa mais preguiçosa em uma linha.",
    },
    {
        "id": "full",
        "nome": "Full",
        "descricao": "Escada do menor esforço: stdlib e nativo primeiro, menor diff.",
    },
    {
        "id": "ultra",
        "nome": "Ultra",
        "descricao": "YAGNI extremo: deletar antes de adicionar e desafiar o resto do pedido.",
    },
)

#: Os cinco modos, na ordem em que a tela os mostra. O `padrao` é o que vale sem arquivo:
#: Context Mode e Ponytail começam ligados — um encurta saída grande (com o original sempre
#: recuperável) e o outro evita mudança desnecessária, então ligar por padrão não pode
#: quebrar uma tarefa em silêncio.
MODOS: tuple[dict[str, Any], ...] = (
    {
        "id": "rtk",
        "nome": "RTK",
        "descricao": (
            "Comprime a saída de comandos — testes, git e shell — antes de ela entrar no "
            "contexto. A tela continua mostrando tudo; o modelo recebe o resumo e pode "
            "consultar o original."
        ),
        "padrao": False,
    },
    {
        "id": "headroom",
        "nome": "Headroom",
        "descricao": (
            "Enxuga o contexto antigo a cada passo e guarda as saídas grandes. O original "
            "fica disponível para o modelo consultar quando precisar do detalhe."
        ),
        "padrao": False,
    },
    {
        "id": "contexto",
        "nome": "Context Mode",
        "descricao": (
            "Saídas enormes viram um resumo com busca: o modelo pesquisa o conteúdo sem "
            "carregar tudo de uma vez. Bom para logs e resultados grandes."
        ),
        "padrao": True,
    },
    {
        "id": "caveman",
        "nome": "Caveman",
        "descricao": (
            "Respostas mais curtas e diretas. Economiza principalmente nos tokens de saída; "
            "pode cortar explicações úteis."
        ),
        "padrao": False,
        "niveis": NIVEIS_CAVEMAN,
    },
    {
        "id": "ponytail",
        "nome": "Ponytail",
        "descricao": (
            "Mudanças de código mais enxutas: o agente evita trabalho e arquivos "
            "desnecessários. Simplificar demais também pode prejudicar."
        ),
        "padrao": True,
        "niveis": NIVEIS_PONYTAIL,
    },
)

#: Estado sem arquivo nenhum.
PADRAO: dict[str, Any] = {item["id"]: bool(item["padrao"]) for item in MODOS}

#: O nível que vale sem arquivo. `full` é o que o Koda já fazia antes dos níveis: não
#: muda o comportamento de quem nunca abriu a tela.
PADRAO_NIVEIS: dict[str, str] = {"caveman": "full", "ponytail": "full"}

#: Os níveis que cada modo aceita. Modo sem nível fica com uma tupla vazia.
NIVEIS_POR_MODO: dict[str, tuple[dict[str, str], ...]] = {
    item["id"]: tuple(item.get("niveis", ())) for item in MODOS
}
NIVEIS_IDS: dict[str, frozenset[str]] = {
    modo: frozenset(nivel["id"] for nivel in niveis)
    for modo, niveis in NIVEIS_POR_MODO.items()
    if niveis
}

#: Ids válidos — o que a rota aceita. Um id fora daqui é recusado, e não inventado.
IDS = frozenset(PADRAO)

_LOCK = threading.Lock()


# ---------------------------------------------------------------- estado


def caminho(settings: Settings | None = None) -> Path:
    """O arquivo de estado desta instalação."""
    base = (settings or get_settings()).database_path.parent
    return base / ARQUIVO


def _normalizar(bruto: Any) -> dict[str, Any]:
    """Só chaves conhecidas, só booleanos e níveis válidos. Arquivo corrompido não derruba."""
    estado: dict[str, Any] = dict(PADRAO)
    if isinstance(bruto, dict):
        for chave in IDS:
            valor = bruto.get(chave)
            if isinstance(valor, bool):
                estado[chave] = valor

    niveis = dict(PADRAO_NIVEIS)
    if isinstance(bruto, dict):
        guardados = bruto.get("niveis")
        if isinstance(guardados, dict):
            for modo, nivel in guardados.items():
                if (
                    modo in NIVEIS_IDS
                    and isinstance(nivel, str)
                    and nivel in NIVEIS_IDS[modo]
                ):
                    niveis[modo] = nivel
        # Estado antigo/plano (`caveman_nivel`) continua valendo: a pessoa não perde a
        # escolha só porque o formato do arquivo mudou.
        for modo in NIVEIS_IDS:
            nivel = bruto.get(f"{modo}_nivel")
            if isinstance(nivel, str) and nivel in NIVEIS_IDS[modo]:
                niveis[modo] = nivel
    estado["niveis"] = niveis
    return estado


def ler(settings: Settings | None = None) -> dict[str, Any]:
    """O estado atual, já com os padrões preenchidos.

    Nada aqui pode lançar: a área Economia é uma preferência, e um JSON truncado por uma
    queda no meio da gravação não pode impedir o agente de responder. Na dúvida, o padrão.
    """
    try:
        bruto = json.loads(caminho(settings).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _normalizar(None)
    return _normalizar(bruto)


def salvar(settings: Settings | None, estado: dict[str, Any]) -> dict[str, Any]:
    """Grava o estado inteiro de forma atômica. Devolve o que ficou gravado."""
    limpo = _normalizar(estado)
    destino = caminho(settings)
    with _LOCK:
        destino.parent.mkdir(parents=True, exist_ok=True)
        temporario = destino.with_name(f".{destino.name}.{os.getpid()}.tmp")
        temporario.write_text(
            json.dumps(limpo, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporario, destino)
    return limpo


def alterar(
    settings: Settings | None,
    identificador: str,
    ligado: bool,
    nivel: str | None = None,
) -> dict[str, Any]:
    """Liga/desliga **um** modo, troca o nível se vier, e devolve o estado inteiro.

    A rota recebe um modo por clique, e não o objeto todo: assim dois cliques rápidos em
    modos diferentes não se sobrescrevem com um retrato velho da tela. O nível é opcional
    para os modos que não têm níveis; quando vem, é validado contra a lista do modo.
    """
    if identificador not in IDS:
        raise KeyError(identificador)
    estado = ler(settings)
    estado[identificador] = bool(ligado)
    if nivel is not None:
        if identificador not in NIVEIS_IDS:
            raise ValueError(f"modo sem níveis: {identificador}")
        if nivel not in NIVEIS_IDS[identificador]:
            raise ValueError(f"nível desconhecido para {identificador}: {nivel}")
        estado["niveis"][identificador] = nivel
    return salvar(settings, estado)


def para_api(settings: Settings | None = None) -> dict[str, Any]:
    """O formato da tela: a lista na ordem dos cartões, com o estado de cada um."""
    estado = ler(settings)
    return {
        "modos": [
            {
                "id": item["id"],
                "nome": item["nome"],
                "descricao": item["descricao"],
                "ligado": estado[item["id"]],
                "nivel": estado["niveis"].get(item["id"]),
                "niveis": list(item.get("niveis", ())),
            }
            for item in MODOS
        ]
    }


def algum_modo_de_compressao(estado: dict[str, Any]) -> bool:
    """Algum dos três modos que mexem no que vai ao modelo está ligado?"""
    return bool(estado.get("rtk") or estado.get("headroom") or estado.get("contexto"))


# ---------------------------------------------------------------- prompt


#: Prompts do Caveman, copiados do 9router — o mesmo texto que ele injeta no sistema. O
#: nível muda só a primeira parte; as regras compartilhadas são as mesmas, e é isso que
#: impede o Ultra de virar uma resposta incompleta.
_CAVEMAN_BOUNDARIES = (
    "Code blocks, file paths, commands, errors, URLs: keep exact. Security warnings, "
    "irreversible action confirmations, multi-step ordered sequences: write normal. "
    "Resume terse style after."
)
_CAVEMAN_EXAMPLES = (
    'Not: "Sure! I\'d be happy to help you with that. The issue you\'re experiencing is '
    'likely caused by..." Yes: "Bug in auth middleware. Token expiry check use `<` not '
    '`<=`. Fix:"'
)
_CAVEMAN_AUTO_CLARITY = (
    "Auto-Clarity: drop caveman for security warnings, irreversible actions, multi-step "
    "sequences where fragment ambiguity risks misread, or when user repeats a question. "
    "Resume after the clear part."
)
_CAVEMAN_PERSISTENCE = (
    "ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if "
    "unsure."
)
_CAVEMAN_NO_INVENTED_ABBREV = (
    "No invented abbreviations. Standard well-known tech acronyms (DB, API, HTTP, URL, "
    "JSON, ID, OS, CPU) OK. Names of code symbols, function names, API names, error "
    "strings: keep verbatim."
)
_CAVEMAN_PRESERVE_LANGUAGE = (
    "Preserve the user's dominant language. User wrote Portuguese, reply Portuguese. "
    "User wrote English, reply English. Code identifiers, error strings, file paths, "
    "commands: keep in their original form regardless of language."
)
_CAVEMAN_NO_SELF_REFERENCE = (
    'No self-reference. Do not name or announce the style (no "caveman mode", no "me '
    'caveman think", no "compressed mode active"). Just respond.'
)
_CAVEMAN_NO_DECORATION = (
    'No decorative emoji. No narrating tool calls ("I will now search", "I used X to find '
    'Y"). No status phrases ("Sure!", "Of course!", "I\'d be happy to"). No causal arrow '
    'shorthand ("A -> B -> fails"). State the thing, the action, the reason. Then next '
    "step."
)

CAVEMAN_PROMPTS: dict[str, str] = {
    "lite": " ".join(
        [
            "Respond tersely. Keep grammar and full sentences but drop filler, hedging "
            "and pleasantries (just/really/basically/sure/of course/I'd be happy to).",
            "Pattern: state the thing, the action, the reason. Then next step.",
            _CAVEMAN_EXAMPLES,
            _CAVEMAN_BOUNDARIES,
            _CAVEMAN_AUTO_CLARITY,
            _CAVEMAN_PERSISTENCE,
            _CAVEMAN_NO_INVENTED_ABBREV,
            _CAVEMAN_PRESERVE_LANGUAGE,
            _CAVEMAN_NO_SELF_REFERENCE,
            _CAVEMAN_NO_DECORATION,
        ]
    ),
    "full": " ".join(
        [
            "Respond like terse caveman. All technical substance stay exact, only fluff "
            "die.",
            "Drop: articles (a/an/the), filler (just/really/basically/actually/simply), "
            "pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix "
            "not implement a solution for).",
            "Pattern: [thing] [action] [reason]. [next step].",
            _CAVEMAN_EXAMPLES,
            _CAVEMAN_BOUNDARIES,
            _CAVEMAN_AUTO_CLARITY,
            _CAVEMAN_PERSISTENCE,
            _CAVEMAN_NO_INVENTED_ABBREV,
            _CAVEMAN_PRESERVE_LANGUAGE,
            _CAVEMAN_NO_SELF_REFERENCE,
            _CAVEMAN_NO_DECORATION,
        ]
    ),
    "ultra": " ".join(
        [
            "Respond ultra-terse. Maximum compression. Telegraphic.",
            "Strip conjunctions. One word when one word enough.",
            "Pattern: [thing] [action] [reason]. [next step].",
            _CAVEMAN_EXAMPLES,
            _CAVEMAN_BOUNDARIES,
            _CAVEMAN_AUTO_CLARITY,
            _CAVEMAN_PERSISTENCE,
            _CAVEMAN_NO_INVENTED_ABBREV,
            _CAVEMAN_PRESERVE_LANGUAGE,
            _CAVEMAN_NO_SELF_REFERENCE,
            _CAVEMAN_NO_DECORATION,
        ]
    ),
}

#: Prompts do Ponytail, também copiados do 9router.
_PONYTAIL_PERSONA = (
    "You are a lazy senior developer. Lazy means efficient, not careless. The best code "
    "is the code never written."
)
_PONYTAIL_LADDER = (
    "Before writing code, stop at the first rung that holds: 1) Does this need to exist "
    "at all? (YAGNI) 2) Stdlib does it? Use it. 3) Native platform feature covers it? "
    "Use it (CSS over JS, DB constraint over app code). 4) Already-installed dependency "
    "solves it? Use it; never add a new one for what a few lines can do. 5) Can it be one "
    "line? One line. 6) Only then: the minimum code that works."
)
_PONYTAIL_RULES = (
    "No unrequested abstractions (no interface with one implementation, no factory for "
    "one product, no config for a value that never changes). No boilerplate or "
    'scaffolding "for later". Deletion over addition. Boring over clever. Fewest files '
    "possible; shortest working diff wins. Two stdlib options the same size: take the "
    "edge-case-correct one. Mark deliberate simplifications with a `ponytail:` comment "
    "naming the ceiling and upgrade path."
)
_PONYTAIL_OUTPUT = (
    "Code first. Then at most three short lines: what was skipped, when to add it. No "
    "essays or design notes. Pattern: `[code] → skipped: [X], add when [Y].`"
)
_PONYTAIL_NOT_LAZY = (
    "Never simplify away: input validation at trust boundaries, error handling that "
    "prevents data loss, security, accessibility, anything explicitly requested. "
    "Non-trivial logic leaves ONE runnable check behind (an assert-based self-check or "
    "one small test file; no frameworks). Trivial one-liners need no test."
)
_PONYTAIL_PERSISTENCE = (
    "ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure."
)

PONYTAIL_PROMPTS: dict[str, str] = {
    "lite": " ".join(
        [
            _PONYTAIL_PERSONA,
            "Lite: build what's asked, but name the lazier alternative in one line. User "
            "picks.",
            _PONYTAIL_LADDER,
            _PONYTAIL_RULES,
            _PONYTAIL_OUTPUT,
            _PONYTAIL_NOT_LAZY,
            _PONYTAIL_PERSISTENCE,
        ]
    ),
    "full": " ".join(
        [
            _PONYTAIL_PERSONA,
            "Full: the ladder enforced. Stdlib and native first. Shortest diff, shortest "
            "explanation.",
            _PONYTAIL_LADDER,
            _PONYTAIL_RULES,
            _PONYTAIL_OUTPUT,
            _PONYTAIL_NOT_LAZY,
            _PONYTAIL_PERSISTENCE,
        ]
    ),
    "ultra": " ".join(
        [
            _PONYTAIL_PERSONA,
            "Ultra: YAGNI extremist. Deletion before addition. Ship the one-liner and "
            "challenge the rest of the requirement in the same response.",
            _PONYTAIL_LADDER,
            _PONYTAIL_RULES,
            _PONYTAIL_OUTPUT,
            _PONYTAIL_NOT_LAZY,
            _PONYTAIL_PERSISTENCE,
        ]
    ),
}

RECUPERAR = (
    "Saídas de ferramenta podem chegar resumidas para economizar contexto. Quando faltar "
    f"um detalhe, consulte o original com `{FERRAMENTA}` (busca=… ou id=…) em vez de rodar "
    "o comando de novo ou reler o arquivo inteiro."
)


def instrucoes(estado: dict[str, Any]) -> str:
    """O bloco que entra no prompt de sistema. Vazio quando nada está ligado."""
    partes: list[str] = []
    niveis = estado.get("niveis") or {}
    if estado.get("caveman"):
        nivel = niveis.get("caveman", "full")
        partes.append(CAVEMAN_PROMPTS.get(nivel, CAVEMAN_PROMPTS["full"]))
    if estado.get("ponytail"):
        nivel = niveis.get("ponytail", "full")
        partes.append(PONYTAIL_PROMPTS.get(nivel, PONYTAIL_PROMPTS["full"]))
    if algum_modo_de_compressao(estado):
        partes.append(RECUPERAR)
    if not partes:
        return ""
    return MARCA + " " + " ".join(partes)


# ---------------------------------------------------------------- compressão


#: Os tetos acompanham `LIMITES.saida` — o teto de saída que uma ferramenta devolve ao
#: modelo —, e não um número fixo. É ele que decide o tamanho máximo que chega aqui: com o
#: padrão de 50 mil, Context Mode age perto do teto e RTK bem antes; num app configurado
#: com saída menor, os dois acompanham. A fração mantém a proporção em vez de criar um teto
#: que nunca dispara (o modo existiria na tela e não faria nada).
LIMITE_CONTEXTO_FRACAO = 0.80
LIMITE_HEADROOM_FRACAO = 0.60
LIMITE_RTK_FRACAO = 0.40


def limite_contexto() -> int:
    return max(2_500, int(LIMITES.saida * LIMITE_CONTEXTO_FRACAO))


def limite_headroom() -> int:
    return max(1_500, int(LIMITES.saida * LIMITE_HEADROOM_FRACAO))


def limite_rtk() -> int:
    return max(1_200, int(LIMITES.saida * LIMITE_RTK_FRACAO))
#: Quantas linhas do começo e do fim sobrevivem ao resumo do RTK.
RTK_CABECA = 80
RTK_CAUDA = 40
#: Quantas linhas de erro no meio sobrevivem — são a razão de a pessoa ter rodado o comando.
RTK_ERROS = 40

#: Ferramentas cuja saída é "saída de comando": testes, git, shell, lint.
COMANDOS = frozenset(
    {
        "shell",
        "terminal",
        "git_status",
        "git_diff",
        "git_log",
        "git_commit",
        "git_push",
        "git_pull",
        "install_package",
        "uninstall_package",
        "get_problems",
        "linter",
        "code_interpreter",
    }
)

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_ERRO = re.compile(
    r"(?i)(\berror\b|\berro\b|\bfailed\b|\bfalha\b|\bfailing\b|traceback|exception|"
    r"assert(ion)?|✗|\bfail\b|não encontrado|not found|permission denied)"
)


def _limpar(texto: str) -> str:
    """Tira o que só existe para terminal: cor, cursor e barra de progresso."""
    texto = _ANSI.sub("", texto)
    # `\r` é a barra de progresso reescrevendo a mesma linha; o que vale é o último estado.
    return "\n".join(linha.rsplit("\r", 1)[-1] for linha in texto.splitlines())


def _colapsar(linhas: list[str]) -> list[str]:
    """Linhas idênticas em sequência viram uma linha com a contagem."""
    saida: list[str] = []
    for linha in linhas:
        if saida and linha == saida[-1]:
            saida[-1] = f"{linha} (×2)"
            continue
        if saida and linha and saida[-1].startswith(linha + " (×"):
            try:
                vezes = int(saida[-1].rsplit("(×", 1)[1].rstrip(")")) + 1
                saida[-1] = f"{linha} (×{vezes})"
                continue
            except ValueError:
                pass
        saida.append(linha)
    return saida


def _resumo_de_comando(texto: str) -> str:
    """Cabeça, cauda e erros do meio — o que se lê de um log de teste."""
    linhas = _colapsar(_limpar(texto).splitlines())
    total = len(linhas)
    if total <= RTK_CABECA + RTK_CAUDA + RTK_ERROS:
        return "\n".join(linhas)
    inicio = linhas[:RTK_CABECA]
    fim = linhas[-RTK_CAUDA:]
    meio = linhas[RTK_CABECA:-RTK_CAUDA]
    erros = [linha for linha in meio if _ERRO.search(linha)][:RTK_ERROS]
    partes = list(inicio)
    if erros:
        partes.append(f"…[{len(meio)} linhas no meio; as de erro:]")
        partes.extend(erros)
    else:
        partes.append(f"…[{len(meio)} linhas no meio omitidas]")
    partes.extend(fim)
    return "\n".join(partes)


def _digest(texto: str, identificador: str, *, motivo: str, limite: int) -> str:
    """O texto curto que substitui uma saída grande, com o caminho de volta."""
    linhas = _limpar(texto).splitlines()
    total = len(linhas)
    cabeca = "\n".join(linhas[:limite])
    cauda = "\n".join(linhas[-min(20, total) :])
    return (
        f"[{motivo}] Saída de {total} linhas / {len(texto)} caracteres resumida para "
        f"economizar contexto. Original guardado como id={identificador}; use "
        f"`{FERRAMENTA}` com busca=… ou id={identificador} para consultar.\n"
        f"--- começo ---\n{cabeca}\n--- fim ---\n{cauda}"
    )


def guardar(texto: str, settings: Settings | None, *, ferramenta: str = "") -> str:
    """Grava o original e devolve o id curto e estável (hash do conteúdo).

    Estável de propósito: o mesmo texto guardado duas vezes (RTK e depois Headroom, por
    exemplo) reaproveita o mesmo arquivo em vez de encher a pasta de cópias.
    """
    identificador = hashlib.sha1(texto.encode("utf-8", "replace")).hexdigest()[:12]
    destino = (settings or get_settings()).database_path.parent / PASTA / f"{identificador}.txt"
    if destino.exists():
        return identificador
    destino.parent.mkdir(parents=True, exist_ok=True)
    cabecalho = (
        f"# saída guardada pelo Koda · {ferramenta or 'ferramenta'} · "
        f"{time.strftime('%Y-%m-%d %H:%M:%S')}\n"
    )
    temporario = destino.with_name(f".{destino.name}.{os.getpid()}.tmp")
    temporario.write_text(cabecalho + texto, encoding="utf-8")
    os.replace(temporario, destino)
    return identificador


def comprimir_saida(
    texto: str,
    ferramenta: str,
    estado: dict[str, Any],
    settings: Settings | None = None,
) -> str:
    """O que vai ao **modelo** no lugar da saída crua. A tela continua com a original.

    A ordem importa: Context Mode é o mais agressivo e só age em saída enorme; RTK vem
    depois e só em comando; o resto passa intacto. `headroom` não entra aqui — ele age no
    histórico, não na saída recém-chegada, senão esconderia o resultado que o modelo acabou
    de pedir.
    """
    if not texto or not algum_modo_de_compressao(estado):
        return texto
    if estado.get("contexto") and len(texto) > limite_contexto():
        identificador = guardar(texto, settings, ferramenta=ferramenta)
        return _digest(texto, identificador, motivo="Context Mode", limite=60)
    if estado.get("rtk") and ferramenta in COMANDOS and len(texto) > limite_rtk():
        identificador = guardar(texto, settings, ferramenta=ferramenta)
        resumo = _resumo_de_comando(texto)
        return (
            f"[RTK] Saída de {len(texto)} caracteres resumida para economizar contexto. "
            f"Original: id={identificador}; use `{FERRAMENTA}` com busca=… ou id=… para "
            f"consultar.\n{resumo}"
        )
    return texto


def enxugar_historico(
    historico: list[dict[str, Any]],
    estado: dict[str, Any],
    settings: Settings | None = None,
    *,
    proteger: int = 3,
) -> int:
    """Headroom: encolhe as saídas de ferramenta **antigas** do histórico, no lugar.

    Devolve quantas mensagens encolheu. As últimas `proteger` mensagens ficam intactas: são
    o que o modelo acabou de produzir e receber, e é delas que sai o próximo passo.

    Só o `content` é tocado — `tool_call_id` e a estrutura ficam como estão, que é o que o
    provedor exige para casar chamada e resultado. Mensagem com imagem (lista de partes)
    fica intacta: trocar o texto por um resumo apagaria a imagem do meio da tarefa.
    """
    if not estado.get("headroom") or len(historico) <= proteger + 1:
        return 0
    encolhidas = 0
    for mensagem in historico[1:-proteger]:
        if mensagem.get("role") != "tool":
            continue
        conteudo = mensagem.get("content")
        if not isinstance(conteudo, str) or len(conteudo) <= limite_headroom():
            continue
        if conteudo.startswith("[Headroom]"):
            continue
        identificador = guardar(conteudo, settings, ferramenta="resultado antigo")
        mensagem["content"] = (
            f"[Headroom] Saída antiga de {len(conteudo)} caracteres guardada como "
            f"id={identificador}; use `{FERRAMENTA}` com busca=… ou id=… para consultar."
        )
        encolhidas += 1
    return encolhidas


# ---------------------------------------------------------------- consulta


def _arquivo(identificador: str, settings: Settings | None) -> Path | None:
    """Resolve um id para o arquivo guardado. Id fora do formato não vira caminho."""
    if not re.fullmatch(r"[0-9a-f]{12}", identificador or ""):
        return None
    base = (settings or get_settings()).database_path.parent / PASTA
    destino = base / f"{identificador}.txt"
    return destino if destino.is_file() else None


def _linhas(destino: Path) -> list[str]:
    try:
        return destino.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def consultar(
    settings: Settings | None = None,
    *,
    identificador: str = "",
    busca: str = "",
    inicio: int = 1,
    limite: int = 200,
) -> str:
    """A ferramenta `consultar_saida`: lê um original ou procura em todos.

    Sem `id` e sem `busca`, lista o que está guardado — é o que faz o modelo descobrir o
    que existe quando o resumo não disse o id. A saída é limitada: uma consulta que
    devolve 50 mil caracteres desfaria a economia que a trouxe até aqui.
    """
    settings = settings or get_settings()
    base = settings.database_path.parent / PASTA
    busca = (busca or "").strip()

    if identificador:
        destino = _arquivo(identificador, settings)
        if destino is None:
            return f"ERRO: não há saída guardada com id={identificador!r}."
        linhas = _linhas(destino)
        total = len(linhas)
        comeco = max(1, int(inicio or 1))
        quantas = max(1, min(int(limite or 200), 2_000))
        fatia = linhas[comeco - 1 : comeco - 1 + quantas]
        if not fatia:
            return f"ERRO: a saída {identificador} tem {total} linha(s); inicio={comeco} passa do fim."
        fim = comeco + len(fatia) - 1
        corpo = "\n".join(fatia)
        aviso = (
            f"\n...[linhas {fim + 1}-{total} não lidas; peça com inicio={fim + 1}]"
            if fim < total
            else ""
        )
        return f"(saída {identificador}: linhas {comeco}-{fim} de {total})\n{corpo}{aviso}"

    if not base.is_dir():
        return "Não há saídas guardadas nesta execução."

    arquivos = sorted(
        (item for item in base.glob("*.txt") if item.is_file()),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    if busca:
        achados: list[str] = []
        for destino in arquivos[:100]:
            for numero, linha in enumerate(_linhas(destino), 1):
                if busca.lower() in linha.lower():
                    achados.append(f"{destino.stem}:{numero}: {linha[:400]}")
                    if len(achados) >= 40:
                        break
            if len(achados) >= 40:
                break
        if not achados:
            return f"Nenhuma linha com {busca!r} nas {min(len(arquivos), 100)} saídas guardadas."
        return (
            f"{len(achados)} ocorrência(s) de {busca!r} (até 40):\n"
            + "\n".join(achados)
            + "\nUse `consultar_saida` com id=… e inicio=… para ler o contexto em volta."
        )

    if not arquivos:
        return "Não há saídas guardadas nesta execução."
    linhas = ["Saídas guardadas (mais recentes primeiro):"]
    for destino in arquivos[:20]:
        try:
            tamanho = destino.stat().st_size
        except OSError:
            continue
        linhas.append(f"- id={destino.stem} · {tamanho} caracteres")
    return "\n".join(linhas)
