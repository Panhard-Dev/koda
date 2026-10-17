"""Valida os blocos `koda-ui` que a IA gera, e rebaixa os que não rolam.

## O problema

A UI generativa (`koda-ui`) é um **interpretador de expressões** — aritmética,
comparação, ternário, template string, formatação e operações de lista. Ela **não**
executa JavaScript de verdade: função com bloco (`=> { ... }`), `function`, `for`,
`while`, `console.log`, `try/catch`, `.reduce` com laço. Quando a IA manda um `` `koda-ui`
com esse tipo de código (o "editor de código" foi o caso real), o front não consegue
montar — e a pessoa vê `` `{@body}` `` cru, `Desconhecido`, ou tela morta.

## A saída: rebaixar em código, não em prompt

O backend **processa a resposta antes de mandar** pro front. Aqui ele varre o texto,
acha cada bloco ```` ```koda-ui ````, e julga se o motor aguenta. Se **não** aguenta
(função com bloco, laço, console.log, array grande com template string dentro), o bloco
é **rebaixado**: a cerca ```` ```koda-ui ```` vira ```` ```js ```` — o front passa a
mostrar o **código** em vez de tentar desenhar uma tela quebrada. É a mesma resposta,
só que entregável: o código aparece legível, e a explicação em texto acompanha.

Não é prompt pedindo educadamente: é o backend **garantindo** que o front receba só o
que o motor executa.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator

#: Marca de abertura de um bloco koda-ui (com a linguagem na primeira linha).
_ABRE = re.compile(r"```koda-ui\b", re.IGNORECASE)

#: Fecha de um bloco de código: a próxima cerca sozinha.
_FECHA = re.compile(r"```")

#: Assinaturas de JavaScript que o interpretador **não** executa. Qualquer uma delas
#: dentro do bloco basta pra ele ser rebaixado — é mais seguro rebaixar e mostrar o
#: código do que entregar uma tela que não monta.
_NAO_AGUENTA = [
    # função com bloco: `=> {` ou `function` (a lógica do koda-ui é expressão de uma linha)
    re.compile(r"=>\s*\{"),
    re.compile(r"\bfunction\b"),
    # laço / controle de fluxo
    re.compile(r"\bfor\s*\("),
    re.compile(r"\bwhile\s*\("),
    re.compile(r"\bswitch\s*\("),
    # console / E/S
    re.compile(r"\bconsole\.(log|error|warn|info)\b"),
    # try / catch / throw
    re.compile(r"\btry\s*\{"),
    re.compile(r"\bcatch\s*\("),
    re.compile(r"\bthrow\b"),
    # declaração de variável comum (o koda-ui só usa `const [x, setX] = DIL.useState`)
    re.compile(r"\b(let|var)\s+\w"),
    # template string com `${` DENTRO de uma string (o `codigo: '...${x}...'` do editor)
    # — detectado indiretamente: array grande com crase dentro de crase é o editor.
    # O sinal prático: `useState(EXEMPLOS[` (estado que depende de array externo grande)
    re.compile(r"useState\(\s*\w+\[\d"),
]

#: Teto de tamanho do `{@body}`: acima disto, a IA provavelmente embutiu um programa.
_TETO_BODY = 800


def bloco_aguenta(conteudo: str) -> bool:
    """O motor de UI generativa consegue montar este bloco `koda-ui`?

    `False` = rebaixa pra código comum. A decisão é conservadora de propósito: mostrar o
    código legível é melhor que entregar uma tela que não monta.
    """
    # Só o corpo antes da primeira tag: as tags (`<box>`) são o que o front desenha, e o
    # que decide é a **lógica** no `{@body}` e nos eventos.
    corpo = conteudo.split("<", 1)[0]
    if len(corpo) > _TETO_BODY:
        return False
    for padrao in _NAO_AGUENTA:
        if padrao.search(conteudo):
            return False
    return True


def rebaixar_koda_ui(texto: str) -> tuple[str, int]:
    """Troca ```` ```koda-ui ```` por ```` ```js ```` nos blocos que o motor não aguenta.

    Devolve `(texto, quantos_derivados)`. O texto com os blocos rebaixados; a contagem é
    pro log/diagnóstico. Bloco que aguenta fica como `koda-ui` — o front desenha.
    """
    if not texto or "koda-ui" not in texto:
        return texto, 0

    derivados = 0
    saida: list[str] = []
    i = 0
    while True:
        abre = _ABRE.search(texto, i)
        if abre is None:
            saida.append(texto[i:])
            break
        # o que vem antes do bloco
        saida.append(texto[i : abre.start()])
        # o conteúdo do bloco, até a próxima cerca
        fecha = _FECHA.search(texto, abre.end())
        if fecha is None:
            # bloco não fechou (cortado no stream): rebaixa por segurança e encerra
            saida.append("```js")
            saida.append(texto[abre.end() :])
            derivados += 1
            break
        conteudo = texto[abre.end() : fecha.start()]
        if bloco_aguenta(conteudo):
            saida.append("```koda-ui")
        else:
            saida.append("```js")
            derivados += 1
        saida.append(conteudo)
        saida.append("```")
        i = fecha.end()

    return "".join(saida), derivados


#: Um pedaço do stream (texto, reasoning, truncado, repetiu, usage, etc.).
#: É o mesmo `Piece` do provedor; aqui só o campo `text` importa.
class _Pedaço:
    __slots__ = ("text", "reasoning", "truncated", "repetiu", "usage", "outros")

    def __init__(self, text: str, reasoning: bool, truncated: bool, repetiu: bool, usage, outros):
        self.text = text
        self.reasoning = reasoning
        self.truncated = truncated
        self.repetiu = repetiu
        self.usage = usage
        self.outros = outros


async def filtrar_stream(
    pecas: AsyncIterator,
) -> AsyncIterator:
    """Envolve o stream do provedor e segura os blocos `koda-ui` até fecharem.

    O front desenha um bloco `koda-ui` quando ele **fecha** (a segunda cerca). Se ele
    chega pedaço a pedaço, o front vê a abertura ```` ```koda-ui ```` antes de saber se o
    código dentro rola — e às vezes já montou metade. Aqui o backend **acumula** o texto
    desde a abertura até o fechamento, decide (aguenta → mantém `koda-ui`; não → rebaixa
    pra ```` ```js ````) e só **então** emite o `` `delta` ``. O front recebe o bloco já
    decidido, e nunca vê uma tela quebrada. Pedaços que não são `` `koda-ui` `` passam
    direto, sem segurar o stream.
    """
    buffer = ""  # texto acumulado desde a abertura de um koda-ui
    dentro = False  # estamos no meio de um bloco koda-ui?
    async for peca in pecas:
        # Só o texto importa pro filtro; reasoning/usage/truncado passam direto.
        if getattr(peca, "reasoning", False) or getattr(peca, "usage", None) is not None:
            yield peca
            continue
        texto = getattr(peca, "text", "") or ""
        if not dentro:
            # fora de bloco: só entra em modo buffer quando aparece a abertura
            if "```koda-ui" not in texto:
                yield peca
                continue
            dentro = True
            buffer = texto
        else:
            buffer += texto
        # o bloco fechou? (segunda cerca depois da abertura)
        if _FECHA.search(buffer.split("koda-ui", 1)[1] if "koda-ui" in buffer else buffer):
            decidido, _ = rebaixar_koda_ui(buffer)
            yield _com_texto(peca, decidido)
            dentro = False
            buffer = ""
    # sobrou bloco aberto no fim do stream (cortado): rebaixa por segurança
    if dentro and buffer:
        decidido, _ = rebaixar_koda_ui(buffer + "\n```")
        yield _com_texto(None, decidido)


def _com_texto(peca, texto: str):
    """Um novo pedaço com o texto decidido, copiando os campos do pedaço original."""
    if peca is None:
        # stream acabou com bloco aberto: devolve um pedaço mínimo de texto.
        class _P:
            text = texto
            reasoning = False
            truncated = False
            repetiu = False
            usage = None
        return _P()
    try:
        return peca.__class__(
            text=texto,
            reasoning=getattr(peca, "reasoning", False),
            truncated=getattr(peca, "truncated", False),
            repetiu=getattr(peca, "repetiu", False),
            usage=getattr(peca, "usage", None),
        )
    except TypeError:
        # O construtor do Piece pode ter outra assinatura; devolve o original com o texto
        # trocado por atribuição quando der, senão o original.
        try:
            peca.text = texto  # type: ignore[attr-defined]
            return peca
        except Exception:
            return peca
