"""Limpa blocos de raciocínio do texto que vai para a tela — inclusive no meio do fluxo.

**Origem:** `agent/think_scrubber.py` do material de referência (arquivo
`RAC-think_scrubber.py`). O comportamento é o de lá; nomes e texto são do Koda.

O defeito que isto fecha (achado 7 do QA, "raciocínio/log interno visível"): o modelo emite o
raciocínio dentro do próprio texto, entre marcações (`<thinking>…</thinking>` e as variantes
que os modelos usam). A limpeza por expressão regular funciona no texto **completo**, mas
quebrada por pedaço — e o Koda recebe o texto em pedaços — ela apaga uma abertura que chega
sozinha, e a partir dali o raciocínio vaza inteiro para a resposta.

Esta classe segura a marcação partida na fronteira entre pedaços até ela se resolver. O
`despejar()` solta a prosa que estava presa e não era marcação; o `reiniciar()` limpa o
estado no começo de cada rodada. Uma abertura só começa um bloco em **fronteira de bloco**
(início do fluxo, depois de quebra de linha, ou linha só com espaço) — assim prosa que
apenas *menciona* a marcação não é engolida. Par fechado é sempre removido, de propósito.
"""

from __future__ import annotations

import re
from typing import Tuple

__all__ = ["LimpaRaciocinio", "MARCAS_DE_RACIOCINIO"]

#: A lista única de nomes de marcação de raciocínio.
#:
#: Toda superfície que esconde raciocínio aponta para cá: acrescentar um nome aqui cobre
#: todas. Quem consome compara sem diferenciar maiúscula, então as marcas vão em minúscula.
#: Os nomes em CJK cobrem modelos que emitem a marcação em chinês: 思考 (pensar),
#: 反思 (refletir), 推理 (inferir), 推敲 (deliberar).
MARCAS_DE_RACIOCINIO: Tuple[str, ...] = (
    "think",
    "thinking",
    "reasoning",
    "thought",
    "REASONING_SCRATCHPAD",
    "思考",
    "反思",
    "推理",
    "推敲",
)


