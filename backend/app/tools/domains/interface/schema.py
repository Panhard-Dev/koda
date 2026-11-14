"""Schema da ferramenta de interface inteligente (Koda UI)."""

from __future__ import annotations

from ....contracts.tools import _def

_DOCUMENTO = {
    "type": "object",
    "description": (
        "Documento Koda UI. Forma: {schemaVersion:'1.0', documentId, messageId, revision, "
        "state:{chave:valorInicial}, actions:{id:{kind,...}}, root:{id,type,props,children}, "
        "dataRefs:[], fallbackText}. O servidor valida e a interface desenha; não escreva "
        "HTML, CSS nem JavaScript. Tipos: KodaBox, KodaRow, KodaColumn, KodaGrid, KodaCard, "
        "KodaTitle, KodaText, KodaParagraph, KodaCaption, KodaBadge, KodaAlert, KodaCallout, "
        "KodaDivider, KodaSpacer, KodaList, KodaLink, KodaCodeBlock, KodaImage, KodaTable, "
        "KodaMetric, KodaProgress, KodaButton, KodaInput, KodaTextarea, KodaCheckbox, "
        "KodaRadioGroup, KodaSelect, KodaSlider, KodaSegmentedControl, KodaForm, "
        "KodaPressable, KodaChart, KodaTabs, KodaSteps, KodaAccordion, KodaCarousel, "
        "KodaPopover, KodaDatePicker, KodaToggle, KodaSuggestion, KodaQuote, KodaDiff, "
        "KodaSourceList, KodaVideo, KodaIcon, KodaSvg, KodaDiagram, KodaMap, "
        "KodaWritingBlock, KodaSandbox, KodaAppBlock, KodaAlgorithm, KodaCitation, "
        "KodaEntity, KodaCalculator. Ações: state.set, state.toggle, state.increment, "
        "state.calc (key, expression), ui.setTab, copy, openUrl, issueNewTurn, form.submit. "
        "Props dos novos: KodaIcon {nome, tamanho, rotulo}; KodaSvg {viewBox, "
        "formas:[{tipo:linha|circulo|retangulo|texto|caminho|poligono, ...}]}; "
        "KodaDiagram {nos:[{id,rotulo}], ligacoes:[{de,para,rotulo}]}; KodaMap "
        "{pontos:[{rotulo,lat,lon}]}; KodaWritingBlock {titulo, valueBinding, linhas}; "
        "KodaAlgorithm {titulo, passos:[{titulo,detalhe}]}; KodaCitation {texto, fonte, "
        "url}; KodaEntity {tipo, nome, detalhe, url}; KodaCalculator {titulo, "
        "campos:[{chave,rotulo,valor}], formula, unidade, casas}. "
        "KodaSandbox/KodaAppBlock aceitam html, css e js, mas rodam isolados num iframe "
        "de origem opaca, sem acesso ao app; use só para prévia de protótipo."
    ),
    "properties": {
        "schemaVersion": {"type": "string", "description": "use '1.0'"},
        "documentId": {"type": "string", "description": "id estável; o servidor gera se faltar"},
        "revision": {"type": "integer", "description": "comece em 1"},
        "state": {
            "type": "object",
            "description": "valores iniciais das chaves usadas pelos campos e ações",
            "additionalProperties": True,
        },
        "actions": {
            "type": "object",
            "description": "ações declarativas por id; o botão aponta para o id",
            "additionalProperties": {"type": "object"},
        },
        "root": {
            "type": "object",
            "description": "nó raiz da árvore: {id, type, props, children}",
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string"},
                "props": {"type": "object", "additionalProperties": True},
                "children": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["type"],
        },
        "fallbackText": {
            "type": "string",
            "description": "texto acessível se a interface não puder ser desenhada",
        },
    },
    "required": ["root"],
}

DEFINICOES = [
    _def(
        "mostrar_interface",
        "Desenha uma interface interativa na conversa (Koda UI) — contador, formulário, "
        "painel, calculadora, comparação, tabela, gráfico, passo a passo, quiz de estudo. "
        "Use quando a resposta ganha em ser usada, não só lida. O modelo entrega o "
        "documento JSON; o servidor valida e a tela desenha. NÃO escreva o JSON em prosa "
        "nem em bloco de código depois de chamar. Exemplo mínimo de contador: "
        "{\"state\":{\"n\":0},\"actions\":{\"mais\":{\"kind\":\"state.increment\",\"key\":\"n\",\"amount\":1}},"
        "\"root\":{\"id\":\"raiz\",\"type\":\"KodaBox\",\"children\":["
        "{\"id\":\"t\",\"type\":\"KodaTitle\",\"props\":{\"texto\":\"Contador\"}},"
        "{\"id\":\"v\",\"type\":\"KodaText\",\"props\":{\"texto\":\"0\"}},"
        "{\"id\":\"b\",\"type\":\"KodaButton\",\"props\":{\"rotulo\":\"+1\",\"actionId\":\"mais\"}}]}}. "
        "Para mostrar o valor do estado dentro de um texto, use o tipo KodaText com "
        "`props:{\"texto\":\"{{n}}\"}` (o renderer substitui pela chave do state). "
        "Exemplo de formulário: {\"state\":{\"nome\":\"\",\"tipo\":\"site\",\"testes\":false},"
        "\"actions\":{\"enviar\":{\"kind\":\"form.submit\",\"mensagem\":\"Crie um plano para "
        "{{nome}}, tipo {{tipo}}, testes={{testes}}\"}},"
        "\"root\":{\"type\":\"KodaForm\",\"props\":{\"actionId\":\"enviar\",\"botao\":\"Criar plano\"},"
        "\"children\":[{\"type\":\"KodaInput\",\"props\":{\"rotulo\":\"Nome\",\"valueBinding\":\"nome\"}},"
        "{\"type\":\"KodaSelect\",\"props\":{\"rotulo\":\"Tipo\",\"opcoes\":[\"site\",\"app\"],"
        "\"valueBinding\":\"tipo\"}},{\"type\":\"KodaCheckbox\",\"props\":{\"rotulo\":\"Incluir testes\","
        "\"valueBinding\":\"testes\"}}]}}. Em campos, `valueBinding` é o nome da chave de "
        "`state` (não o texto do campo). Em botões, `actionId` é o nome da ação. "
        "Envie os campos do documento diretamente nos argumentos (state, actions, root) "
        "ou dentro de `documento`; as duas formas valem.",
        {"documento": _DOCUMENTO, **_DOCUMENTO["properties"]},
        [],
    ),
]
