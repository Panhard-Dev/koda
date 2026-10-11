"""Os tetos do Koda — **infraestrutura compartilhada**.

Não é camada: todo mundo importa, e ele não importa ninguém do projeto. É o que permite
`execution/` cortar a saída de um comando sem importar `agent/` — a regra de direção
proíbe importar para cima, e infraestrutura compartilhada não está na cadeia.

## Por que `RuntimeLimits` e não constantes

`definir_limites` (chamado uma vez na subida, em `main.py`) ajusta estes números. Com
constante de módulo, quem fez `from .limits import LIMITE_SAIDA` fica com o valor **antigo**
para sempre — a configuração passa a valer só em quem lê pelo módulo. Com objeto, todo mundo
lê o mesmo lugar e o ajuste vale de verdade.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque


class RuntimeLimits:
    """Os tetos ajustáveis do app. Um só, compartilhado: `LIMITES`."""

    def __init__(self) -> None:
        # Saída e leitura (camada de arquivos).
        self.saida = 50_000
        self.leitura = 100_000
        self.linha = 2_000
        self.listagem = 2_000

        # Comando (camada de execução).
        self.tempo_comando = 600
        self.tempo_comando_max = 3_600
        self.intervalo_olhada = 240
        self.saida_rodando = 200_000
        self.olhadas_sem_saida = 3
        self.inatividade_s = 300
        self.olhadas_ate_cobrar = 10
        self.processos = 4

        # Rede e busca.
        self.rede = 100_000_000
        self.arquivos_busca = 200
        self.itens_varredura = 20_000
        self.bytes_varredura = 128_000_000
        self.tempo_varredura_s = 5.0
        self.saltos = 5

        # Patch.
        self.tolerancia_hunk = 5_000

        # Requisições ao provedor.
        #
        # O RPM é do **app inteiro**, e não de cada conversa: dois chats abertos, ou um
        # chat com três sub-agentes, contam no mesmo teto. Um teto por conversa seria um
        # teto que se multiplica abrindo conversas — que é exatamente o que ele existe para
        # impedir.
        self.requisicoes_por_minuto = 250
        # O RPS é de **cada sub-agente**, e não do app: é ele que impede um sub-agente
        # sozinho de martelar o serviço. Os sub-agentes contam também no RPM acima.
        self.requisicoes_por_segundo_sub = 30
        # Quanto vale a pena esperar por uma vaga antes de recusar. Abaixo disto a espera é
        # invisível e o trabalho sai; acima, quem está esperando já perdeu o fio do que pediu
        # — e a espera ainda comeria o prazo da tarefa, matando a rodada por tempo com a
        # mensagem errada na tela.
        self.espera_do_teto_s = 5.0


#: O objeto único. Quem lê teto lê daqui.
LIMITES = RuntimeLimits()


class TetoAtingido(RuntimeError):
    """O minuto está cheio, e esperar pela vaga passaria do que vale a pena.

    Quem levanta é o `TetoDeRequisicoes`; quem traduz para a mensagem que a pessoa lê é a
    camada do provedor (`providers.ComTeto`). O `limits.py` não conhece `ProviderError` de
    propósito: ele é infraestrutura compartilhada e não importa ninguém do projeto.
    """

    def __init__(self, por_minuto: int, espera_s: float) -> None:
        super().__init__(f"{por_minuto} requisições por minuto; faltariam {espera_s:.0f}s")
        self.por_minuto = por_minuto
        self.espera_s = espera_s


class TetoDeRequisicoes:
    """Janela deslizante de requisições ao provedor — uma só para o processo.

    Quem chama **espera** a vez em vez de receber erro na primeira tentativa: a espera curta
    é invisível e o trabalho sai. Passando de `espera_do_teto_s`, aí sim recusa — uma espera
    longa não é gentileza, é a rodada morrendo por tempo com a mensagem errada na tela.

    O número é lido do `LIMITES` a cada uso, e não copiado na construção: é o que faz um
    ajuste na subida valer para quem já tem o objeto na mão.
    """

    def __init__(self) -> None:
        self._marcas: deque[float] = deque()
        # Um só para o processo: sem a trava, duas chamadas simultâneas leem a mesma janela
        # e as duas passam — o teto viraria decoração justamente quando ele importa.
        self._trava = asyncio.Lock()

    @property
    def por_minuto(self) -> int:
        return max(1, int(LIMITES.requisicoes_por_minuto))

    @property
    def espera_maxima(self) -> float:
        return max(0.0, float(LIMITES.espera_do_teto_s))

    async def esperar(self) -> None:
        """Reserva uma vaga na janela de um minuto.

        Espera pela vaga enquanto a espera couber em `espera_maxima`; passando disso,
        levanta `TetoAtingido` — quem chama decide o que dizer à pessoa.
        """
        async with self._trava:
            while True:
                agora = time.monotonic()
                while self._marcas and agora - self._marcas[0] >= 60.0:
                    self._marcas.popleft()
                if len(self._marcas) < self.por_minuto:
                    self._marcas.append(agora)
                    return
                # A mais antiga sai da janela daqui a tanto; é isso que se esperaria.
                falta = 60.0 - (agora - self._marcas[0])
                if falta > self.espera_maxima:
                    raise TetoAtingido(self.por_minuto, falta)
                await asyncio.sleep(falta + 0.01)


#: O teto de requisições do app. Um só — ver `TetoDeRequisicoes`.
LIMITE_DE_REQUISICOES = TetoDeRequisicoes()


#: Quanto do orçamento vai para a cabeça. O resto fica com a cauda.
PROPORCAO_DA_CABECA = 0.4


def aviso_de_corte(omitidos: int, total: int, *, rotulo: str = "SAÍDA") -> str:
    """O aviso que fica no lugar do que foi omitido — uma forma só, sempre igual."""
    return (
        f"\n\n... [{rotulo} TRUNCADA — {omitidos:,} de {total:,} caracteres omitidos] ...\n\n"
    ).replace(",", ".")


def dividir_orcamento(orcamento: int) -> tuple[int, int]:
    """`(cabeça, cauda)` em caracteres para um orçamento total."""
    cabeca = int(orcamento * PROPORCAO_DA_CABECA)
    return cabeca, orcamento - cabeca


def cortar_cabeca_e_cauda(texto: str, teto: int, *, rotulo: str = "SAÍDA") -> str:
    """`texto` intacto quando cabe em `teto`; senão cabeça + aviso + cauda.

    O texto **mantido** tem exatamente `teto` caracteres; o aviso vem por cima, e é por isso
    que a saída final pode passar do teto por algumas dezenas de caracteres. O aviso é
    informação, não conteúdo — cortá-lo para caber esconderia justamente o que explica o
    tamanho da resposta.
    """
    if len(texto) <= teto:
        return texto
    cabeca, cauda = dividir_orcamento(teto)
    omitidos = len(texto) - cabeca - cauda
    return (
        texto[:cabeca]
        + aviso_de_corte(omitidos, len(texto), rotulo=rotulo)
        + texto[-cauda:]
    )
