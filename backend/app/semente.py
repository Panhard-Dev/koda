"""O que o app precisa ter no `data/` na primeira execução — e a cada atualização.

O app instalado nasce com o `data/` só com o banco: não tem `mcps.json`, não tem skill
nenhuma. O que o produto **entrega de fábrica** é montado aqui — os padrões ficam ao lado do
código (`backend/app/`, que é a pasta que o instalador copia) e são escritos no `data/`.

**Nunca passar por cima é a regra**, e não um detalhe: `data/` é onde a pessoa mexe pela
tela. Semear a cada abertura desfaria a configuração dela — quem apagou um servidor da lista
veria ele voltar no dia seguinte.

Só que «nunca passar por cima» virou, na prática, «nunca entregar nada de novo»: o
`mcps.json` era escrito **só quando não existia**, então quem instalou a 0.6.x ficava com a
lista da 0.6.x para sempre. Foi assim que o `video-analizar` viajou dentro do instalador da
0.7.1, apareceu em `mcp/` na pasta de instalação, e mesmo assim nunca chegou à tela — o
gerenciador lê `data/mcps.json`, e lá só havia os dois servidores antigos.

O conserto é o **registro** (`mcps-semente.json`): ele guarda os nomes que esta máquina já
recebeu de fábrica. A cada abertura, o que está no padrão e **não** está no registro nem na
lista é acrescentado. Servidor que a pessoa apagou já está no registro, então não volta;
servidor que veio numa versão nova entra sozinho. O que ela editou continua exatamente como
ela deixou — o merge só **acrescenta**, nunca reescreve um item existente.

As **skills** não passam por aqui. Elas não são um arquivo de configuração: são pastas com
`SKILL.md` e um catálogo (`skills/skills.json`) que diz quais viajam. Quem lê isso é
`skills.listar` — copiar o conteúdo para dentro de um JSON duplicaria o texto e o faria
envelhecer em dois lugares. Por isso skill nova no pacote aparece sozinha: a leitura é da
pasta instalada, não de uma cópia no `data/`.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

#: A lista de servidores MCP que o Koda traz, na pasta `mcp/` do projeto — a mesma que o
#: instalador copia. Achada pelo lugar deste arquivo (`<koda>/backend/app/`), então a conta
#: `../../mcp` vale em dev e no instalado, sem variável de ambiente.
PADRAO_MCPS = Path(__file__).resolve().parent.parent.parent / "mcp" / "mcps.json"

#: O que já foi entregue de fábrica nesta máquina, ao lado do `mcps.json`. É o que separa
#: «servidor novo no pacote» de «servidor que a pessoa apagou» — sem ele, o merge traria de
#: volta todo servidor removido a cada abertura.
REGISTRO = "mcps-semente.json"


def _log(mensagem: str) -> None:
    """Vai para o `stdout` do backend, que o lançador grava em arquivo.

    É por aqui que se descobre, na máquina de quem instalou, por que o app subiu sem MCP —
    sem isto, um `mcps.json` que não deu para escrever viraria "o Painel Dev não tem
    ferramenta nenhuma" e ninguém saberia o motivo.
    """
    print(f"[koda] {mensagem}", flush=True)


def _ler_lista(caminho: Path) -> list[dict[str, Any]] | None:
    """Lê uma lista de servidores. `None` quando o arquivo não existe ou está ilegível.

    A distinção importa: ausente é "ainda não tem nada" (pode semear), ilegível é "alguém
    mexeu e quebrou" (não dá para saber o que havia, e escrever por cima apagaria a lista
    inteira da pessoa).
    """
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(dados, list):
        return None
    return [item for item in dados if isinstance(item, dict)]


def _nomes(itens: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("name", "")).strip() for item in itens if str(item.get("name", "")).strip()]


def _ler_registro(caminho: Path) -> set[str] | None:
    """Os nomes já entregues. `None` quando o registro ainda não existe (máquina antiga)."""
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(dados, list):
        return None
    return {str(nome) for nome in dados}


def _salvar_registro(caminho: Path, nomes: set[str]) -> None:
    try:
        caminho.parent.mkdir(parents=True, exist_ok=True)
        caminho.write_text(
            json.dumps(sorted(nomes), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError as exc:
        # Registro que não grava não impede o app de rodar: o pior que acontece é o merge
        # tentar de novo na próxima abertura (e reacrescentar o que a pessoa apagou).
        _log(f"não consegui gravar {caminho.name}: {exc}")


def semear(dados: Path) -> list[str]:
    """Escreve os padrões que faltam em `dados`. Devolve o nome do que mudou.

    `dados` é a pasta ao lado do banco (`settings.database_path.parent`) — a mesma que o
    gerenciador de MCP e a tela usam.
    """
    feitos: list[str] = []
    if semear_mcps(dados):
        feitos.append("mcps.json")
    return feitos


def semear_mcps(dados: Path) -> bool:
    """Cria o `data/mcps.json` e acrescenta os servidores que a versão nova trouxe.

    Devolve `True` quando o arquivo foi criado ou ganhou servidor — é o que faz o log da
    instalação dizer o que aconteceu, em vez de deixar "não tem MCP" sem explicação.
    """
    padrao = _ler_lista(PADRAO_MCPS)
    if not padrao:
        _log(f"sem lista padrão de MCP em {PADRAO_MCPS} — o app fica sem servidor MCP")
        return False

    destino = dados / "mcps.json"
    caminho_registro = dados / REGISTRO
    registro = _ler_registro(caminho_registro)

    # Primeira execução: o arquivo nasce igual ao padrão, e tudo o que veio nele fica
    # registrado como entregue.
    if not destino.exists():
        try:
            destino.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PADRAO_MCPS, destino)
        except OSError as exc:
            _log(f"não consegui escrever {destino}: {exc}")
            return False
        _salvar_registro(caminho_registro, set(_nomes(padrao)) | (registro or set()))
        _log(f"{destino.name} criado com {len(padrao)} servidor(es): {', '.join(_nomes(padrao))}")
        return True

    atuais = _ler_lista(destino)
    if atuais is None:
        # Arquivo torto: não é nosso para consertar. Sobrescrever apagaria a configuração de
        # quem estava no meio de uma edição — e "não tem MCP" é menos grave que "sumiu tudo".
        _log(f"{destino.name} está ilegível — não acrescentei nada (confira o JSON)")
        return False

    presentes = set(_nomes(atuais))
    if registro is None:
        # Máquina que veio de antes do registro existir: o que está na lista conta como já
        # entregue. Sem isto, o primeiro merge depois da atualização traria de volta tudo o
        # que a pessoa apagou desde a instalação original.
        registro = set(presentes)

    # Entra só o que é novo **no pacote e nesta máquina**: fora da lista (senão duplicaria)
    # e fora do registro (senão ressuscitaria o que a pessoa apagou).
    novos = [
        item
        for item in padrao
        if (nome := str(item.get("name", "")).strip()) not in presentes and nome not in registro
    ]
    if not novos:
        # Nada a acrescentar — mas os nomes do padrão passam a contar como entregues, para
        # uma remoção feita agora não ser desfeita na próxima abertura.
        _salvar_registro(caminho_registro, registro | set(_nomes(padrao)))
        return False

    atuais.extend(novos)
    try:
        destino.write_text(
            json.dumps(atuais, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError as exc:
        _log(f"não consegui acrescentar servidores em {destino}: {exc}")
        return False

    nomes_novos = _nomes(novos)
    _salvar_registro(caminho_registro, registro | set(_nomes(padrao)))
    _log(f"{destino.name}: {len(nomes_novos)} servidor(es) novo(s) do pacote: {', '.join(nomes_novos)}")
    return True
