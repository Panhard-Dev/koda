"""Corte de saída grande demais: cabeça + cauda, com um aviso no meio.

**Origem:** `tools/tool_output_truncate.py` do material de referência (arquivo
`TOK-tool_output_truncate.py`). O comportamento é o de lá; nomes e texto são do Koda.

O defeito que isto fecha (achado 11 do QA, "consumo excessivo de tokens em tarefas
simples"): o corte era **só a cabeça** — `texto[:limite]`, e o resto sumia. Num comando
longo, o que interessa costuma estar no **fim**: o resultado do build, o erro do teste, o
último log. O modelo recebia o começo, não achava o que precisava, e repetia o comando (ou
lia o arquivo de novo) para ver o fim — pagando o mesmo custo outra vez, em tokens.

Um algoritmo e um formato de aviso: **40% de cabeça** (o erro aparece cedo) e **60% de
cauda** (as linhas mais recentes são as que importam), em volta de uma marca única. Quem
reconhece a marca depois encontra sempre a mesma forma.

O que **não** muda: os tetos continuam sendo os do Koda (`LIMITE_SAIDA`, `LIMITE_LEITURA`,
`LIMITE_DE_LINHA`, ajustáveis por `definir_limites`). Aqui só muda **como** o texto é
cortado quando passa do teto.
"""

from __future__ import annotations

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
