"""Chamadas de ferramenta que vazam como texto (formato DSML do DeepSeek).

Alguns modelos — o DeepSeek 3.2 atrás do Kiro, e modelos do host em certas versões —
devolvem a chamada de ferramenta **como texto** em vez de `tool_calls`:

    <｜DSML｜tool_calls>
    <｜DSML｜invoke name="read_file">
    <｜DSML｜parameter name="caminho" string="true">a.txt</｜DSML｜parameter>
    </｜DSML｜invoke>
    </｜DSML｜tool_calls>

Sem tratamento, o laço lê isso como fala e a pessoa vê os marcadores na resposta. Este
módulo reconhece o bloco, transforma em `ToolCall` e tira o bloco do texto.

Há também o caso quebrado: o modelo emite só o começo do marcador
(`<｜DSML｜function_calls`) no meio da resposta, sem fechar. Aí o marcador é lixo e sai do
texto, sem inventar chamada nenhuma — o Kiro manda a chamada de verdade por outro evento.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..contracts.turn import ToolCall

#: A barra vertical do tokenizador do DeepSeek é a de largura total (U+FF5C); alguns
#: gateways normalizam para ASCII. As duas formas valem.
_BARRA = r"[｜|]"
_MARCA = rf"<{_BARRA}DSML{_BARRA}"
#: O marcador de fechamento é `</｜DSML｜…>` — a barra vem antes da barra vertical.
_ABRE = re.compile(rf"</?{_BARRA}DSML{_BARRA}", re.IGNORECASE)
_TAG = re.compile(rf"(</?){_BARRA}DSML{_BARRA}([^\n>]*)(>?)", re.IGNORECASE)
_BLOCO = re.compile(
    rf"{_MARCA}(?:tool_calls|function_calls)\s*>(.*?)</{_BARRA}DSML{_BARRA}(?:tool_calls|function_calls)\s*>",
    re.IGNORECASE | re.DOTALL,
)
_INVOKE = re.compile(
    rf"{_MARCA}invoke\s+name=\"([^\"]+)\"\s*>(.*?)</{_BARRA}DSML{_BARRA}invoke\s*>",
    re.IGNORECASE | re.DOTALL,
)
_PARAM = re.compile(
    rf"{_MARCA}parameter\s+name=\"([^\"]+)\"(?:\s+string=\"(true|false)\")?\s*>(.*?)"
    rf"</{_BARRA}DSML{_BARRA}parameter\s*>",
    re.IGNORECASE | re.DOTALL,
)
#: Qualquer marcador solto — inclusive o que não fechou (`<｜DSML｜function_calls`).
_LIXO = re.compile(rf"</?{_BARRA}DSML{_BARRA}[^\n>]*>?", re.IGNORECASE)

_PREFIXOS = ("<｜dsml｜", "<|dsml|", "</｜dsml｜", "</|dsml|")


def _valor(bruto: str, tipo: str | None) -> Any:
    """O valor de um `<parameter>`: string crua ou JSON, conforme o `string="..."`."""
    if tipo == "true":
        return bruto
    try:
        return json.loads(bruto)
    except (TypeError, ValueError):
        return bruto


def extrair(texto: str) -> tuple[str, list[ToolCall]]:
    """Tira os blocos DSML do texto e devolve as chamadas que eles descrevem."""
    if not texto or not _ABRE.search(texto):
        return texto, []

    chamadas: list[ToolCall] = []
    for bloco in _BLOCO.finditer(texto):
        for invoke in _INVOKE.finditer(bloco.group(1)):
            nome = invoke.group(1).strip()
            if not nome:
                continue
            argumentos: dict[str, Any] = {}
            for parametro in _PARAM.finditer(invoke.group(2)):
                chave = parametro.group(1).strip()
                if not chave:
                    continue
                argumentos[chave] = _valor(parametro.group(3), parametro.group(2))
            chamadas.append(
                ToolCall(
                    id=f"call_dsml_{len(chamadas)}",
                    name=nome,
                    arguments=argumentos,
                    raw_arguments=json.dumps(argumentos, ensure_ascii=False),
                )
            )

    limpo = _BLOCO.sub("", texto)
    limpo = _LIXO.sub("", limpo)
    return _arrumar(limpo), chamadas


def limpar(texto: str) -> str:
    """Só tira os marcadores; serve ao caminho sem ferramentas."""
    if not texto or not _ABRE.search(texto):
        return texto
    return _arrumar(_LIXO.sub("", texto))


def _arrumar(texto: str) -> str:
    texto = re.sub(r"[ \t]+\n", "\n", texto)
    texto = re.sub(r"\n{3,}", "\n\n", texto)
    return texto.strip()


def _prefixo_de_marcador(pedaco: str) -> bool:
    minusculo = pedaco.lower()
    return any(marca.startswith(minusculo) for marca in _PREFIXOS)


def _corte_de_marcador(texto: str) -> int:
    """Quantos caracteres do fim ainda podem ser o começo de um marcador."""
    limite = min(len(texto), max(len(item) for item in _PREFIXOS))
    for tamanho in range(limite, 0, -1):
        if _prefixo_de_marcador(texto[-tamanho:]):
            return tamanho
    return 0


def _prosa_no_bloco(texto: str) -> int | None:
    """Onde o bloco deixou de ser tag e virou fala (bloco quebrado)? `None` se não."""
    achado = re.search(r"\n([^\s<])", texto)
    return achado.start() if achado else None


class FiltroDsml:
    """Segura o texto que pode ser marcador e libera só o que a pessoa deve ler.

    O filtro é de fluxo: os pedaços chegam fatiados (`<｜DSML｜funct` + `ion_calls`), então
    ele guarda a cauda que ainda pode completar um marcador e só a devolve quando sabe que
    não era marcador. Um bloco completo é engolido; um marcador quebrado (sem `>`) é
    descartado e o texto seguinte continua fluindo.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._modo = "texto"  # texto | tag | bloco
        self._bloco = False
        self._profundidade = 0
        self._parametro = False
        #: A resposta ainda não começou? Serve para não abrir a fala com as quebras de
        #: linha que sobraram do marcador descartado no começo.
        self._comecou = False

    def alimentar(self, texto: str) -> str:
        self._buffer += texto or ""
        saida: list[str] = []
        while self._buffer:
            if self._modo == "texto":
                achado = _ABRE.search(self._buffer)
                if achado is None:
                    corte = _corte_de_marcador(self._buffer)
                    if corte:
                        saida.append(self._buffer[:-corte])
                        self._buffer = self._buffer[-corte:]
                    else:
                        saida.append(self._buffer)
                        self._buffer = ""
                    break
                if achado.start():
                    saida.append(self._buffer[: achado.start()])
                self._buffer = self._buffer[achado.start():]
                self._modo = "tag"
                continue

            if self._modo == "tag":
                achado = _TAG.match(self._buffer)
                if achado is None:
                    # Chegou uma quebra de linha antes do `>`: o marcador não fecha. É o
                    # caso do Kiro — descarta o marcador e devolve o texto da linha.
                    if "\n" in self._buffer:
                        fim = self._buffer.index("\n")
                        self._buffer = self._buffer[fim:]
                        self._modo = "texto"
                        continue
                    break
                fecha = achado.group(1) == "</"
                corpo = achado.group(2).strip()
                fechado = achado.group(3) == ">"
                if not fechado:
                    # O `>` ainda não chegou: espera o próximo pedaço. Só é marcador
                    # quebrado se uma quebra de linha aparecer antes dele.
                    if "\n" in self._buffer:
                        fim = self._buffer.index("\n")
                        self._buffer = self._buffer[fim:]
                        self._modo = "texto"
                        continue
                    break
                self._buffer = self._buffer[achado.end():]
                nome = corpo.split()[0].lower() if corpo else ""
                if fecha:
                    # `</｜DSML｜tool_calls>`: o nome vem sem a barra. Sem tratar isto
                    # aqui, o filtro só saía do bloco pela quebra de linha seguinte e
                    # engolia a fala que viesse na mesma linha do fechamento.
                    if nome in {"tool_calls", "function_calls"}:
                        self._profundidade = max(0, self._profundidade - 1)
                        if self._profundidade == 0:
                            self._bloco = False
                    elif nome == "parameter":
                        self._parametro = False
                    self._modo = "bloco" if self._bloco else "texto"
                elif nome in {"tool_calls", "function_calls"}:
                    self._bloco = True
                    self._profundidade += 1
                    self._parametro = False
                    self._modo = "bloco"
                elif nome in {"/tool_calls", "/function_calls"}:
                    self._profundidade = max(0, self._profundidade - 1)
                    if self._profundidade == 0:
                        self._bloco = False
                    self._modo = "bloco" if self._bloco else "texto"
                elif nome == "parameter":
                    self._parametro = True
                    self._modo = "bloco" if self._bloco else "texto"
                elif nome == "/parameter":
                    self._parametro = False
                    self._modo = "bloco" if self._bloco else "texto"
                else:
                    self._modo = "bloco" if self._bloco else "texto"
                continue

            # bloco: engole tudo até o marcador que fecha o bloco.
            achado = _ABRE.search(self._buffer)
            if achado is None:
                prosa = None if self._parametro else _prosa_no_bloco(self._buffer)
                if prosa is not None:
                    # O bloco não fechou e já virou fala: descarta as tags acumuladas e
                    # devolve a fala, para a resposta não ficar presa.
                    saida.append(_LIXO.sub("", self._buffer[prosa:]))
                    self._buffer = ""
                    self._bloco = False
                    self._profundidade = 0
                    self._parametro = False
                    self._modo = "texto"
                break
            antes = self._buffer[: achado.start()]
            if not self._parametro:
                prosa = _prosa_no_bloco(antes)
                if prosa is not None:
                    saida.append(_LIXO.sub("", antes[prosa:]))
                    self._bloco = False
                    self._profundidade = 0
                    self._parametro = False
            self._buffer = self._buffer[achado.start():]
            self._modo = "tag"
        resultado = "".join(saida)
        if resultado and not self._comecou:
            resultado = resultado.lstrip()
            if resultado:
                self._comecou = True
        return resultado

    def finalizar(self) -> str:
        """Devolve o que sobrou. Bloco incompleto é chamada pela metade: não vai à tela."""
        buffer, self._buffer = self._buffer, ""
        modo = self._modo
        self._modo = "texto"
        self._bloco = False
        self._profundidade = 0
        self._parametro = False
        if not buffer:
            return ""
        if modo == "bloco":
            return ""
        resultado = _LIXO.sub("", buffer)
        return resultado if self._comecou else resultado.lstrip()
