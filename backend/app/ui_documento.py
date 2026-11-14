"""O protocolo Koda UI: documento JSON validado, nunca HTML nem JSX do modelo.

A interface inteligente do Koda tem dois caminhos:

* o DSL ```` ```koda-ui ```` (texto que o modelo escreve), interpretado no front;
* **este** — um documento JSON que o modelo entrega pela ferramenta
  `mostrar_interface`, e que o servidor valida antes de a tela desenhar.

O segundo existe porque cerca no texto depende de o modelo acertar a sintaxe. A
ferramenta é um contrato: o modelo preenche dados, o servidor recusa o que não presta e
a interface desenha o que passou. É o mesmo caminho do cartão de plano (`mostrar_plano`),
que funciona em qualquer provedor.

## O que este módulo garante

* **Envelope versionado** — `schemaVersion`, `documentId`, `messageId`, `revision`.
* **Árvore estrita** — tipos registrados, props conhecidas, IDs únicos, profundidade e
  número de nós limitados.
* **Ações declarativas** — `state.set`, `state.toggle`, `state.increment`, `state.calc`,
  `ui.setTab`, `copy`, `openUrl`, `issueNewTurn`, `form.submit`. Nada de função, `eval`
  ou JS no JSON.
* **Fronteira de confiança** — texto vira texto, URL só http/https (imagem também aceita
  `data:image`), sem `style`, `className`, `html` nem `dangerouslySetInnerHTML`.
* **Limites medidos** — 12 níveis, 250 nós, 256 KB de documento, 64 KB de estado.

O validador devolve o documento **normalizado** (nomes canônicos, defaults aplicados) e
uma lista de avisos. Documento inválido levanta `DocumentoInvalido` com uma frase que o
modelo consegue corrigir na chamada seguinte.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

#: Limites iniciais do protocolo. São guardrails medidos, não promessas de desempenho.
LIMITES = {
    "profundidade": 12,
    "nos": 250,
    "bytes": 256 * 1024,
    "texto": 4000,
    "texto_longo": 20000,
    "titulo": 200,
    "itens": 100,
    "linhas_tabela": 500,
    "colunas_tabela": 20,
    "pontos_grafico": 200,
    "estado_bytes": 64 * 1024,
    "acoes": 100,
    "filhos": 60,
}

_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_CHAVE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_ACAO_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
_CONTROLE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

SCHEMA_VERSION = "1.0"


class DocumentoInvalido(ValueError):
    """O documento não pode ser desenhado; a mensagem é para o modelo corrigir."""


@dataclass(frozen=True)
class Componente:
    """Um tipo do catálogo: filhos, props e obrigatórias."""

    nome: str
    filhos: bool = False
    max_filhos: int = 60
    props: tuple[str, ...] = ()
    obrigatorias: tuple[str, ...] = ()


#: Nomes aceitos (o modelo escreve em português, em inglês ou no nome canônico) e o
#: componente canônico que a interface desenha. Manter os apelidos é o que faz
#: `box`/`KodaBox`/`caixa` funcionarem sem o modelo precisar decorar o catálogo.
APELIDOS: dict[str, str] = {
    "box": "KodaBox", "caixa": "KodaBox",
    "row": "KodaRow", "linha": "KodaRow",
    "column": "KodaColumn", "col": "KodaColumn", "coluna": "KodaColumn",
    "grid": "KodaGrid", "grade": "KodaGrid",
    "card": "KodaCard", "cartao": "KodaCard",
    "title": "KodaTitle", "titulo": "KodaTitle",
    "text": "KodaText", "texto": "KodaText",
    "paragraph": "KodaParagraph", "paragrafo": "KodaParagraph",
    "caption": "KodaCaption", "legenda": "KodaCaption",
    "label": "KodaLabel", "rotulo": "KodaLabel",
    "badge": "KodaBadge", "selo": "KodaBadge",
    "alert": "KodaAlert", "alerta": "KodaAlert", "aviso": "KodaAlert",
    "callout": "KodaCallout", "destaque": "KodaCallout",
    "divider": "KodaDivider", "divisor": "KodaDivider",
    "spacer": "KodaSpacer", "espaco": "KodaSpacer",
    "list": "KodaList", "lista": "KodaList",
    "link": "KodaLink",
    "code": "KodaCodeBlock", "codigo": "KodaCodeBlock", "codeblock": "KodaCodeBlock",
    "image": "KodaImage", "imagem": "KodaImage",
    "table": "KodaTable", "tabela": "KodaTable",
    "metric": "KodaMetric", "metrica": "KodaMetric", "stat": "KodaMetric",
    "progress": "KodaProgress", "progresso": "KodaProgress",
    "button": "KodaButton", "botao": "KodaButton",
    "input": "KodaInput", "campo": "KodaInput",
    "textarea": "KodaTextarea", "areadetexto": "KodaTextarea",
    "checkbox": "KodaCheckbox",
    "radio": "KodaRadioGroup", "radiogroup": "KodaRadioGroup",
    "select": "KodaSelect", "selecao": "KodaSelect",
    "slider": "KodaSlider", "controle": "KodaSlider",
    "segmented": "KodaSegmentedControl", "segmentado": "KodaSegmentedControl",
    "form": "KodaForm", "formulario": "KodaForm",
    "pressable": "KodaPressable",
    "chart": "KodaChart", "grafico": "KodaChart",
    "tabs": "KodaTabs", "abas": "KodaTabs",
    "steps": "KodaSteps", "passos": "KodaSteps",
    "accordion": "KodaAccordion", "acordeao": "KodaAccordion",
    "carousel": "KodaCarousel", "carrossel": "KodaCarousel",
    "popover": "KodaPopover",
    "date": "KodaDatePicker", "data": "KodaDatePicker",
    "toggle": "KodaToggle", "interruptor": "KodaToggle",
    "suggestion": "KodaSuggestion", "sugestao": "KodaSuggestion",
    "quote": "KodaQuote", "citacao": "KodaQuote",
    "diff": "KodaDiff", "diferenca": "KodaDiff",
    "sources": "KodaSourceList", "fontes": "KodaSourceList",
    "video": "KodaVideo",
    "icon": "KodaIcon", "icone": "KodaIcon",
    "svg": "KodaSvg", "vetor": "KodaSvg",
    "diagram": "KodaDiagram", "diagrama": "KodaDiagram",
    "map": "KodaMap", "mapa": "KodaMap",
    "writing": "KodaWritingBlock", "escrita": "KodaWritingBlock",
    "sandbox": "KodaSandbox", "preview": "KodaSandbox",
    "appblock": "KodaAppBlock", "prototipo": "KodaAppBlock",
    "algorithm": "KodaAlgorithm", "algoritmo": "KodaAlgorithm",
    "citation": "KodaCitation", "referencia": "KodaCitation",
    "entity": "KodaEntity", "entidade": "KodaEntity",
    "calculator": "KodaCalculator", "calculadora": "KodaCalculator",
}

#: O catálogo. `props` são os nomes canônicos; a normalização aceita apelidos.
COMPONENTES: dict[str, Componente] = {
    "KodaBox": Componente("KodaBox", filhos=True, props=("padding", "gap")),
    "KodaRow": Componente("KodaRow", filhos=True, props=("gap",)),
    "KodaColumn": Componente("KodaColumn", filhos=True, props=("gap",)),
    "KodaGrid": Componente("KodaGrid", filhos=True, props=("cols", "gap")),
    "KodaCard": Componente("KodaCard", filhos=True, props=("titulo",)),
    "KodaTitle": Componente("KodaTitle", props=("texto", "nivel"), obrigatorias=("texto",)),
    "KodaText": Componente("KodaText", props=("texto",), obrigatorias=("texto",)),
    "KodaParagraph": Componente("KodaParagraph", props=("texto",), obrigatorias=("texto",)),
    "KodaCaption": Componente("KodaCaption", props=("texto",), obrigatorias=("texto",)),
    "KodaLabel": Componente("KodaLabel", filhos=True, props=("texto",), obrigatorias=("texto",)),
    "KodaBadge": Componente("KodaBadge", props=("texto", "tom"), obrigatorias=("texto",)),
    "KodaAlert": Componente("KodaAlert", props=("texto", "tom"), obrigatorias=("texto",)),
    "KodaCallout": Componente("KodaCallout", props=("texto", "tom"), obrigatorias=("texto",)),
    "KodaDivider": Componente("KodaDivider"),
    "KodaSpacer": Componente("KodaSpacer", props=("altura",)),
    "KodaList": Componente("KodaList", props=("itens", "ordenada"), obrigatorias=("itens",)),
    "KodaLink": Componente("KodaLink", props=("texto", "href"), obrigatorias=("texto", "href")),
    "KodaCodeBlock": Componente("KodaCodeBlock", props=("codigo", "linguagem"), obrigatorias=("codigo",)),
    "KodaImage": Componente("KodaImage", props=("src", "alt", "legenda"), obrigatorias=("src",)),
    "KodaTable": Componente("KodaTable", props=("colunas", "linhas"), obrigatorias=("colunas", "linhas")),
    "KodaMetric": Componente("KodaMetric", props=("rotulo", "valor", "variacao"), obrigatorias=("rotulo", "valor")),
    "KodaProgress": Componente("KodaProgress", props=("valor", "max"), obrigatorias=("valor",)),
    "KodaButton": Componente("KodaButton", props=("rotulo", "actionId", "variante", "desabilitado"), obrigatorias=("rotulo", "actionId")),
    "KodaInput": Componente("KodaInput", props=("rotulo", "placeholder", "valueBinding", "tipo"), obrigatorias=("valueBinding",)),
    "KodaTextarea": Componente("KodaTextarea", props=("rotulo", "placeholder", "valueBinding", "linhas"), obrigatorias=("valueBinding",)),
    "KodaCheckbox": Componente("KodaCheckbox", props=("rotulo", "valueBinding"), obrigatorias=("rotulo", "valueBinding")),
    "KodaRadioGroup": Componente("KodaRadioGroup", props=("rotulo", "opcoes", "valueBinding"), obrigatorias=("opcoes", "valueBinding")),
    "KodaSelect": Componente("KodaSelect", props=("rotulo", "opcoes", "valueBinding"), obrigatorias=("opcoes", "valueBinding")),
    "KodaSlider": Componente("KodaSlider", props=("rotulo", "min", "max", "passo", "valueBinding"), obrigatorias=("valueBinding",)),
    "KodaSegmentedControl": Componente("KodaSegmentedControl", props=("opcoes", "valueBinding"), obrigatorias=("opcoes", "valueBinding")),
    "KodaForm": Componente("KodaForm", filhos=True, props=("actionId", "botao")),
    "KodaPressable": Componente("KodaPressable", filhos=True, props=("actionId",), obrigatorias=("actionId",)),
    "KodaChart": Componente("KodaChart", props=("tipo", "dados", "titulo"), obrigatorias=("dados",)),
    "KodaTabs": Componente("KodaTabs", filhos=True, props=("abas",), obrigatorias=("abas",)),
    "KodaSteps": Componente("KodaSteps", props=("itens",), obrigatorias=("itens",)),
    "KodaAccordion": Componente("KodaAccordion", filhos=True, props=("titulo",), obrigatorias=("titulo",)),
    "KodaCarousel": Componente("KodaCarousel", props=("itens",), obrigatorias=("itens",)),
    "KodaPopover": Componente("KodaPopover", filhos=True, props=("rotulo",), obrigatorias=("rotulo",)),
    "KodaDatePicker": Componente("KodaDatePicker", props=("rotulo", "valueBinding"), obrigatorias=("valueBinding",)),
    "KodaToggle": Componente("KodaToggle", props=("rotulo", "valueBinding"), obrigatorias=("rotulo", "valueBinding")),
    "KodaSuggestion": Componente("KodaSuggestion", props=("texto", "actionId"), obrigatorias=("texto", "actionId")),
    "KodaQuote": Componente("KodaQuote", props=("texto", "autor"), obrigatorias=("texto",)),
    "KodaDiff": Componente("KodaDiff", props=("antes", "depois"), obrigatorias=("antes", "depois")),
    "KodaSourceList": Componente("KodaSourceList", props=("fontes",), obrigatorias=("fontes",)),
    "KodaVideo": Componente("KodaVideo", props=("src", "poster", "legenda"), obrigatorias=("src",)),
    "KodaIcon": Componente("KodaIcon", props=("nome", "tamanho", "rotulo")),
    "KodaSvg": Componente("KodaSvg", props=("formas", "viewBox", "titulo"), obrigatorias=("formas",)),
    "KodaDiagram": Componente("KodaDiagram", props=("nos", "ligacoes", "titulo"), obrigatorias=("nos",)),
    "KodaMap": Componente("KodaMap", props=("pontos", "titulo"), obrigatorias=("pontos",)),
    "KodaWritingBlock": Componente("KodaWritingBlock", props=("titulo", "valueBinding", "linhas"), obrigatorias=("valueBinding",)),
    "KodaSandbox": Componente("KodaSandbox", props=("html", "css", "js", "titulo", "altura")),
    "KodaAppBlock": Componente("KodaAppBlock", props=("html", "css", "js", "titulo", "altura")),
    "KodaAlgorithm": Componente("KodaAlgorithm", props=("titulo", "passos"), obrigatorias=("passos",)),
    "KodaCitation": Componente("KodaCitation", props=("texto", "fonte", "url"), obrigatorias=("texto",)),
    "KodaEntity": Componente("KodaEntity", props=("tipo", "nome", "detalhe", "url"), obrigatorias=("nome",)),
    "KodaCalculator": Componente("KodaCalculator", props=("titulo", "campos", "formula", "unidade", "casas"), obrigatorias=("campos", "formula")),
}

#: Ações declarativas permitidas. O dispatcher do front implementa cada uma em código
#: confiável; o JSON nunca carrega função.
ACOES: dict[str, tuple[str, ...]] = {
    "state.set": ("key", "value"),
    "state.toggle": ("key",),
    "state.increment": ("key", "amount"),
    "state.calc": ("key", "expression", "value"),
    "ui.setTab": ("key", "value"),
    "copy": ("text", "fromState"),
    "openUrl": ("url",),
    "issueNewTurn": ("text", "fromState"),
    "form.submit": ("mensagem", "fromState"),
}

#: Props que nunca podem chegar: são a porta do HTML/CSS/JS arbitrário.
#:
#: `onClick`/`onChange`/`onSubmit` **não** entram aqui: em JSON eles só podem ser o nome
#: de uma ação ou de uma chave de estado, e a normalização os converte para `actionId` /
#: `valueBinding` antes de qualquer uso. O que não pode é `style`, `className`, HTML ou
#: uma função — e função não existe em JSON.
PROIBIDAS = {
    "style", "className", "class", "html", "dangerouslySetInnerHTML",
    "script", "js", "javascript",
}

#: Apelidos de props que a normalização aceita.
_PROPS_APELIDOS = {
    "text": "texto", "value": "texto", "valor": "texto", "conteudo": "texto",
    "title": "titulo", "header": "titulo",
    "label": "rotulo", "caption": "legenda",
    "options": "opcoes", "items": "itens", "lista": "itens",
    "columns": "colunas", "rows": "linhas",
    "src": "src", "url": "src", "href": "href",
    "code": "codigo", "language": "linguagem", "lang": "linguagem",
    "action": "actionId", "acao": "actionId", "onClick": "actionId", "onSubmit": "actionId",
    "binding": "valueBinding", "estado": "valueBinding", "valueKey": "valueBinding",
    "onChange": "valueBinding",
    "disabled": "desabilitado", "variant": "variante",
    "before": "antes", "after": "depois", "old": "antes", "new": "depois",
    "sources": "fontes", "author": "autor",
    "cols": "cols", "columnsCount": "cols",
    "name": "nome", "icon": "nome", "icone": "nome", "size": "tamanho",
    "shapes": "formas", "viewbox": "viewBox", "viewBox": "viewBox",
    "nodes": "nos", "edges": "ligacoes", "links": "ligacoes",
    "points": "pontos", "steps": "passos", "formula": "formula",
    "fields": "campos", "decimals": "casas", "unit": "unidade",
    "detail": "detalhe", "kind": "tipo",
}


def _texto(valor: Any, limite: int = LIMITES["texto"], campo: str = "texto") -> str:
    if not isinstance(valor, (str, int, float, bool)):
        raise DocumentoInvalido(f"`{campo}` precisa ser texto.")
    texto = _CONTROLE.sub("", str(valor))
    if len(texto) > limite:
        raise DocumentoInvalido(f"`{campo}` passou de {limite} caracteres.")
    return texto


def _inteiro(valor: Any, minimo: int, maximo: int, campo: str) -> int:
    try:
        numero = int(valor)
    except (TypeError, ValueError) as exc:
        raise DocumentoInvalido(f"`{campo}` precisa ser inteiro.") from exc
    if numero < minimo or numero > maximo:
        raise DocumentoInvalido(f"`{campo}` precisa estar entre {minimo} e {maximo}.")
    return numero


def _numero(valor: Any, campo: str) -> float:
    if isinstance(valor, bool):
        raise DocumentoInvalido(f"`{campo}` precisa ser número.")
    try:
        numero = float(valor)
    except (TypeError, ValueError) as exc:
        raise DocumentoInvalido(f"`{campo}` precisa ser número.") from exc
    if numero != numero or numero in (float("inf"), float("-inf")):
        raise DocumentoInvalido(f"`{campo}` precisa ser um número finito.")
    return numero


def _booleano(valor: Any, campo: str) -> bool:
    if isinstance(valor, bool):
        return valor
    if isinstance(valor, str) and valor.lower() in {"true", "false"}:
        return valor.lower() == "true"
    raise DocumentoInvalido(f"`{campo}` precisa ser verdadeiro ou falso.")


def _lista_de_texto(valor: Any, campo: str, limite: int = LIMITES["itens"]) -> list[str]:
    if not isinstance(valor, list):
        raise DocumentoInvalido(f"`{campo}` precisa ser uma lista.")
    if len(valor) > limite:
        raise DocumentoInvalido(f"`{campo}` passou de {limite} itens.")
    return [_texto(item, LIMITES["texto"], f"{campo}[{i}]") for i, item in enumerate(valor)]


def _url(valor: Any, campo: str, *, imagem: bool = False) -> str:
    texto = _texto(valor, 2000, campo).strip()
    if not texto:
        raise DocumentoInvalido(f"`{campo}` está vazio.")
    if imagem and texto.startswith("data:image/"):
        if len(texto.encode()) > 200 * 1024:
            raise DocumentoInvalido(f"`{campo}`: imagem embutida passou de 200 KB.")
        if not re.match(r"^data:image/(png|jpeg|jpg|webp|gif);base64,", texto):
            raise DocumentoInvalido(f"`{campo}`: formato de imagem embutida não permitido.")
        return texto
    try:
        partes = urlparse(texto)
    except ValueError as exc:
        raise DocumentoInvalido(f"`{campo}` não é um endereço válido.") from exc
    if partes.scheme.lower() not in {"http", "https", "mailto"} or not partes.netloc and partes.scheme.lower() != "mailto":
        raise DocumentoInvalido(f"`{campo}` só aceita http, https ou mailto.")
    if partes.username or partes.password:
        raise DocumentoInvalido(f"`{campo}` não pode carregar credenciais.")
    return texto


def _valor_json(valor: Any, profundidade: int = 0) -> Any:
    """Estado: só JSON simples, com profundidade limitada (sem função, bytes, NaN)."""
    if profundidade > 3:
        raise DocumentoInvalido("o estado passou de 3 níveis de profundidade.")
    if valor is None or isinstance(valor, (str, int, float, bool)):
        if isinstance(valor, float) and (valor != valor or valor in (float("inf"), float("-inf"))):
            raise DocumentoInvalido("o estado tem um número inválido.")
        if isinstance(valor, str) and len(valor) > LIMITES["texto"]:
            raise DocumentoInvalido("o estado tem texto longo demais.")
        return valor
    if isinstance(valor, list):
        if len(valor) > LIMITES["itens"]:
            raise DocumentoInvalido("o estado tem uma lista longa demais.")
        return [_valor_json(item, profundidade + 1) for item in valor]
    if isinstance(valor, dict):
        if len(valor) > 40:
            raise DocumentoInvalido("o estado tem um objeto com chaves demais.")
        saida: dict[str, Any] = {}
        for chave, item in valor.items():
            if not isinstance(chave, str) or not _CHAVE.match(chave):
                raise DocumentoInvalido("o estado tem uma chave inválida.")
            saida[chave] = _valor_json(item, profundidade + 1)
        return saida
    raise DocumentoInvalido("o estado só aceita valores JSON.")


def _validar_estado(bruto: Any) -> dict[str, Any]:
    if bruto is None:
        return {}
    if not isinstance(bruto, dict):
        raise DocumentoInvalido("`state` precisa ser um objeto.")
    estado: dict[str, Any] = {}
    for chave, valor in bruto.items():
        if not isinstance(chave, str) or not _CHAVE.match(chave):
            raise DocumentoInvalido(f"chave de estado inválida: {chave!r}.")
        estado[chave] = _valor_json(valor)
    if len(json.dumps(estado, ensure_ascii=False).encode()) > LIMITES["estado_bytes"]:
        raise DocumentoInvalido("`state` passou de 64 KB.")
    return estado


def _validar_acoes(bruto: Any, estado: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if bruto is None:
        return {}
    if not isinstance(bruto, dict):
        raise DocumentoInvalido("`actions` precisa ser um objeto.")
    if len(bruto) > LIMITES["acoes"]:
        raise DocumentoInvalido(f"`actions` passou de {LIMITES['acoes']} ações.")
    acoes: dict[str, dict[str, Any]] = {}
    for identificador, acao in bruto.items():
        if not isinstance(identificador, str) or not _ACAO_ID.match(identificador):
            raise DocumentoInvalido(f"id de ação inválido: {identificador!r}.")
        if not isinstance(acao, dict):
            raise DocumentoInvalido(f"a ação `{identificador}` precisa ser um objeto.")
        tipo = str(acao.get("kind") or acao.get("tipo") or "").strip()
        if tipo not in ACOES:
            raise DocumentoInvalido(
                f"a ação `{identificador}` tem tipo desconhecido ({tipo!r}). "
                f"Disponíveis: {', '.join(sorted(ACOES))}."
            )
        # Os modelos trocam `text` por `mensagem` (e vice-versa) com frequência. Aceitar
        # os dois é o que faz a ação funcionar em vez de a tela inteira ser recusada.
        if tipo in {"copy", "issueNewTurn"} and "text" not in acao and isinstance(acao.get("mensagem"), str):
            acao = {**acao, "text": acao["mensagem"]}
        if tipo == "form.submit" and "mensagem" not in acao and isinstance(acao.get("text"), str):
            acao = {**acao, "mensagem": acao["text"]}
        if tipo == "state.calc" and "expression" not in acao and isinstance(acao.get("value"), str):
            acao = {**acao, "expression": acao["value"]}
        normalizada: dict[str, Any] = {"kind": tipo}
        for campo in ACOES[tipo]:
            if campo not in acao:
                continue
            valor = acao[campo]
            if campo in {"key", "fromState"}:
                chave = str(valor or "")
                if not _CHAVE.match(chave):
                    raise DocumentoInvalido(f"a ação `{identificador}` aponta para uma chave inválida.")
                if chave not in estado:
                    raise DocumentoInvalido(
                        f"a ação `{identificador}` usa `{chave}`, que não existe em `state`."
                    )
                normalizada[campo] = chave
            elif campo == "value":
                normalizada[campo] = _valor_json(valor)
            elif campo == "amount":
                normalizada[campo] = _numero(valor, f"actions.{identificador}.amount")
            elif campo == "expression":
                expressao = _texto(valor, 300, f"actions.{identificador}.expression")
                if not re.fullmatch(r"[0-9A-Za-z_+\-*/%().\s]{1,300}", expressao):
                    raise DocumentoInvalido(
                        f"a ação `{identificador}` tem fórmula com caracteres não permitidos."
                    )
                for referencia in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expressao):
                    if referencia not in estado:
                        raise DocumentoInvalido(
                            f"a fórmula da ação `{identificador}` usa `{referencia}`, "
                            "que não existe em `state`."
                        )
                normalizada[campo] = expressao
            elif campo == "url":
                normalizada[campo] = _url(valor, f"actions.{identificador}.url")
            elif campo in {"text", "mensagem"}:
                normalizada[campo] = _texto(valor, LIMITES["texto"], f"actions.{identificador}.{campo}")
        if tipo in {"copy", "issueNewTurn"} and not (normalizada.get("text") or normalizada.get("fromState")):
            raise DocumentoInvalido(f"a ação `{identificador}` precisa de `text` ou `fromState`.")
        if tipo == "state.calc" and not normalizada.get("expression"):
            raise DocumentoInvalido(f"a ação `{identificador}` precisa de `expression`.")
        acoes[identificador] = normalizada
    return acoes


def _normalizar_props(
    componente: Componente, bruto: Any, estado: dict[str, Any], acoes: dict[str, Any]
) -> tuple[dict[str, Any], list[str]]:
    if bruto is None:
        bruto = {}
    if not isinstance(bruto, dict):
        raise DocumentoInvalido(f"`props` de {componente.nome} precisa ser um objeto.")
    avisos: list[str] = []
    props: dict[str, Any] = {}
    # Campos de formulário usam `value`/`valor` para dizer **qual chave de estado** eles
    # editam, não o texto exibido. Sem esta exceção, `{"type":"KodaInput","value":"nome"}`
    # virava `texto: "nome"` e o campo ficava sem vínculo — foi o erro que o GPT-6 Luna
    # cometeu no primeiro teste do formulário (05/11/2026).
    campos = {
        "KodaInput", "KodaTextarea", "KodaCheckbox", "KodaRadioGroup", "KodaSelect",
        "KodaSlider", "KodaSegmentedControl", "KodaDatePicker", "KodaToggle",
        "KodaWritingBlock",
    }
    sandbox = componente.nome in {"KodaSandbox", "KodaAppBlock"}
    for chave, valor in bruto.items():
        if componente.nome in campos and chave in {"value", "valor", "key", "chave"}:
            nome = "valueBinding"
        elif chave in componente.props:
            # A prop já é canônica neste componente (`url` de KodaCitation, por exemplo);
            # os apelidos globais não podem sequestrá-la.
            nome = chave
        else:
            nome = _PROPS_APELIDOS.get(chave, chave)
        if (chave in PROIBIDAS or nome in PROIBIDAS) and not (
            sandbox and chave in {"html", "js"}
        ):
            raise DocumentoInvalido(f"`{chave}` não é permitido no protocolo Koda UI.")
        # `aba` é uma dica de layout dos filhos de KodaTabs: o renderer mostra só os
        # filhos cuja aba está ativa. Não é estilo nem comportamento — é agrupamento.
        if nome == "aba":
            props["aba"] = _texto(valor, 120, "aba")
            continue
        if nome not in componente.props:
            avisos.append(f"{componente.nome}: prop `{chave}` ignorada")
            continue
        props[nome] = valor

    # ---- normalizações por componente (tipos, faixas e apelidos) -------------------
    nome = componente.nome
    if nome in {"KodaTitle", "KodaText", "KodaParagraph", "KodaCaption", "KodaLabel",
                "KodaBadge", "KodaAlert", "KodaCallout", "KodaQuote", "KodaSuggestion"}:
        props["texto"] = _texto(props.get("texto", ""), LIMITES["texto"], "texto")
    if nome == "KodaTitle":
        props["nivel"] = _inteiro(props.get("nivel", 3), 1, 4, "nivel")
    if nome in {"KodaBadge", "KodaAlert", "KodaCallout"}:
        tom = str(props.get("tom", "info")).lower()
        permitidos = {"neutro", "ok", "aviso", "erro", "info", "dica"} if nome != "KodaBadge" else {"neutro", "ok", "aviso", "erro"}
        if tom not in permitidos:
            tom = "info" if nome != "KodaBadge" else "neutro"
        props["tom"] = tom
    if nome in {"KodaBox", "KodaRow", "KodaColumn", "KodaGrid"}:
        if "padding" in props:
            props["padding"] = _inteiro(props["padding"], 0, 8, "padding")
        if "gap" in props:
            props["gap"] = _inteiro(props["gap"], 0, 8, "gap")
        if "cols" in props:
            props["cols"] = _inteiro(props["cols"], 1, 6, "cols")
    if nome == "KodaCard":
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
    if nome == "KodaSpacer":
        props["altura"] = _inteiro(props.get("altura", 8), 0, 64, "altura")
    if nome == "KodaList":
        props["itens"] = _lista_de_texto(props.get("itens", []), "itens")
        if "ordenada" in props:
            props["ordenada"] = _booleano(props["ordenada"], "ordenada")
    if nome == "KodaLink":
        props["texto"] = _texto(props.get("texto", ""), LIMITES["titulo"], "texto")
        props["href"] = _url(props.get("href", ""), "href")
    if nome == "KodaCodeBlock":
        props["codigo"] = _texto(props.get("codigo", ""), LIMITES["texto_longo"], "codigo")
        props["linguagem"] = _texto(props.get("linguagem", ""), 40, "linguagem")
    if nome == "KodaImage":
        props["src"] = _url(props.get("src", ""), "src", imagem=True)
        props["alt"] = _texto(props.get("alt", ""), LIMITES["titulo"], "alt")
        if "legenda" in props:
            props["legenda"] = _texto(props["legenda"], 500, "legenda")
    if nome == "KodaVideo":
        props["src"] = _url(props.get("src", ""), "src")
        if "poster" in props:
            props["poster"] = _url(props["poster"], "poster", imagem=True)
        if "legenda" in props:
            props["legenda"] = _texto(props["legenda"], 500, "legenda")
    if nome == "KodaTable":
        colunas = _lista_de_texto(props.get("colunas", []), "colunas", LIMITES["colunas_tabela"])
        linhas_brutas = props.get("linhas", [])
        if not isinstance(linhas_brutas, list):
            raise DocumentoInvalido("`linhas` precisa ser uma lista.")
        if len(linhas_brutas) > LIMITES["linhas_tabela"]:
            raise DocumentoInvalido(f"`linhas` passou de {LIMITES['linhas_tabela']} linhas.")
        linhas: list[list[Any]] = []
        for i, linha in enumerate(linhas_brutas):
            if not isinstance(linha, list):
                raise DocumentoInvalido(f"a linha {i} da tabela precisa ser uma lista.")
            if len(linha) > LIMITES["colunas_tabela"]:
                raise DocumentoInvalido(f"a linha {i} passou de {LIMITES['colunas_tabela']} células.")
            linhas.append([
                None if celula is None else _texto(celula, 1000, f"linhas[{i}]")
                for celula in linha
            ])
        props["colunas"], props["linhas"] = colunas, linhas
    if nome == "KodaMetric":
        props["rotulo"] = _texto(props.get("rotulo", ""), 120, "rotulo")
        props["valor"] = _texto(props.get("valor", ""), 120, "valor")
        if "variacao" in props:
            props["variacao"] = _texto(props["variacao"], 120, "variacao")
    if nome == "KodaProgress":
        props["valor"] = _numero(props.get("valor", 0), "valor")
        props["max"] = _numero(props.get("max", 100), "max")
        if props["max"] <= 0:
            raise DocumentoInvalido("`max` do progresso precisa ser maior que zero.")
    if nome == "KodaButton":
        props["rotulo"] = _texto(props.get("rotulo", ""), 120, "rotulo")
        if not props["rotulo"]:
            raise DocumentoInvalido("o botão precisa de `rotulo` (o texto visível).")
        acao = str(props.get("actionId", ""))
        if acao not in acoes:
            raise DocumentoInvalido(f"o botão aponta para a ação `{acao}`, que não existe.")
        props["actionId"] = acao
        variante = str(props.get("variante", "primario")).lower()
        props["variante"] = variante if variante in {"primario", "secundario", "discreto"} else "primario"
        if "desabilitado" in props:
            props["desabilitado"] = _booleano(props["desabilitado"], "desabilitado")
    if nome in {"KodaInput", "KodaTextarea", "KodaCheckbox", "KodaRadioGroup", "KodaSelect",
                "KodaSlider", "KodaSegmentedControl", "KodaDatePicker", "KodaToggle",
                "KodaWritingBlock"}:
        chave = props.get("valueBinding")
        if isinstance(chave, dict):
            chave = chave.get("key")
        chave = str(chave or "")
        if not _CHAVE.match(chave):
            raise DocumentoInvalido(f"{nome}: `valueBinding` precisa ser o nome de uma chave de `state`.")
        if chave not in estado:
            # O modelo esqueceu de declarar o valor inicial: cria com o default do campo,
            # em vez de derrubar a interface inteira. Fica registrado no aviso.
            estado[chave] = False if nome in {"KodaCheckbox", "KodaToggle"} else 0 if nome == "KodaSlider" else ""
            avisos.append(f"{nome}: estado `{chave}` criado com valor inicial")
        props["valueBinding"] = chave
        if "rotulo" in props:
            props["rotulo"] = _texto(props["rotulo"], 200, "rotulo")
        if "placeholder" in props:
            props["placeholder"] = _texto(props["placeholder"], 200, "placeholder")
    if nome in {"KodaRadioGroup", "KodaSelect", "KodaSegmentedControl"}:
        props["opcoes"] = _lista_de_texto(props.get("opcoes", []), "opcoes", 100 if nome == "KodaSelect" else 30)
    if nome == "KodaSlider":
        props["min"] = _numero(props.get("min", 0), "min")
        props["max"] = _numero(props.get("max", 100), "max")
        props["passo"] = _numero(props.get("passo", 1), "passo")
        if props["max"] <= props["min"]:
            raise DocumentoInvalido("`max` do slider precisa ser maior que `min`.")
        if props["passo"] <= 0:
            raise DocumentoInvalido("`passo` do slider precisa ser maior que zero.")
    if nome == "KodaForm":
        acao = str(props.get("actionId", "") or "")
        if acao and acao not in acoes:
            raise DocumentoInvalido(f"o formulário aponta para a ação `{acao}`, que não existe.")
        if acao:
            props["actionId"] = acao
        else:
            # Sem ação no formulário, os botões dos filhos é que agem. O renderer não
            # desenha o botão de envio embutido — melhor um formulário sem botão extra do
            # que uma tela recusada por um campo que o modelo esqueceu.
            props.pop("actionId", None)
            avisos.append("KodaForm sem `actionId`: usando os botões dos filhos")
        props["botao"] = _texto(props.get("botao", "Enviar"), 80, "botao")
    if nome == "KodaPressable":
        acao = str(props.get("actionId", ""))
        if acao not in acoes:
            raise DocumentoInvalido(f"o pressable aponta para a ação `{acao}`, que não existe.")
        props["actionId"] = acao
    if nome == "KodaChart":
        tipo = str(props.get("tipo", "barras")).lower()
        if tipo not in {"barras", "linhas", "pizza"}:
            raise DocumentoInvalido("`tipo` do gráfico precisa ser barras, linhas ou pizza.")
        dados = props.get("dados", [])
        if not isinstance(dados, list) or not dados:
            raise DocumentoInvalido("o gráfico precisa de `dados` (lista com rotulo e valor).")
        if len(dados) > LIMITES["pontos_grafico"]:
            raise DocumentoInvalido(f"o gráfico passou de {LIMITES['pontos_grafico']} pontos.")
        normalizados: list[dict[str, Any]] = []
        for i, ponto in enumerate(dados):
            if not isinstance(ponto, dict):
                raise DocumentoInvalido(f"o ponto {i} do gráfico precisa ser um objeto.")
            normalizados.append({
                "rotulo": _texto(ponto.get("rotulo", ponto.get("label", "")), 120, f"dados[{i}].rotulo"),
                "valor": _numero(ponto.get("valor", ponto.get("value", 0)), f"dados[{i}].valor"),
            })
        props["tipo"], props["dados"] = tipo, normalizados
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
    if nome == "KodaTabs":
        props["abas"] = _lista_de_texto(props.get("abas", []), "abas", 10)
    if nome == "KodaSteps":
        props["itens"] = _lista_de_texto(props.get("itens", []), "itens", 20)
    if nome == "KodaAccordion":
        props["titulo"] = _texto(props.get("titulo", ""), LIMITES["titulo"], "titulo")
    if nome == "KodaCarousel":
        props["itens"] = _lista_de_texto(props.get("itens", []), "itens", 20)
    if nome == "KodaPopover":
        props["rotulo"] = _texto(props.get("rotulo", ""), 120, "rotulo")
    if nome == "KodaSuggestion":
        props["texto"] = _texto(props.get("texto", ""), 300, "texto")
        acao = str(props.get("actionId", ""))
        if acao not in acoes:
            raise DocumentoInvalido(f"a sugestão aponta para a ação `{acao}`, que não existe.")
        props["actionId"] = acao
    if nome == "KodaDiff":
        props["antes"] = _texto(props.get("antes", ""), LIMITES["texto_longo"], "antes")
        props["depois"] = _texto(props.get("depois", ""), LIMITES["texto_longo"], "depois")
    if nome == "KodaSourceList":
        fontes = props.get("fontes", [])
        if not isinstance(fontes, list) or len(fontes) > 20:
            raise DocumentoInvalido("`fontes` precisa ser uma lista de até 20 itens.")
        props["fontes"] = [
            {
                "titulo": _texto(fonte.get("titulo", fonte.get("title", "")), 300, f"fontes[{i}].titulo"),
                "url": _url(fonte.get("url", ""), f"fontes[{i}].url"),
            }
            for i, fonte in enumerate(fontes)
            if isinstance(fonte, dict)
        ]
    if nome == "KodaIcon":
        props["nome"] = _texto(props.get("nome", "circulo"), 40, "nome").lower() or "circulo"
        props["tamanho"] = _inteiro(props.get("tamanho", 20), 12, 64, "tamanho")
        if "rotulo" in props:
            props["rotulo"] = _texto(props["rotulo"], 120, "rotulo")
    if nome == "KodaSvg":
        props["formas"], props["viewBox"], props["titulo"] = _normalizar_formas(
            props.get("formas", []), props.get("viewBox", "0 0 320 180"),
            props.get("titulo", ""),
        )
    if nome == "KodaDiagram":
        props["nos"], props["ligacoes"] = _normalizar_diagrama(
            props.get("nos", []), props.get("ligacoes", []), avisos
        )
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
    if nome == "KodaMap":
        props["pontos"] = _normalizar_pontos_mapa(props.get("pontos", []))
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
    if nome == "KodaWritingBlock":
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
        props["linhas"] = _inteiro(props.get("linhas", 6), 3, 20, "linhas")
    if nome in {"KodaSandbox", "KodaAppBlock"}:
        html = _texto(props.get("html", ""), 100_000, "html")
        css = _texto(props.get("css", ""), 30_000, "css")
        js = _texto(props.get("js", ""), 30_000, "js")
        if len((html + css + js).encode()) > 120 * 1024:
            raise DocumentoInvalido("o sandbox passou de 120 KB.")
        props["html"], props["css"], props["js"] = html, css, js
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
        props["altura"] = _inteiro(props.get("altura", 320), 120, 720, "altura")
    if nome == "KodaAlgorithm":
        props["passos"] = _normalizar_passos(props.get("passos", []))
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
    if nome == "KodaCitation":
        props["texto"] = _texto(props.get("texto", ""), LIMITES["texto"], "texto")
        if not props["texto"]:
            raise DocumentoInvalido("a citação precisa de `texto`.")
        if "fonte" in props:
            props["fonte"] = _texto(props["fonte"], 300, "fonte")
        if "url" in props:
            props["url"] = _url(props["url"], "url")
    if nome == "KodaEntity":
        props["tipo"] = _texto(props.get("tipo", "arquivo"), 40, "tipo").lower() or "arquivo"
        props["nome"] = _texto(props.get("nome", ""), LIMITES["titulo"], "nome")
        if not props["nome"]:
            raise DocumentoInvalido("a entidade precisa de `nome`.")
        if "detalhe" in props:
            props["detalhe"] = _texto(props["detalhe"], 500, "detalhe")
        if "url" in props:
            props["url"] = _url(props["url"], "url")
    if nome == "KodaCalculator":
        props["campos"] = _normalizar_campos_calculo(
            props.get("campos", []), estado, avisos
        )
        formula = _texto(props.get("formula", ""), 300, "formula")
        if not re.fullmatch(r"[0-9A-Za-z_+\-*/%().\s]{1,300}", formula):
            raise DocumentoInvalido(
                "`formula` só aceita números, chaves de `state`, parênteses e + - * / %."
            )
        for referencia in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", formula):
            if referencia not in estado:
                raise DocumentoInvalido(
                    f"`formula` usa `{referencia}`, que não existe em `state`."
                )
        props["formula"] = formula
        if "titulo" in props:
            props["titulo"] = _texto(props["titulo"], LIMITES["titulo"], "titulo")
        if "unidade" in props:
            props["unidade"] = _texto(props["unidade"], 40, "unidade")
        props["casas"] = _inteiro(props.get("casas", 2), 0, 6, "casas")
    return props, avisos


def _normalizar_formas(bruto: Any, view_box: Any, titulo: Any) -> tuple[list[dict[str, Any]], str, str]:
    if not isinstance(bruto, list) or not bruto:
        raise DocumentoInvalido("`formas` do SVG precisa ser uma lista com pelo menos uma forma.")
    if len(bruto) > 120:
        raise DocumentoInvalido("o SVG passou de 120 formas.")
    caixa = _texto(view_box, 80, "viewBox").strip()
    if not re.fullmatch(r"-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?){3}", caixa):
        caixa = "0 0 320 180"
    formas: list[dict[str, Any]] = []
    for i, forma in enumerate(bruto):
        if not isinstance(forma, dict):
            raise DocumentoInvalido(f"a forma {i} do SVG precisa ser um objeto.")
        tipo = str(forma.get("tipo") or forma.get("type") or "").lower()
        tipo = {
            "line": "linha", "kodasvgline": "linha",
            "circle": "circulo", "kodasvgcircle": "circulo",
            "rect": "retangulo", "rectangle": "retangulo", "kodasvgrect": "retangulo",
            "text": "texto", "kodasvgtext": "texto",
            "path": "caminho", "kodasvgpath": "caminho",
            "polygon": "poligono", "kodasvgpolygon": "poligono",
        }.get(tipo, tipo)
        if tipo not in {"linha", "circulo", "retangulo", "texto", "caminho", "poligono"}:
            raise DocumentoInvalido(f"a forma {i} tem tipo desconhecido ({tipo!r}).")
        item: dict[str, Any] = {"tipo": tipo}
        if tipo == "linha":
            for campo in ("x1", "y1", "x2", "y2"):
                item[campo] = _numero(forma.get(campo, 0), f"formas[{i}].{campo}")
            item["espessura"] = _numero(forma.get("espessura", 2), f"formas[{i}].espessura")
        elif tipo == "circulo":
            for campo in ("cx", "cy", "r"):
                item[campo] = _numero(forma.get(campo, 0), f"formas[{i}].{campo}")
        elif tipo == "retangulo":
            item["x"] = _numero(forma.get("x", 0), f"formas[{i}].x")
            item["y"] = _numero(forma.get("y", 0), f"formas[{i}].y")
            item["largura"] = _numero(
                forma.get("largura", forma.get("width", 10)), f"formas[{i}].largura"
            )
            item["altura"] = _numero(
                forma.get("altura", forma.get("height", 10)), f"formas[{i}].altura"
            )
            item["rx"] = _numero(forma.get("rx", 2), f"formas[{i}].rx")
        elif tipo == "texto":
            item["texto"] = _texto(forma.get("texto", ""), 200, f"formas[{i}].texto")
            item["x"] = _numero(forma.get("x", 0), f"formas[{i}].x")
            item["y"] = _numero(forma.get("y", 0), f"formas[{i}].y")
            item["tamanho"] = _numero(forma.get("tamanho", 12), f"formas[{i}].tamanho")
        elif tipo == "caminho":
            caminho = _texto(forma.get("d", ""), 2000, f"formas[{i}].d")
            if not re.fullmatch(r"[0-9MmLlHhVvCcSsQqTtAaZz,.\s+-]{1,2000}", caminho):
                raise DocumentoInvalido(f"o caminho {i} do SVG tem caracteres não permitidos.")
            item["d"] = caminho
            item["espessura"] = _numero(forma.get("espessura", 2), f"formas[{i}].espessura")
        elif tipo == "poligono":
            pontos = _texto(forma.get("pontos", ""), 800, f"formas[{i}].pontos")
            if not re.fullmatch(r"[0-9,.\s+-]{1,800}", pontos):
                raise DocumentoInvalido(f"o polígono {i} do SVG tem caracteres não permitidos.")
            item["pontos"] = pontos
        if "cor" in forma:
            item["cor"] = _texto(forma["cor"], 20, f"formas[{i}].cor")
        formas.append(item)
    return formas, caixa, _texto(titulo, LIMITES["titulo"], "titulo")


def _normalizar_diagrama(
    nos_brutos: Any, ligacoes_brutas: Any, avisos: list[str]
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    if isinstance(nos_brutos, dict):
        nos_brutos = [{"id": chave, "rotulo": valor} for chave, valor in nos_brutos.items()]
    if not isinstance(nos_brutos, list) or not nos_brutos:
        raise DocumentoInvalido("o diagrama precisa de `nos` (lista).")
    if len(nos_brutos) > 40:
        raise DocumentoInvalido("o diagrama passou de 40 nós.")
    nos: list[dict[str, str]] = []
    vistos: set[str] = set()
    for i, no in enumerate(nos_brutos):
        if isinstance(no, str):
            identificador, rotulo = f"n{i}", no
        elif isinstance(no, dict):
            identificador = str(no.get("id") or f"n{i}")
            rotulo = str(no.get("rotulo") or no.get("label") or identificador)
        else:
            raise DocumentoInvalido(f"o nó {i} do diagrama precisa ser texto ou objeto.")
        if not _ID.match(identificador):
            raise DocumentoInvalido(f"id inválido no diagrama: {identificador!r}.")
        if identificador in vistos:
            raise DocumentoInvalido(f"id repetido no diagrama: {identificador!r}.")
        vistos.add(identificador)
        nos.append({
            "id": identificador,
            "rotulo": _texto(rotulo, 120, f"nos[{i}].rotulo"),
        })
    por_rotulo = {no["rotulo"]: no["id"] for no in nos}
    ligacoes: list[dict[str, str]] = []
    if isinstance(ligacoes_brutas, list):
        if len(ligacoes_brutas) > 60:
            raise DocumentoInvalido("o diagrama passou de 60 ligações.")
        for i, ligacao in enumerate(ligacoes_brutas):
            if isinstance(ligacao, str):
                partes = re.split(r"\s*(?:->|→)\s*", ligacao, maxsplit=1)
                if len(partes) != 2:
                    avisos.append(f"ligação {i} do diagrama ignorada (use `de -> para`)")
                    continue
                de, para, rotulo = partes[0], partes[1], ""
            elif isinstance(ligacao, dict):
                de = str(ligacao.get("de") or ligacao.get("from") or "")
                para = str(ligacao.get("para") or ligacao.get("to") or "")
                rotulo = str(ligacao.get("rotulo") or ligacao.get("label") or "")
            else:
                avisos.append(f"ligação {i} do diagrama ignorada")
                continue
            de = de if de in vistos else por_rotulo.get(de, de)
            para = para if para in vistos else por_rotulo.get(para, para)
            if de not in vistos or para not in vistos:
                avisos.append(f"ligação {i} do diagrama aponta para nó inexistente")
                continue
            ligacoes.append({
                "de": de,
                "para": para,
                "rotulo": _texto(rotulo, 120, f"ligacoes[{i}].rotulo"),
            })
    return nos, ligacoes


def _normalizar_pontos_mapa(bruto: Any) -> list[dict[str, Any]]:
    if not isinstance(bruto, list) or not bruto:
        raise DocumentoInvalido("o mapa precisa de `pontos` (lista com lat e lon).")
    if len(bruto) > 50:
        raise DocumentoInvalido("o mapa passou de 50 pontos.")
    pontos: list[dict[str, Any]] = []
    for i, ponto in enumerate(bruto):
        if not isinstance(ponto, dict):
            raise DocumentoInvalido(f"o ponto {i} do mapa precisa ser um objeto.")
        lat = _numero(ponto.get("lat", ponto.get("latitude")), f"pontos[{i}].lat")
        lon = _numero(ponto.get("lon", ponto.get("lng", ponto.get("longitude"))), f"pontos[{i}].lon")
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise DocumentoInvalido(f"o ponto {i} do mapa tem coordenadas fora da faixa.")
        pontos.append({
            "rotulo": _texto(ponto.get("rotulo", ponto.get("nome", f"ponto {i + 1}")), 120, f"pontos[{i}].rotulo"),
            "lat": lat,
            "lon": lon,
        })
    return pontos


def _normalizar_passos(bruto: Any) -> list[dict[str, str]]:
    if not isinstance(bruto, list) or not bruto:
        raise DocumentoInvalido("o algoritmo precisa de `passos` (lista).")
    if len(bruto) > 30:
        raise DocumentoInvalido("o algoritmo passou de 30 passos.")
    passos: list[dict[str, str]] = []
    for i, passo in enumerate(bruto):
        if isinstance(passo, str):
            passos.append({"titulo": _texto(passo, 300, f"passos[{i}]"), "detalhe": ""})
        elif isinstance(passo, dict):
            passos.append({
                "titulo": _texto(passo.get("titulo", passo.get("label", f"Passo {i + 1}")), 300, f"passos[{i}].titulo"),
                "detalhe": _texto(passo.get("detalhe", passo.get("descricao", "")), LIMITES["texto"], f"passos[{i}].detalhe"),
            })
        else:
            raise DocumentoInvalido(f"o passo {i} do algoritmo precisa ser texto ou objeto.")
    return passos


def _normalizar_campos_calculo(
    bruto: Any, estado: dict[str, Any], avisos: list[str]
) -> list[dict[str, Any]]:
    if isinstance(bruto, dict):
        bruto = [
            {"chave": chave, **(valor if isinstance(valor, dict) else {"rotulo": str(valor)})}
            for chave, valor in bruto.items()
        ]
    if not isinstance(bruto, list) or not bruto:
        raise DocumentoInvalido("a calculadora precisa de `campos` (lista).")
    if len(bruto) > 12:
        raise DocumentoInvalido("a calculadora passou de 12 campos.")
    campos: list[dict[str, Any]] = []
    vistos: set[str] = set()
    for i, campo in enumerate(bruto):
        if not isinstance(campo, dict):
            raise DocumentoInvalido(f"o campo {i} da calculadora precisa ser um objeto.")
        chave = str(campo.get("chave") or campo.get("key") or "")
        if not _CHAVE.match(chave):
            raise DocumentoInvalido(
                f"o campo {i} da calculadora precisa de `chave` válida (letras, números, _)."
            )
        if chave in vistos:
            raise DocumentoInvalido(f"chave repetida na calculadora: {chave!r}.")
        vistos.add(chave)
        valor = _numero(campo.get("valor", campo.get("value", 0)), f"campos[{i}].valor")
        if chave not in estado:
            estado[chave] = valor
            avisos.append(f"KodaCalculator: estado `{chave}` criado com valor inicial")
        campos.append({
            "chave": chave,
            "rotulo": _texto(campo.get("rotulo", campo.get("label", chave)), 120, f"campos[{i}].rotulo"),
            "valor": valor,
        })
    return campos


def _validar_no(
    bruto: Any,
    caminho: str,
    profundidade: int,
    estado: dict[str, Any],
    acoes: dict[str, dict[str, Any]],
    ids: set[str],
    contador: list[int],
) -> dict[str, Any]:
    if profundidade > LIMITES["profundidade"]:
        raise DocumentoInvalido(f"a árvore passou de {LIMITES['profundidade']} níveis.")
    if not isinstance(bruto, dict):
        raise DocumentoInvalido(f"o nó `{caminho}` precisa ser um objeto.")
    contador[0] += 1
    if contador[0] > LIMITES["nos"]:
        raise DocumentoInvalido(f"a interface passou de {LIMITES['nos']} nós.")

    tipo_bruto = str(bruto.get("type") or bruto.get("tipo") or "").strip()
    if not tipo_bruto:
        raise DocumentoInvalido(f"o nó `{caminho}` não tem `type`.")
    canonico = APELIDOS.get(tipo_bruto.lower(), tipo_bruto)
    componente = COMPONENTES.get(canonico)
    if componente is None:
        raise DocumentoInvalido(
            f"o componente `{tipo_bruto}` não existe. Disponíveis: "
            + ", ".join(sorted(COMPONENTES))
            + "."
        )

    identificador = str(bruto.get("id") or f"n{contador[0]}")
    if not _ID.match(identificador):
        raise DocumentoInvalido(f"id inválido em `{caminho}`: {identificador!r}.")
    if identificador in ids:
        raise DocumentoInvalido(f"id repetido na interface: {identificador!r}.")
    ids.add(identificador)

    # Props também podem vir no próprio nó (`{"type":"KodaText","texto":"oi"}`), que é
    # como muitos modelos escrevem. O envelope manda `props`, mas aceitar as duas formas
    # evita recusar um documento que a interface sabe desenhar perfeitamente.
    props_brutas = bruto.get("props") or bruto.get("propriedades")
    if not isinstance(props_brutas, dict):
        props_brutas = {}
    extras = {
        chave: valor
        for chave, valor in bruto.items()
        if chave not in {"id", "type", "tipo", "props", "propriedades", "children", "filhos"}
    }
    if extras:
        props_brutas = {**extras, **props_brutas}
    # SVG: alguns modelos desenham com filhos `KodaSvgLine`/`KodaSvgCircle` em vez da lista
    # `formas`. Aceitar as duas formas evita uma ida e volta inteira só por causa do formato.
    if componente.nome == "KodaSvg" and not props_brutas.get("formas"):
        filhos_svg = bruto.get("children") or bruto.get("filhos") or []
        if isinstance(filhos_svg, list) and filhos_svg:
            formas_dos_filhos: list[dict[str, Any]] = []
            for filho in filhos_svg:
                if not isinstance(filho, dict):
                    continue
                tipo_filho = str(filho.get("type") or filho.get("tipo") or "").strip()
                props_do_filho = filho.get("props")
                if not isinstance(props_do_filho, dict):
                    props_do_filho = {}
                extras_do_filho = {
                    chave: valor for chave, valor in filho.items()
                    if chave not in {"id", "type", "tipo", "props", "propriedades", "children", "filhos"}
                }
                formas_dos_filhos.append({
                    **extras_do_filho,
                    **props_do_filho,
                    "tipo": tipo_filho,
                })
            props_brutas = {**props_brutas, "formas": formas_dos_filhos}
    # Abas: muitos modelos põem os rótulos nos filhos (`tabId`, `label`) e deixam `abas`
    # vazio — a tela então desenhava o painel inteiro de uma vez, sem faixa de abas.
    # Deriva as abas dos filhos, na ordem, e marca cada filho com a sua.
    abas_derivadas = False
    if componente.nome == "KodaTabs":
        atuais = props_brutas.get("abas")
        if not isinstance(atuais, list) or not atuais:
            rotulos: list[str] = []
            candidatos = props_brutas.get("tabs")
            if isinstance(candidatos, list):
                for item in candidatos:
                    if isinstance(item, str) and item.strip():
                        rotulos.append(item.strip())
                    elif isinstance(item, dict):
                        valor = (
                            item.get("label") or item.get("titulo") or item.get("id")
                            or item.get("texto")
                        )
                        if isinstance(valor, str) and valor.strip():
                            rotulos.append(valor.strip())
            filhos_para_abas = bruto.get("children") or bruto.get("filhos") or []
            if not rotulos and isinstance(filhos_para_abas, list):
                for filho in filhos_para_abas:
                    if not isinstance(filho, dict):
                        continue
                    props_do_filho = filho.get("props")
                    if not isinstance(props_do_filho, dict):
                        props_do_filho = {}
                    rotulo = ""
                    for chave in ("aba", "tab", "tabId", "label", "titulo"):
                        valor = props_do_filho.get(chave, filho.get(chave))
                        if isinstance(valor, str) and valor.strip():
                            rotulo = valor.strip()
                            break
                    if rotulo:
                        rotulos.append(rotulo)
                        props_do_filho["aba"] = rotulo
                        filho["props"] = props_do_filho
            if rotulos:
                props_brutas = {**props_brutas, "abas": rotulos}
                abas_derivadas = True
    props, avisos = _normalizar_props(componente, props_brutas, estado, acoes)
    if abas_derivadas:
        avisos.append("KodaTabs: abas derivadas dos filhos")
    faltando = [campo for campo in componente.obrigatorias if campo not in props]
    if faltando:
        raise DocumentoInvalido(
            f"{componente.nome} (`{identificador}`) precisa de: {', '.join(faltando)}."
        )

    filhos_brutos = bruto.get("children") or bruto.get("filhos") or []
    if not isinstance(filhos_brutos, list):
        raise DocumentoInvalido(f"`children` de `{identificador}` precisa ser uma lista.")
    if not componente.filhos and filhos_brutos:
        raise DocumentoInvalido(f"{componente.nome} não aceita filhos.")
    if len(filhos_brutos) > min(componente.max_filhos, LIMITES["filhos"]):
        raise DocumentoInvalido(f"`{identificador}` passou de {LIMITES['filhos']} filhos.")
    filhos = [
        _validar_no(filho, f"{caminho}.children[{i}]", profundidade + 1, estado, acoes, ids, contador)
        for i, filho in enumerate(filhos_brutos)
    ]

    return {
        "id": identificador,
        "type": componente.nome,
        "props": props,
        "children": filhos,
        **({"avisos": avisos} if avisos else {}),
    }


def validar(bruto: Any, *, run_id: str = "") -> tuple[dict[str, Any], list[str]]:
    """Valida e normaliza um documento Koda UI.

    Aceita o envelope completo ou só o documento. Devolve `(documento, avisos)`; levanta
    `DocumentoInvalido` com a frase que o modelo usa para corrigir a chamada.
    """
    if not isinstance(bruto, dict):
        raise DocumentoInvalido("o documento precisa ser um objeto JSON.")
    interno = bruto.get("documento")
    documento: dict[str, Any] = interno if isinstance(interno, dict) else bruto

    versao = str(documento.get("schemaVersion") or documento.get("versao") or SCHEMA_VERSION)
    if versao != SCHEMA_VERSION:
        raise DocumentoInvalido(f"schemaVersion {versao!r} não suportada; use {SCHEMA_VERSION!r}.")

    bruto_json = json.dumps(documento, ensure_ascii=False, default=str)
    if len(bruto_json.encode()) > LIMITES["bytes"]:
        raise DocumentoInvalido(f"o documento passou de {LIMITES['bytes'] // 1024} KB.")

    estado = _validar_estado(documento.get("state") if "state" in documento else documento.get("estado"))
    acoes = _validar_acoes(documento.get("actions") if "actions" in documento else documento.get("acoes"), estado)

    raiz_bruta = documento.get("root") if "root" in documento else documento.get("raiz")
    if not isinstance(raiz_bruta, dict):
        raise DocumentoInvalido("o documento precisa de `root` (a árvore de componentes).")

    avisos: list[str] = []
    ids: set[str] = set()
    contador = [0]
    raiz = _validar_no(raiz_bruta, "root", 1, estado, acoes, ids, contador)
    avisos.extend(raiz.pop("avisos", []))

    documento_id = str(documento.get("documentId") or documento.get("id") or "")
    if documento_id and not _ID.match(documento_id):
        raise DocumentoInvalido("`documentId` inválido.")
    if not documento_id:
        # Id determinístico: o loop valida para emitir e o handler valida para responder
        # ao modelo. Sem isto, cada validação gerava um id diferente para o mesmo
        # documento, e o estado local (que é indexado pelo id) não sobrevivia ao reload.
        base = run_id + ":" + json.dumps(documento, ensure_ascii=False, sort_keys=True, default=str)
        documento_id = str(uuid.uuid5(uuid.NAMESPACE_URL, base))
    mensagem_id = str(documento.get("messageId") or run_id or "")
    if mensagem_id and len(mensagem_id) > 120:
        raise DocumentoInvalido("`messageId` longo demais.")
    revisao = _inteiro(documento.get("revision", 1), 1, 1_000_000, "revision")

    data_refs = documento.get("dataRefs", documento.get("referencias", []))
    if data_refs:
        # Não há biblioteca de datasets autorizada ainda: aceitar uma referência que o
        # servidor não resolve seria fingir dados. Melhor recusar e dizer o motivo.
        raise DocumentoInvalido(
            "`dataRefs` ainda não é suportado: envie os dados dentro do próprio documento."
        )

    fallback = _texto(documento.get("fallbackText", documento.get("textoAlternativo", "")),
                      2000, "fallbackText")

    normalizado = {
        "schemaVersion": SCHEMA_VERSION,
        "documentId": documento_id,
        "messageId": mensagem_id,
        "revision": revisao,
        "state": estado,
        "actions": acoes,
        "root": raiz,
        "dataRefs": [],
        "fallbackText": fallback,
    }
    return normalizado, avisos


def texto_do_bloco(documento: dict[str, Any]) -> str:
    """O bloco ```koda-ui-doc``` que fica gravado na mensagem.

    É o que faz a interface voltar igual quando a conversa é reaberta: o mesmo documento
    que a tela desenhou ao vivo é lido de novo pelo renderer.
    """
    return "```koda-ui-doc\n" + json.dumps(documento, ensure_ascii=False) + "\n```"


_ECO = re.compile(r"```(?:js-doc|json-doc|koda-ui-json)\s*\n(.*?)\n```", re.DOTALL)


def remover_ecos(texto: str) -> str:
    """Tira o JSON que o modelo repetiu no texto depois de chamar a ferramenta.

    Alguns modelos desobedecem e reescrevem o documento numa cerca `js-doc`. Se ela for
    um documento Koda UI válido, o bloco é um eco da tela — e deixá-lo faria a conversa
    reabrir com um paredão de JSON antes da interface.
    """
    def troca(achado: re.Match[str]) -> str:
        try:
            bruto = json.loads(achado.group(1))
        except (ValueError, TypeError):
            return achado.group(0)
        if not isinstance(bruto, dict) or not isinstance(bruto.get("root"), dict):
            return achado.group(0)
        if "schemaVersion" not in bruto:
            return achado.group(0)
        if not any(chave in bruto for chave in ("documentId", "actions", "fallbackText")):
            return achado.group(0)
        return ""

    return _ECO.sub(troca, texto)
