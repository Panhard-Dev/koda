"""O que a IA mudou nos arquivos — é daqui que a aba Código tira o verde e o vermelho.

Para dizer o que entrou e o que saiu é preciso o **antes**. Sem ele só daria para comparar o
arquivo de agora com ele mesmo, e não haveria diff nenhum. Então cada ferramenta de escrita
anota aqui o texto de antes e o de depois, e a comparação sai dos dois.

Mora em `contracts/` porque é compartilhado entre camadas: quem **escreve** é `tools/` (as
ferramentas de arquivo) e quem **lê** é `routers/` (a aba Código). Não é camada — todos
importam, e é isso que evita o ciclo.

O mesmo material serve a **dois** leitores, e por isso ele é guardado de duas formas:

- por **arquivo** (`Mudanca`), cumulativo — é o que a aba Código mostra: «o que a IA fez
  neste arquivo desde que o Koda abriu»;
- por **chamada** (`Evento`), o diff daquela chamada e só dela — é o que o cartão da
  ferramenta, na conversa, mostra. Num arquivo escrito três vezes, o acumulado apareceria
  igual nos três cartões, e o cartão estaria mentindo sobre o que ele mesmo fez.

Vive no processo e morre com ele, de propósito: é «o que mudou nesta execução do Koda», não
um histórico em disco. Um registro que sobrevivesse ao fechamento do app diria «a IA mudou
isto» sobre uma mudança de ontem — e isso seria mentira na tela. É também por isso que uma
conversa reaberta depois de fechar o app não tem mais o diff por chamada: a conversa fica,
o registro não.

O que entra é o que as ferramentas de escrita do Koda gravam: `write_file`, `edit_file` e
`apply_patch`. Três coisas ficam de fora, cada uma por um motivo:

- o que passa por `shell` (um `sed`, um `git apply`, um script que reescreve arquivos) — o
  Koda não lê o que o comando fez no disco, e não vai fingir que leu;
- `move_file` e `rename_file` — o conteúdo não muda, então não há linha para pintar;
- `delete_file` — o arquivo sai da árvore, e uma linha que não está mais lá não tem onde
  aparecer.

Onde não há mudança anotada, a tela mostra o arquivo como ele está. Ela nunca promete mais
do que sabe.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterator

#: Acima disto não há diff por linha — só a contagem de arquivo alterado.
#:
#: A comparação linha a linha é quadrática no pior caso, e o pior caso é exatamente um
#: `write_file` que troca o conteúdo inteiro de um arquivo grande. O teto existe para a
#: ferramenta do agente não parar por causa de um diff que ninguém pediu.
LIMITE_DE_LINHAS = 6000


@dataclass(slots=True)
class Mudanca:
    """Um arquivo que a IA mexeu nesta execução, com o antes e o depois."""

    caminho: str
    ferramenta: str
    quando: int
    #: `None` quando o arquivo não existia antes — foi criado. Diferente de estar vazio.
    antes: str | None
    depois: str | None
    #: Linhas que entraram e que saíram. `None` quando o arquivo passou do teto do diff.
    mais: int | None
    menos: int | None
    #: Quantas vezes uma ferramenta escreveu neste caminho desde o começo da execução.
    vezes: int = 1


@dataclass(slots=True)
class Evento:
    """Uma escrita **como ela aconteceu**: o antes e o depois daquela chamada, e só dela.

    Existe separado do `Mudanca` porque os dois respondem a perguntas diferentes. O
    `Mudanca` é por **arquivo** e é cumulativo — «o que a IA fez neste arquivo desde que o
    Koda abriu», que é o que a aba Código mostra. O `Evento` é por **chamada**: o cartão da
    ferramenta na conversa precisa dizer o que *aquela* chamada fez, e num arquivo escrito
    três vezes o acumulado apareceria igual nos três cartões.
    """

    caminho: str
    ferramenta: str
    antes: str | None
    depois: str | None


_guardadas: dict[str, Mudanca] = {}
#: O que cada chamada mudou, pelo id dela. É por aqui que o cartão da ferramenta na conversa
#: se acha. Cresce com o trabalho da execução e só é esvaziado por `limpar()` — é o preço de
#: cada cartão poder mostrar o próprio diff em vez do acumulado do arquivo.
_por_chamada: dict[str, list[Evento]] = {}
#: As ferramentas rodam em thread (`asyncio.to_thread`): sem a trava, duas escritas ao mesmo
#: tempo no mesmo arquivo perderiam uma das duas.
_trava = threading.Lock()


def anotar(
    caminho: str,
    antes: str | None,
    depois: str | None,
    ferramenta: str,
    chamada: str = "",
) -> None:
    """Registra uma escrita neste caminho.

    O `antes` que fica no registro por arquivo é o da **primeira** vez: guardar o da última
    apagaria a mudança anterior, e três edições no mesmo arquivo apareceriam como uma só — a
    tela mostraria menos do que a IA fez. O `depois` é sempre o mais recente, e a contagem de
    linhas é refeita do começo ao fim a cada vez.

    `chamada` é o id da chamada da ferramenta. Com ele, a escrita também entra no registro
    **por chamada**, que é o que deixa cada cartão da conversa mostrar o próprio diff.
    """
    chave = _chave(caminho)
    mais, menos = _contagem(antes, depois)
    with _trava:
        existente = _guardadas.get(chave)
        if existente is None:
            _guardadas[chave] = Mudanca(
                caminho=caminho,
                ferramenta=ferramenta,
                quando=_agora(),
                antes=antes,
                depois=depois,
                mais=mais,
                menos=menos,
            )
        else:
            existente.depois = depois
            existente.ferramenta = ferramenta
            existente.quando = _agora()
            existente.mais = mais
            existente.menos = menos
            existente.vezes += 1
        if chamada:
            _por_chamada.setdefault(chamada, []).append(
                Evento(caminho=caminho, ferramenta=ferramenta, antes=antes, depois=depois)
            )


def listar() -> list[dict[str, object]]:
    """O resumo de tudo que mudou — é o que marca as linhas na árvore.

    Sem as linhas do diff: a árvore só precisa do caminho e da contagem, e montar o diff de
    todo arquivo alterado a cada sondagem seria caro para nada.
    """
    with _trava:
        itens = sorted(_guardadas.values(), key=lambda item: item.caminho.lower())
        return [_resumo(item) for item in itens]


def de(caminho: str) -> dict[str, object] | None:
    """O retrato de um arquivo: o resumo mais as linhas marcadas. `None` se não mudou."""
    with _trava:
        mudanca = _guardadas.get(_chave(caminho))
        if mudanca is None:
            return None
        retrato = _resumo(mudanca)
    # Fora da trava: o diff é a parte cara, e montá-lo segurando o cadeado travaria a anotação
    # da próxima ferramenta.
    retrato["linhas"] = linhas_do_diff(mudanca.antes, mudanca.depois)
    return retrato


def da_chamada(chamada: str) -> list[dict[str, object]]:
    """O que **esta** chamada mudou, com as linhas do diff de cada arquivo.

    É o que o cartão da ferramenta, na conversa, mostra em verde e vermelho. Vazio quando a
    chamada não escreveu nada — ou quando ela é de uma execução anterior do Koda, que é o
    caso de uma conversa reaberta depois de fechar o app.
    """
    if not chamada:
        return []
    with _trava:
        eventos = list(_por_chamada.get(chamada, ()))
    saida: list[dict[str, object]] = []
    for evento in eventos:
        # Fora da trava: o diff é a parte cara, e montá-lo segurando o cadeado travaria a
        # anotação da próxima ferramenta.
        retrato: dict[str, object] = {
            "caminho": evento.caminho,
            "ferramenta": evento.ferramenta,
            "criado": evento.antes is None,
            "linhas": linhas_do_diff(evento.antes, evento.depois),
        }
        saida.append(retrato)
    return saida


def limpar() -> int:
    """Esquece as marcas. Devolve quantos arquivos estavam anotados.

    O arquivo no disco não é tocado — o que sai é só o registro do que mudou, tanto o por
    arquivo (a aba Código) quanto o por chamada (os cartões da conversa).
    """
    with _trava:
        quantas = len(_guardadas)
        _guardadas.clear()
        _por_chamada.clear()
    return quantas


def linhas_do_diff(antes: str | None, depois: str | None) -> list[dict[str, object]] | None:
    """As linhas do arquivo com a marca de cada uma: `igual`, `entrou` ou `saiu`.

    Vem o arquivo inteiro, e não só os trechos mexidos: um diff sem o código em volta não diz
    onde a mudança caiu. `None` quando o arquivo passa do teto — quem chama avisa, em vez de
    mostrar um diff pela metade como se fosse o todo.
    """
    velhas = _linhas(antes)
    novas = _linhas(depois)
    if len(velhas) + len(novas) > LIMITE_DE_LINHAS:
        return None

    linhas: list[dict[str, object]] = []
    antigo, novo = 1, 1
    for etiqueta, i1, i2, j1, j2 in _opcodes(velhas, novas):
        if etiqueta == "equal":
            for texto in velhas[i1:i2]:
                linhas.append({"tipo": "igual", "antigo": antigo, "novo": novo, "texto": texto})
                antigo += 1
                novo += 1
            continue
        # O que saiu vem **antes** do que entrou, inclusive no `replace`: é a ordem em que a
        # mudança se lê — o antigo em cima, o novo embaixo.
        if etiqueta in ("delete", "replace"):
            for texto in velhas[i1:i2]:
                linhas.append({"tipo": "saiu", "antigo": antigo, "novo": None, "texto": texto})
                antigo += 1
        if etiqueta in ("insert", "replace"):
            for texto in novas[j1:j2]:
                linhas.append({"tipo": "entrou", "antigo": None, "novo": novo, "texto": texto})
                novo += 1
    return linhas


def _resumo(mudanca: Mudanca) -> dict[str, object]:
    return {
        "caminho": mudanca.caminho,
        "ferramenta": mudanca.ferramenta,
        "quando": mudanca.quando,
        "vezes": mudanca.vezes,
        "mais": mudanca.mais,
        "menos": mudanca.menos,
        "criado": mudanca.antes is None,
    }


def _contagem(antes: str | None, depois: str | None) -> tuple[int | None, int | None]:
    """Quantas linhas entraram e quantas saíram — sem montar a lista."""
    velhas = _linhas(antes)
    novas = _linhas(depois)
    if len(velhas) + len(novas) > LIMITE_DE_LINHAS:
        return None, None
    mais = menos = 0
    for etiqueta, i1, i2, j1, j2 in _opcodes(velhas, novas):
        if etiqueta in ("insert", "replace"):
            mais += j2 - j1
        if etiqueta in ("delete", "replace"):
            menos += i2 - i1
    return mais, menos


def _linhas(texto: str | None) -> list[str]:
    """O texto em linhas. `None` (arquivo que não existia) é lista vazia, e não uma linha
    vazia — a diferença é o que faz um arquivo criado aparecer inteiro em verde."""
    return [] if texto is None else texto.split("\n")


def _opcodes(velhas: list[str], novas: list[str]) -> Iterator[tuple[str, int, int, int, int]]:
    """O casamento entre as duas versões.

    `autojunk=False` de propósito: com o padrão, linha repetida (um `}`, uma linha em branco)
    é tratada como «lixo» e sai do casamento — e em código isso produz um diff errado, com
    blocos inteiros marcados como trocados quando uma linha só mudou.
    """
    return SequenceMatcher(None, velhas, novas, autojunk=False).get_opcodes()


def _chave(caminho: str) -> str:
    """A identidade de um caminho: no Windows, caixa e barra não distinguem dois arquivos."""
    return os.path.normcase(os.path.abspath(caminho))


def _agora() -> int:
    return int(time.time() * 1000)
