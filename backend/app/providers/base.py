"""Contrato dos providers de resposta.

A interface chama só isso: qualquer coisa que produza pedaços de texto em streaming serve
como provider. Hoje são **dois** — o `host` (o serviço de modelos oficial) e o `local`, que
responde offline quando o serviço não está no ar. Não há provider de terceiro.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..identidade import NOME, regras


class ProviderError(RuntimeError):
    """Falha ao falar com o provedor, já com uma mensagem que dá para mostrar na tela."""


class TransientProviderError(ProviderError):
    """Vale a pena tentar de novo: cota (429), 5xx, timeout, resposta vazia."""


@dataclass(slots=True)
class ChatTurn:
    role: str  # 'user' | 'assistant' | 'system' | 'tool'
    text: str
    #: Imagens que vão **junto** deste turno, como `data:` URLs (`data:image/png;base64,…`).
    #:
    #: Ficam no turno e não no texto porque imagem não é texto: quem as leva ao modelo é o
    #: campo `image_url` do pedido. O turno do usuário carrega o que ele anexou; o turno
    #: `tool` carrega o que a **ferramenta** devolveu como imagem — os quadros de um vídeo
    #: analisado, por exemplo. Vazio (o caso normal) manda o pedido exatamente como antes:
    #: `content` continua sendo uma string.
    imagens: list[str] = field(default_factory=list)
    #: As **chamadas de ferramenta** deste turno (`assistant`), no formato do provedor.
    #:
    #: Um turno do assistente que usou ferramenta volta ao modelo com as chamadas, e cada
    #: resultado volta como um turno `tool` que aponta para elas. Sem isto o histórico chega
    #: só com texto: o modelo vê as próprias falas **sem** as chamadas e aprende com elas a
    #: narrar em vez de chamar — defeito que só aparecia depois de alguns pedidos na mesma
    #: conversa, porque é a repetição do exemplo ruim que ensina.
    chamadas: list[dict[str, Any]] = field(default_factory=list)
    #: A qual chamada este turno responde (`tool`) — casa com `chamadas[i]["id"]`.
    chamada_id: str | None = None
    #: Eco interno para provedores que exigem o raciocínio no próximo pedido.
    reasoning_content: str | None = None


@dataclass(slots=True)
class ChatOptions:
    model: str
    reasoning: bool = True
    web: bool = False
    project: str | None = None
    attachments: list[str] = field(default_factory=list)
    #: As imagens desta conversa foram anexadas ao contexto (modelo que enxerga imagem)?
    #: Muda só o que o prompt de sistema diz sobre os anexos — sem isto ele mandaria o
    #: modelo chamar `read_attachment` para uma imagem que já está na frente dele.
    visao_ativa: bool = False
    #: Nome com que o assistente se identifica (o host injeta uma persona própria).
    assistente: str = NOME
    #: Quem está logado (`Nome (email)`), quando há conta. `None` = não fala de identidade.
    conta: str | None = None
    #: Esforço de raciocínio escolhido no seletor (`None` = o botão Reasoning decide).
    effort: str | None = None
    #: Resumo do histórico antigo, quando a conversa não cabe mais inteira no contexto.
    #: Vai no prompt de sistema — é contexto de fundo, não uma fala de ninguém.
    resumo: str = ""


@dataclass(slots=True)
class Piece:
    """Um pedaço do que o provedor devolve: o texto final ou o raciocínio antes dele.

    O host manda os dois no mesmo stream — `content` e `reasoning_content`. Descartar o
    raciocínio deixava a tela parada enquanto o modelo pensava e a resposta parecia chegar
    de uma vez: no `liz-mini-2` são **cerca de dois minutos** de raciocínio (2859 pedaços)
    antes da primeira palavra do texto.
    """

    text: str
    reasoning: bool = False
    #: Marca de controle no fim do stream quando o provedor fechou com `finish_reason=length`.
    truncated: bool = False
    #: Marca de controle no fim do stream quando o **raciocínio** virou laço e o provedor
    #: cortou a leitura (ver `StepResult.repetiu`). Existe separada de `truncated` porque o
    #: caminho de texto puro não recebe `StepResult` nenhum — e o alô ao modelo sai daqui.
    repetiu: bool = False
    #: O `usage` que o provedor manda no fim do stream, num pedaço **sem texto**.
    #:
    #: Existe porque o caminho de texto puro (`chat.py::_texto`) não recebe `StepResult`
    #: nenhum: o `stream()` só devolve `Piece`, e o bloco de `usage` era descartado junto
    #: com os chunks sem `choices`. Resultado: a ficha ficava sem contador de tokens sempre
    #: que as ferramentas estavam desligadas. Vai como marcador de rodapé (`text=""`).
    usage: dict[str, int] | None = None


@runtime_checkable
class Provider(Protocol):
    name: str
    #: O provider consegue atender? Existe porque um provider já podia estar sem chave (o
    #: caminho OpenAI-compatible, que saiu do produto). **Hoje os dois que restam são sempre
    #: prontos** — o host porque quem valida o id é ele, o local porque não depende de nada —
    #: então a guarda não dispara. Fica no contrato porque é ele que a interface lê
    #: (`provider_ready` no health), e porque um provider que precise de credencial volta a
    #: cair aqui em vez de falhar no meio da conversa.
    ready: bool

    def stream(self, turns: list[ChatTurn], options: ChatOptions) -> AsyncIterator[Piece]:
        """Produz o raciocínio e o texto da resposta em pedaços, na ordem."""
        ...


BLOCOS_VISUAIS = (
    "Você DESENHA na conversa: é assim que você explica, mostra por que fez e responde. "
    "Escreva um bloco de código com a linguagem `koda-grafico` (gráficos), `koda-mapa` "
    "(mapa mental), `koda-passos` (passo a passo), `koda-comparacao` (lado a lado) ou "
    "`koda-visual` (tabela, diff, árvore, números, aviso e quiz), contendo **um JSON** — "
    "a interface desenha. Você manda os DADOS, nunca HTML, CSS, SVG ou JavaScript: quem "
    "escolhe cor, tamanho e forma é a interface. "
    "Alcance o bloco **sempre que precisar**, e em especial para: "
    "**explicar** como algo funciona — arquitetura, fluxo, banco de dados, código, "
    "como uma peça se liga na outra; "
    "**mostrar por que fez** uma escolha — comparar as opções, os prós e os contras "
    "de cada caminho, o que pesou a favor; "
    "**resumir o que fez** — o passo a passo do trabalho, o antes e o depois; "
    "**dar números** — medidas, custos, contagens; "
    "e **sempre** que a pessoa não for da área: quem pede explicação costuma NÃO "
    "entender o jargão, e um desenho explica o que o parágrafo não explica. "
    "Antes de escrever um bloco, pergunte-se: isto fica mais claro vendo do que lendo? "
    "Se sim, desenhe. Um desenho por ideia, com título curto, e o texto em volta explica "
    "o que ele mostra — o bloco não substitui a resposta, ele acompanha. "
    "Formatos, com todos os campos entre aspas: "
    "`koda-grafico` com um `tipo` entre: "
    '`barras` — comparar quantidades: {"titulo":"...","dados":[{"rotulo":"...","valor":123}]} '
    '(e "horizontal":true para as barras deitadas); '
    '`empilhadas` — duas séries na mesma barra: {"titulo":"...","series":["Site","App"],'
    '"dados":[{"rotulo":"sem 1","valor":40,"valor2":22}]}; '
    '`linhas` ou `area` — algo que muda ao longo do tempo: {"titulo":"...",'
    '"dados":[{"rotulo":"seg","valor":12}]}; '
    '`pizza` ou `rosca` — de que partes um total é feito (poucas partes, até 5); '
    '`dispersao` ou `bolha` — relação entre duas variáveis ("valor" é x, "valor2" é y; '
    '`bolha` aceita "tamanho" como terceira); '
    '`radar` — perfil em eixos (3 ou mais); '
    '`timeline` — história em ordem ("grupo" é a etiqueta da fase); '
    '`sankey` — fluxo de valor entre nós: {"titulo":"...",'
    '"fluxos":[{"de":"Receita","para":"Salários","valor":52}]}; '
    '`tabela` — colunas e linhas: {"titulo":"...","colunas":["Arquivo","Papel"],'
    '"linhas":[["main.tsx","liga a interface"]]}. '
    "`koda-mapa` com "
    '{"titulo":"...","centro":"...","ramos":[{"texto":"...","filhos":[{"texto":"..."}]}]} '
    "— é o mapa mental: mostra como as partes de algo se ligam, e aceita quantos níveis "
    "precisar. "
    "`koda-passos` com "
    '{"titulo":"...","passos":[{"titulo":"...","texto":"..."}]} — é o passo a passo, '
    "para o que acontece em ordem. "
    "`koda-comparacao` com "
    '{"titulo":"...","colunas":[{"titulo":"...","itens":["...","..."]}]} — para opções '
    "lado a lado, com os pontos a favor e contra de cada uma. "
    "Para **ficha de produto** (celular, notebook, plano, curso), compare por atributo, "
    "de 2 a 5 itens: "
    '{"titulo":"...","atributos":["Preço","Tela","Bateria"],"itens":[{"nome":"...",'
    '"valores":{"Preço":"...","Tela":"...","Bateria":"..."},"recomendado":true}],'
    '"destaques":{"Bateria":"nome do melhor"}} — `atributos` fixa a ordem das linhas, '
    "`destaques` marca o melhor de cada linha e `recomendado` realça a coluna; todos os "
    "itens levam os mesmos atributos, com valor curto em texto (nada de frase inteira). "
    "`koda-diagrama` recebe o desenho **cru**, sem JSON: é o traço que você já faz, com "
    "`┌ ─ ┐ │ └ ┘` para as caixas, `┴` para bifurcar e `▼` para a seta, e o rótulo ao lado "
    "do fio. Use para arquitetura, fluxo de decisão e «quem chama quem» — o Koda redesenha "
    "com cor de traço e alinhamento intacto. Uma caixa por ideia, linha curta: o desenho "
    "não reflui, então mantenha-o dentro de ~60 colunas. "
    "Para arquitetura em **colunas** (frontend / backend / dados), mande a estrutura e deixe "
    "o desenho com o Koda: "
    '{"tipo":"diagrama","titulo":"...","setas":["HTTP","SQL"],"colunas":[{"titulo":"Frontend",'
    '"blocos":[{"titulo":"js/","linhas":["chat · ui"],"tom":"neutro"}]}],"notas":'
    '[{"titulo":"327 testes verdes","tom":"ok"}]} — `tom` aceita neutro|atencao|erro|ok e '
    "serve para marcar o que está duplicado ou em risco. "
    "O mesmo bloco desenha mais **três** formatos, e a chave é que escolhe: `camadas` "
    "(empilhado, para o que fica por baixo), `fluxo` (caixas em sequência, com `setas` "
    "dizendo a condição de cada fio) e `quadrantes` (matriz 2×2, com `eixo_x` e `eixo_y`, na "
    "ordem de leitura: superior esquerdo, superior direito, inferior esquerdo, inferior "
    "direito). "
    "`koda-visual` com um `tipo` entre: "
    '`diffs` — o que mudou num arquivo: {"titulo":"...","arquivo":"src/App.tsx",'
    '"linhas":[{"tipo":"ctx","texto":"..."},{"tipo":"add","texto":"..."},{"tipo":"del",'
    '"texto":"..."}]}; '
    '`arvore` — organização de pastas: {"titulo":"...","itens":[{"nome":"src",'
    '"filhos":[{"nome":"App.tsx"}]}]}; '
    '`metrica` — números grandes: {"titulo":"...","cartoes":[{"rotulo":"Conversas",'
    '"valor":"1.284","variacao":"+12%"}]}; '
    '`citacao` — aviso que não pode passar batido: {"tom":"dica|aviso|erro|info",'
    '"titulo":"...","texto":"..."}; '
    '`quiz` — pergunta de múltipla escolha que a pessoa responde clicando: '
    '{"tipo":"quiz","pergunta":"...","opcoes":["...","...","..."],"correta":1,'
    '"explicacao":"..."} '
    "(o campo `\"tipo\":\"quiz\"` é obrigatório; sem `correta` o quiz só guarda a escolha, sem julgar); "
    '`mapa-radial` — a constelação, para mostrar um time ou sistema em volta de um centro: '
    '{"titulo":"...","centro":"...","centro_sub":"...","nos":[{"nome":"Liz",'
    '"sub":"o modelo principal"}]} — até 8 nós, nome curto; '
    '`plano` — a apresentação de um plano para a pessoa aceitar: {"titulo":"...",'
    '"o_que_e":"...","pra_que":"...","por_que":"...","como":[{"titulo":"...","texto":"..."}],'
    '"mudancas":[{"arquivo":"src/App.tsx","texto":"..."}],"resultado":"..."}. '
    "**Regra do plano: tarefa grande que monta um plano para a pessoa aceitar apresenta o plano "
    "SEMPRE num bloco `plano`**, com as seis partes — `o_que_e`, `pra_que`, `por_que`, `como`, "
    "`mudancas` e `resultado` — e pergunta se pode começar antes de executar. NADA a menos que "
    "isso: plano contado de outro jeito, ou com parte faltando, é plano mal entregue. "
    "**Regra do quiz: quiz, teste, perguntas de múltipla escolha ou perguntas com resposta "
    "certa vão SEMPRE no bloco `quiz`** (uma pergunta por bloco) — quiz escrito como lista de "
    "texto é quiz quebrado, a pessoa não consegue clicar. "
    "O JSON precisa ser válido: sem comentário, sem vírgula sobrando, sem `...` no lugar "
    "de um valor de verdade. Prefira números de verdade a texto. "
    "Não use bloco visual para pouca coisa: uma lista de dois itens é uma lista. "
    "E nunca escreva o JSON no meio do texto — ele vai **só** dentro do bloco de código."
)

#: **UI generativa (`koda-ui`)** — a porta para além dos formatos fixos.
#:
#: Os blocos visuais acima cobrem 21 formas previsíveis. Quando o pedido é uma
#: **interface** — contador, simulador, editor, calculadora, painel — nenhum dos 21 serve,
#: e aí a IA **descreve** a tela com a mini-linguagem `koda-ui` e o Koda **desenha**.
#:
#: É Generative UI: a IA compõe, não programa. Os componentes são fechados (`box`,
#: `button`, `slider`, `grid`, `chart`, `title`, `texto`), o estado é `useState` de
#: verdade, e a lógica é aritmética simples. Sem HTML, sem JavaScript arbitrário — o
#: texto que a IA manda é dado, e o Koda interpreta com um parser próprio, sem `eval`.
UI_GENERATIVA = (
    "Além dos blocos acima, você MONTA interfaces quando o pedido é uma **tela**, não um "
    "dado: contador, simulador, calculadora, painel de configuração, formulário, dashboard, "
    "editor passo a passo. Use a linguagem `koda-ui`, dentro de um bloco de código:\n"
    "```koda-ui\n"
    "{@body const [count, setCount] = DIL.useState(0)}\n"
    "<box padding={3}>\n"
    "  <title>{count}</title>\n"
    '  <button onClick={() => setCount(count + 1)}>Aumentar</button>\n'
    "</box>\n"
    "```\n"
    "**Componentes** (só estes existem — use-os, não invente):\n"
    "• estrutura e texto: `box` (caixa, `padding` 0–8), `card`, `row` (linha), `column` "
    "(coluna), `grid` (grade, `cols`), `title`, `texto`, `paragrafo`, `label`, `caption`, "
    "`icon`, `divider`, `spacer`.\n"
    "• ação: `button` (`onClick`), `iconbutton`, `pressable` (área clicável, `onClick`), `link`.\n"
    "• formulário: `slider` (`rotulo`, `min`, `max`, `step`, `valor`, `onChange`), `input` "
    "(`valor`, `placeholder`, `onChange`), `textarea` (texto longo, `valor`, `placeholder`, "
    "`onChange`), `select` (`opcoes`, `onChange`), `radio` (`opcoes`, `onChange`), "
    "`segmented` (`opcoes`, `onChange`), `checkbox` (`valor`, `rotulo`, `onChange`), "
    "`toggle` (`valor`, `rotulo`, `onChange`), `date` (`valor`, `onChange`), `form`.\n"
    "• dados e exibição: `table` (`colunas`, `linhas`), `chart` (barras, `dados` com "
    "`rotulo`/`valor`), `stat` (`rotulo`, `valor`, `variacao`), `list` (`itens`), `badge`, "
    "`alert`, `progress` (`valor`, `max`), `callout`.\n"
    "• com estado interno (funcionam sozinhos): `steps` (`itens` — passo a passo com "
    "Próximo/Anterior), `tabs` (`itens`), `accordion` (detalhe que abre/fecha), "
    "`carousel` (`itens` — Anterior/Próximo), `popover` (mostra/esconde conteúdo ao clicar).\n"
    "• lista dinâmica: `repeat` (`itens` — renderiza um filho por item de um array; "
    "declare o array com `DIL.useList([\"a\", \"b\"])` no `{@body}` e passe com "
    "`itens={nomeDaLista}`; use `{lista.length}` para mostrar a contagem). Com filhos, "
    "cada linha tem `item` e `index`; pode dar nomes claros com `item=\"tarefa\"` e "
    "`indice=\"i\"`, por exemplo `<texto valor={tarefa.texto} />`. `useList` aceita "
    "objetos simples: `[{id: 1, texto: \"Ler\", feito: false}]`.\n"
    "• mídia: `code` (bloco de código), `imagem` (`src`, `alt`).\n"
    "**Estado**: declare no `{@body …}` com `const [nome, setNome] = DIL.useState(valor)` "
    "(um ou vários, cada um no seu `{@body}`). Para lista use "
    "`DIL.useList([\"a\", \"b\"])` e renderize com `<repeat itens={nome}>`. **Lógica**: "
    "dentro de `{…}` vale aritmética "
    "(`+ - * /`, parênteses), comparação (`>= <= > < == !=`), concatenação de string "
    "(`\"R$ \" + total`), ternário, `Math.round/min/max/abs`, `.length`, `.toFixed(2)` e "
    "`.toLocaleString(\"pt-BR\", {minimumFractionDigits: 2})`, `String(expressão)` e "
    "`Date.now()` (só para IDs). Os eventos (`onClick`, `onChange`) aceitam uma ou mais "
    "chamadas `setNome(expressão)` separadas por `+`, executadas da esquerda pra direita; "
    "em `input`/`select` use `setNome(e.target.value)` e em slider numérico use "
    "`setNome(Number(e.target.value))`; também é válido passar `onChange={setNome}` direto "
    "(o Koda recebe o valor e converte slider para número). Exemplo: "
    '`<button onClick={() => setItens([...itens, {id: Date.now(), texto: novo}]) + setNovo("")}>Adicionar</button>`. '
    "Para editar/remover uma linha, use `setTarefas(tarefas.map((t) => t.id == tarefa.id ? "
    "{...t, feito: t.feito == false} : t))` ou `setTarefas(tarefas.filter((t) => t.id != "
    "tarefa.id))`. A contagem pode ser `tarefas.filter((t) => t.feito == false).length`. "
    "**Regras**: um bloco `koda-ui` por tela; monte a interface que responde o pedido, com "
    "título curto; não repita em texto o que a tela já mostra; e não use para pouca coisa "
    "— uma lista simples é lista. Componente que não está na lista não existe. "
    "**O que NÃO fazer (não rola e quebra a tela):**\n"
    "• NÃO escreva função com bloco `=> { ... }` nem `function` — a lógica é uma "
    "**expressão só** (`{usuarios * preco}`), não um programa com laço/console/try. "
    "Não use `if`, `.trim()`, `.indexOf()`, `$item` ou JavaScript de `style` dentro da UI. "
    "Para mostrar uma contagem, passe o número direto ao `stat` ou use `String(contagem)`.\n"
    "• NÃO monte editor de código que executa JavaScript real (não roda código na tela). "
    "Se o pedido for 'editor', mostre o código num bloco `code` e explique em texto — "
    "não prometa executar.\n"
    "• NÃO invente componente de mapa geográfico, vídeo com player ou SVG clicável.\n"
    "• NÃO guarde array grande com template string dentro (`codigo: '...${x}...'`) — "
    "mantenha o `{@body}` simples: `useState` de número/texto/booleano e `useList` de "
    "strings curtas.\n"
    "Quando o pedido pedir algo fora disso (rodar código, mapa, vídeo), entregue em "
    "**texto e blocos de código normais** explicando, e monte a UI só com o que existe."
)

#: O nome de cada bloco, para a instrução acima e para quem for ler o código.

#: O idioma — e ele vai **por último**, de propósito.
#:
#: Instrução no começo de um prompt longo perde para o que vem depois: o "responda em
#: português do Brasil" estava na segunda linha e não bastou. Os modelos pequenos do host
#: (o free tier é o que se usa aqui) derrapam no meio da frase — já saiu resposta em
#: português com caractere chinês, palavra coreana e frase russa enfiada no meio, e a
#: explicação era sobre blocos de interface. O que chega por último é o que a amostragem
#: respeita, então a regra fecha o prompt.
#:
#: Não lista idiomas de propósito: citar "chinês, coreano, russo" aumenta a chance de eles
#: aparecerem — modelo pequeno puxa do que está escrito por perto. "Outro alfabeto" cobre
#: todos, e a saída para o termo técnico em inglês está dita, para ele não travar.
IDIOMA = (
    "**Idioma: português do Brasil, do começo ao fim.** Nenhuma palavra de outro idioma e "
    "nenhum caractere de outro alfabeto no meio do texto. Nome técnico em inglês é aceitável "
    "quando é o nome da coisa (`commit`, `pull request`, `deploy`). Se faltar a palavra em "
    "português, diga com as palavras que você tem — trocar de idioma no meio da frase é "
    "erro, não estilo."
)


def system_prompt(options: ChatOptions) -> str:
    """Instrução base enviada aos provedores reais."""
    parts: list[str] = [
        "Você é o Koda, um assistente de programação dentro de uma interface de chat.",
        "Responda em português do Brasil, direto ao ponto, com blocos de código quando ajudar.",
    ]
    if options.project:
        parts.append(f"O contexto de código ativo é o projeto {options.project}.")
    if options.reasoning:
        parts.append(
            "Pense passo a passo antes de concluir, sem narrar o raciocínio inteiro. "
            "Pense em português do Brasil: o rascunho antes da resposta aparece na tela de "
            "quem está acompanhando, e rascunho em inglês no meio de uma conversa em "
            "português é vazamento de bastidor, não conteúdo."
        )
    if options.web:
        parts.append(
            "A busca na Web está ativada: pesquise pelo `web_search` do Bing. Em pedidos "
            "de pesquisa ampla, faça pelo menos três buscas com formulações diferentes e "
            "leia páginas de pelo menos três domínios independentes antes de concluir. "
            "Nunca pesquise, abra ou baixe conteúdo da Wikipedia, Wikimedia ou projetos "
            "irmãos; escolha fontes independentes."
        )
    else:
        parts.append(
            "A busca na Web está desativada nesta mensagem: não afirme que pesquisou nem "
            "use ferramentas de busca, leitura ou download da Web."
        )
    if options.resumo:
        parts.append(options.resumo)
    if options.attachments:
        if options.visao_ativa:
            parts.append(
                "Nesta conversa há anexos do usuário: "
                + ", ".join(options.attachments)
                + ". Os arquivos NÃO estão na pasta de trabalho. As **imagens** já estão "
                "anexadas ao turno em que foram enviadas: você as enxerga, então descreva e "
                "responda sobre elas direto, sem chamar ferramenta. Para texto, código ou "
                "pdf, use a ferramenta `read_attachment` com o id que aparece no bloco "
                "«[anexos desta mensagem]». Não tente abrir o anexo com `read_file` pelo "
                "nome — ele não está no workspace."
            )
        else:
            parts.append(
                "Nesta conversa há anexos do usuário: "
                + ", ".join(options.attachments)
                + ". O conteúdo deles NÃO está na pasta de trabalho: para ler, use a ferramenta "
                "`read_attachment` com o id que aparece no bloco «[anexos desta mensagem]». "
                "Não tente abrir o anexo com `read_file` pelo nome — ele não está no workspace."
            )
    # Quem está do outro lado. Sem isto o assistente responde "não tenho acesso aos dados
    # da sua conta" — tecnicamente verdade, e uma péssima primeira impressão para quem
    # acabou de entrar. O e-mail é o da conta no painel, e vai só para o provedor da
    # conversa; nada é gravado aqui.
    if options.conta:
        parts.append(
            f"Quem está falando com você está logado como {options.conta}: trate a pessoa "
            "pelo nome quando fizer sentido e não pergunte quem ela é nem peça o e-mail."
        )
    parts.append(BLOCOS_VISUAIS)
    parts.append(UI_GENERATIVA)
    # A identidade vence a persona que o host injeta na conversa (ver `app/identidade.py`).
    parts.append(regras(options.assistente))
    # E o idioma fecha o prompt. Ver o comentário de `IDIOMA`: instrução no começo de um
    # prompt longo perde para o que vem depois, e o modelo derrapa no meio da resposta.
    parts.append(IDIOMA)
    return " ".join(parts)
