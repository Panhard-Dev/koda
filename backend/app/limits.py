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


#: O objeto único. Quem lê teto lê daqui.
LIMITES = RuntimeLimits()


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