class LimpaRaciocinio:
    """Limpa blocos de raciocínio de um texto que chega em pedaços.

    Estado: `_dentro` (dentro de um bloco aberto; o texto é descartado), `_guardado` (resto
    de marcação partida segurado) e `_ultimo_terminou_em_linha` (decide se uma abertura na
    posição zero está em fronteira de bloco).
    """

    #: Marcações literais, para o caminho quente usar operação de texto e não expressão.
    _ABRE: Tuple[str, ...] = tuple(f"<{nome.lower()}>" for nome in MARCAS_DE_RACIOCINIO)
    _FECHA: Tuple[str, ...] = tuple(f"</{nome.lower()}>" for nome in MARCAS_DE_RACIOCINIO)
    _TODAS: Tuple[str, ...] = _ABRE + _FECHA
    _MAIOR_MARCA: int = max(len(marca) for marca in _TODAS)
    #: Fechamento órfão mais o espaço que vem depois.
    _FECHA_ORFA = re.compile(
        "(?:" + "|".join(re.escape(m) for m in _FECHA) + r")[ \t\n\r]*", re.IGNORECASE
    )

    def __init__(self) -> None:
        self.reiniciar()

    def reiniciar(self) -> None:
        """Zera o estado. Chamar no começo de cada rodada."""
        self._dentro: bool = False
        self._guardado: str = ""
        self._ultimo_terminou_em_linha: bool = True
        #: Raciocínio que o último `alimentar()` tirou de dentro dos blocos (sem as marcações).
        self.ultimo_escondido: str = ""

    def alimentar(self, texto: str) -> str:
        """Recebe um pedaço; devolve a parte visível (vazio quando é só raciocínio ou está presa)."""
        self.ultimo_escondido = ""
        if not texto:
            return ""
        buffer = self._guardado + texto
        self._guardado = ""
        saida: list[str] = []
        escondido: list[str] = []

        while buffer:
            if self._dentro:
                posicao, tamanho = self._primeira_marca(buffer, self._FECHA)
                if posicao == -1:
                    # Sem fechamento ainda: segura um possível prefixo de fechamento; o resto
                    # é raciocínio.
                    escondido.append(self._segurar_parcial(buffer, self._FECHA))
                    break
                escondido.append(buffer[:posicao])
                buffer = buffer[posicao + tamanho :]
                self._dentro = False
                continue

            # Prioridade 1: par fechado `<marca>x</marca>` em qualquer lugar (mesmo em linha,
            # é quase certo raciocínio vazado). Prioridade 2: abertura sem fechamento em
            # fronteira de bloco. Vence o mais cedo.
            par = self._par_fechado_mais_cedo(buffer)
            posicao_abre, tamanho_abre = self._abre_em_fronteira(buffer, saida)
            if par is not None and (posicao_abre == -1 or par[0] <= posicao_abre):
                self._emitir(saida, buffer[: par[0]])
                escondido.append(
                    buffer[buffer.index(">", par[0]) + 1 : buffer.rindex("<", par[0], par[1])]
                )
                buffer = buffer[par[1] :]
                continue
            if posicao_abre != -1:
                self._emitir(saida, buffer[:posicao_abre])
                self._dentro = True
                buffer = buffer[posicao_abre + tamanho_abre :]
                continue

            # Nada resolvível: segura o prefixo de marcação na ponta, para uma marcação
            # partida entre pedaços não passar batido, e emite o resto.
            self._emitir(saida, self._segurar_parcial(buffer, self._TODAS))
            break

        self.ultimo_escondido = "".join(escondido)
        return "".join(saida)

    def despejar(self) -> str:
        """Fim do fluxo: dentro de bloco aberto o preso é descartado (vazar raciocínio pela
        metade é pior do que uma resposta truncada); fora dele, a ponta sai como está.

        Sempre zera a marca de fronteira: uma nova tentativa dentro da mesma rodada despeja e
        volta a transmitir sem `reiniciar()`, e uma marca velha fazia a abertura da nova
        transmissão parecer no meio da linha.
        """
        ponta = "" if self._dentro else self._guardado
        self._guardado = ""
        self._dentro = False
        self._ultimo_terminou_em_linha = True
        return self._tirar_fechamento_orfao(ponta) if ponta else ""

    # ── internos ───────────────────────────────────────────────────────

    def _emitir(self, saida: list[str], texto: str) -> None:
        """Acrescenta prosa visível (fechamento órfão fora) e atualiza a marca de linha."""
        texto = self._tirar_fechamento_orfao(texto)
        if texto:
            saida.append(texto)
            self._ultimo_terminou_em_linha = texto.endswith("\n")

    @staticmethod
    def _primeira_marca(buffer: str, marcas: Tuple[str, ...]) -> Tuple[int, int]:
        """(posição mais cedo, tamanho da marca) entre as marcas, ou (-1, 0)."""
        minusculo = buffer.lower()
        achados = [(i, len(marca)) for marca in marcas if (i := minusculo.find(marca)) != -1]
        return min(achados) if achados else (-1, 0)

    def _par_fechado_mais_cedo(self, buffer: str):
        """(início, fim) do par `<marca>…</marca>` mais cedo, ou None."""
        minusculo = buffer.lower()
        pares = []
        for abre, fecha in zip(self._ABRE, self._FECHA):
            i_abre = minusculo.find(abre)
            i_fecha = minusculo.find(fecha, i_abre + len(abre)) if i_abre != -1 else -1
            if i_fecha != -1:
                pares.append((i_abre, i_fecha + len(fecha)))
        return min(pares) if pares else None

    def _abre_em_fronteira(self, buffer: str, ja_emitido: list[str]) -> Tuple[int, int]:
        """A abertura em fronteira de bloco mais cedo, ou (-1, 0)."""
        minusculo = buffer.lower()
        achados = []
        for marca in self._ABRE:
            i = minusculo.find(marca)
            while i != -1 and not self._em_fronteira(buffer, i, ja_emitido):
                i = minusculo.find(marca, i + 1)
            if i != -1:
                achados.append((i, len(marca)))
        return min(achados) if achados else (-1, 0)

    def _em_fronteira(self, buffer: str, i: int, ja_emitido: list[str]) -> bool:
        """A posição `i` é fronteira de bloco?

        É quando está na posição zero depois de uma emissão terminada em quebra de linha (ou
        de nenhuma emissão), ou quando o que vem antes dela na linha atual é só espaço — e,
        se não há quebra dentro do buffer, a emissão anterior também terminou em linha.
        """
        linha_antes = (
            ja_emitido[-1].endswith("\n")
            if ja_emitido
            else self._ultimo_terminou_em_linha
        )
        if i == 0:
            return linha_antes
        anterior = buffer[:i]
        ultima_quebra = anterior.rfind("\n")
        return (linha_antes if ultima_quebra == -1 else True) and anterior[
            ultima_quebra + 1 :
        ].strip() == ""

    def _segurar_parcial(self, buffer: str, marcas: Tuple[str, ...]) -> str:
        """Move para `_guardado` o sufixo que é começo de marcação; devolve o resto."""
        segurado = self._maior_sufixo_parcial(buffer, marcas)
        self._guardado = buffer[-segurado:] if segurado else ""
        return buffer[:-segurado] if segurado else buffer

    @classmethod
    def _maior_sufixo_parcial(cls, buffer: str, marcas: Tuple[str, ...]) -> int:
        """Maior sufixo do buffer que é começo estrito de alguma marcação."""
        minusculo = buffer.lower()
        for i in range(min(len(minusculo), cls._MAIOR_MARCA - 1), 0, -1):
            sufixo = minusculo[-i:]
            if any(len(marca) > i and marca.startswith(sufixo) for marca in marcas):
                return i
        return 0

    @classmethod
    def _tirar_fechamento_orfao(cls, texto: str) -> str:
        """Tira fechamento sem abertura (sempre ruído) e o espaço que vem depois."""
        return cls._FECHA_ORFA.sub("", texto) if "</" in texto else texto
