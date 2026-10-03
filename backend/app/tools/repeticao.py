"""Detecção de resposta degenerada por repetição — antes de ela virar a resposta final.

**Origem:** `agent/repetition_guard.py` do Koda (arquivo `DUP-repetition_guard.py` em
`backend/trabalho/limites`). O comportamento é o de lá; os nomes e o texto são do Koda.

O defeito que isto fecha (achado 8 do QA, "resposta duplicada"; e parte do 11, consumo de
tokens): um modelo em laço degenerado gasta **todo** o orçamento de saída ecoando o mesmo
trecho. O Koda então emenda a continuação (`CONTINUAR_TRUNCADA`) e entrega o eco costurado
como resposta — a mesma coisa dita várias vezes, dezenas de milhares de tokens depois. A
checagem acontece **antes** do empurrão de continuação: se o trecho já é repetição dominada,
a rodada encerra com um aviso claro em vez de remendar.

Deliberadamente conservador: só repetição **longa e literal** (janela de 60 caracteres)
cobrindo a maior parte do trecho dispara. Repetição pedida ("repita X 50 vezes"), tabela com
linhas parecidas e YAML com o mesmo molde ficam abaixo do limite e continuam sendo entregues.
"""

from __future__ import annotations

import math
from collections import Counter

#: Abaixo deste tamanho a checagem nem roda: corte curto contém token repetido por acaso e a
#: continuação é legítima.
TAMANHO_MINIMO = 400

#: Janela de repetição exata — muito além da reutilização normal de frase (citação, título,
#: trecho de código parecido).
JANELA = 60

#: Uma janela que se repete ao menos isto já é sinal, mesmo em trecho curto.
REPETICOES_MINIMAS = 5

#: "Dominada por repetição" = as janelas repetidas cobrem ao menos esta fração do trecho.
DOMINANCIA = 0.5

#: O que entra **no lugar** de um parcial dominado por repetição.
#:
#: Repetir os bytes do laço (no `content` ou na linha da mensagem) re-planta o laço no pedido
#: seguinte e a corrupção sobrevive a reinícios. O modelo só precisa saber que a resposta
#: degenerou e foi cortada.
AVISO_DE_REPETICAO = (
    "_(a resposta degenerou em repetição e foi interrompida — o que veio antes dela vale)_"
)

#: `descontrolada` é mais estrita que `dominada`: exige também a **forma** de fuga.
#:
#: Quem descarta o parcial é esta função, então uma resposta legitimamente repetitiva (lote de
#: linhas distintas) não pode se qualificar: as janelas repetidas têm de dominar **e**, quando
#: o texto tem estrutura de linha, no máximo metade das linhas não vazias pode ser distinta.
RAZAO_DE_LINHAS_DISTINTAS = 0.5

#: O caminho `stop` descarta uma resposta **completa**, então só aborta em escala de fuga: os
#: laços reais de `stop` rodam de 80 mil a 350 mil caracteres, enquanto repetição pedida
#: ("repita X 50 vezes", linhas de tabela iguais, YAML com molde) fica na casa dos KB e precisa
#: ser entregue.
MINIMO_DO_CAMINHO_STOP = 16_000

#: Um fluxo vivo é julgado, no máximo, por este tanto do texto mais recente — assim uma
#: checagem fica limitada por mais que a resposta cresça.
CAUDA_DO_FLUXO = 4 * MINIMO_DO_CAMINHO_STOP

#: Amostras do caminho periódico: mantêm o custo linear no tamanho da saída.
MAX_AMOSTRAS = 32
MAX_CASAMENTOS = 8


def dominada_por_repeticao(texto: str) -> bool:
    """Um trecho contíguo de ao menos cinco repetições exatas cobre ao menos metade do texto?

    É a assinatura de um laço de repetição do modelo. A cobertura é medida com o **período
    verdadeiro**, então uma unidade longa de várias linhas conta inteira. Falha aberta para
    texto curto: abaixo de `TAMANHO_MINIMO` devolve `False`.
    """
    if not isinstance(texto, str):
        return False
    n = len(texto)
    if n < TAMANHO_MINIMO:
        return False
    # Caminho rápido: uma linha normalizada repetida o bastante para cobrir metade do trecho —
    # é a forma mais comum do eco.
    if _linha_dominada(texto, n):
        return True
    # A varredura de janelas pega laços cujas repetições diferem por um contador ou um token de
    # ruído; a varredura periódica pega unidades longas exatas cujas janelas de 60 caracteres
    # reaparecem de menos em menos.
    return _janelas_dominadas(texto, n) or _corrida_periodica_dominada(texto, n)


def descontrolada(texto: str) -> bool:
    """Mais estrita que :func:`dominada_por_repeticao`: exige também a forma de fuga.

    Quem **descarta** o parcial usa esta. Uma resposta legitimamente repetitiva (linhas de lote
    distintas) não pode se qualificar: além de as janelas repetidas dominarem, no máximo metade
    das linhas não vazias pode ser distinta.
    """
    if not dominada_por_repeticao(texto):
        return False
    linhas = [linha.strip() for linha in texto.splitlines()]
    linhas = [linha for linha in linhas if linha]
    if len(linhas) < REPETICOES_MINIMAS:
        # Sem estrutura de linha para julgar: é um laço de linha única dominado.
        return True
    return len(set(linhas)) <= len(linhas) * RAZAO_DE_LINHAS_DISTINTAS


class VigiaDeRepeticao:
    """O critério do caminho `stop`, aplicado **enquanto** um canal transmite.

    Um fluxo que não para nunca chega à checagem de conclusão, e um provedor sem teto de saída
    mantém um modelo em laço até a rodada acabar. A primeira checagem roda em
    `MINIMO_DO_CAMINHO_STOP` (repetição pedida fica abaixo, como no caminho `stop`) e o
    intervalo dobra até alcançar uma janela de cauda, então fica nela. Cada checagem lê só a
    cauda, então o trabalho total continua linear na saída, e o vigia nunca guarda mais do que
    duas janelas de cauda mais o último pedaço.
    """

    __slots__ = ("_pedacos", "_caracteres", "_proxima")

    def __init__(self) -> None:
        self._pedacos: list[str] = []
        self._caracteres = 0
        self._proxima = MINIMO_DO_CAMINHO_STOP

    def alimentar(self, texto: str) -> bool:
        """Soma um pedaço; `True` a partir do momento em que o canal virou laço de fuga."""
        if not texto:
            return False
        self._pedacos.append(texto)
        self._caracteres += len(texto)
        if self._caracteres < self._proxima:
            return False
        self._proxima = self._caracteres + min(self._caracteres, CAUDA_DO_FLUXO)
        cauda = "".join(self._pedacos)[-CAUDA_DO_FLUXO:]
        self._pedacos = [cauda]
        return descontrolada(cauda)


# ---------------------------------------------------------------- internos


def _linha_dominada(texto: str, n: int) -> bool:
    """Uma única linha normalizada cobre metade do trecho por repetição?"""
    contas = Counter(
        normalizada for normalizada in (linha.strip() for linha in texto.splitlines()) if normalizada
    )
    return any(
        quantas >= REPETICOES_MINIMAS and quantas * len(linha) >= n * DOMINANCIA
        for linha, quantas in contas.items()
    )


def _janelas_dominadas(texto: str, n: int) -> bool:
    """Uma janela de 60 caracteres se repete o bastante para cobrir metade do texto?"""
    necessarias = max(REPETICOES_MINIMAS, math.ceil(n * DOMINANCIA / JANELA))
    contas: dict[str, int] = {}
    for i in range(n - JANELA + 1):
        chave = texto[i : i + JANELA]
        quantas = contas.get(chave, 0) + 1
        if quantas >= necessarias:
            return True
        contas[chave] = quantas
    return False


def _corrida_periodica_dominada(texto: str, n: int) -> bool:
    """Detecta uma corrida periódica exata dominante a partir de âncoras espaçadas.

    Casar uma âncora de 60 caracteres numa posição posterior dá um período candidato. Expandir
    a igualdade `texto[i] == texto[i + periodo]` nos dois sentidos recupera a corrida inteira,
    então a cobertura é medida com a unidade que de fato se repete, em vez de creditar cada
    ocorrência com apenas 60 caracteres.
    """
    maximo_inicio = n - JANELA
    if maximo_inicio < 1:
        return False

    passo = max(1, (maximo_inicio + MAX_AMOSTRAS - 2) // (MAX_AMOSTRAS - 1))
    inicios = list(range(0, maximo_inicio + 1, passo))
    if inicios[-1] != maximo_inicio:
        inicios.append(maximo_inicio)

    # Corridas já expandidas e rejeitadas, como (esquerda, direita, periodo). Uma âncora
    # posterior dentro de uma delas, cujo período é múltiplo do período daquela corrida,
    # percorreria a mesma corrida de novo.
    rejeitadas: list[tuple[int, int, int]] = []
    for inicio in inicios:
        ancora = texto[inicio : inicio + JANELA]
        procurar_de = inicio + 1
        for _ in range(MAX_CASAMENTOS):
            casamento = texto.find(ancora, procurar_de)
            if casamento < 0:
                break
            periodo = casamento - inicio
            procurar_de = casamento + 1
            if any(lo <= inicio < hi and periodo % p == 0 for lo, hi, p in rejeitadas):
                continue
            esquerda, direita = _expandir(texto, n, inicio, periodo, JANELA)
            if (
                direita - esquerda >= REPETICOES_MINIMAS * periodo
                and direita - esquerda >= n * DOMINANCIA
            ):
                return True
            rejeitadas.append((esquerda, direita, periodo))
    return False


def _expandir(texto: str, n: int, inicio: int, periodo: int, casado: int) -> tuple[int, int]:
    """Expande uma janela sabidamente igual para os limites `[esquerda, direita)` da corrida."""
    esquerda = inicio
    while esquerda > 0 and texto[esquerda - 1] == texto[esquerda - 1 + periodo]:
        esquerda -= 1

    direita = inicio + casado
    while direita + periodo < n and texto[direita] == texto[direita + periodo]:
        direita += 1
    return esquerda, direita + periodo
