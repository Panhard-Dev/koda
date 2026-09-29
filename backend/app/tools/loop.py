"""Loop agentic: o modelo pede ferramentas, o Koda executa e devolve o resultado.

Portado do `nucleo/loop_agente.py` do projeto TOOLS, adaptado para assíncrono e para
narrar cada passo como evento SSE — assim a interface mostra a ferramenta rodando em vez
de esperar a resposta final em silêncio.

Detalhe que vem do projeto original e é obrigatório com o host: as `tool_calls` são ecoadas
**exatamente** como vieram (id + string de argumentos), porque o host guarda a assinatura da
chamada do lado dele e casa pelo id. Trocar o id, reserializar os argumentos ou reordenar o
histórico quebra o casamento.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from itertools import count
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .. import contexto
from . import ferramentas

PROMPT_FERRAMENTAS = (
    "Você é o Koda, um agente de engenharia que executa tarefas REAIS na máquina do "
    "usuário usando as ferramentas disponíveis.\n"
    "\n"
    "**Fale enquanto trabalha.** Antes de cada ferramenta, escreva UMA linha curta do que "
    "vai fazer, na MESMA resposta da chamada (ex.: \"Vou ler o js/core.js para ver o motor "
    "do jogo.\"). Tarefa longa e calada parece travada: quem está olhando não sabe se você "
    "está trabalhando ou parado. Isto vale para toda ferramenta, inclusive as de leitura.\n"
    "\n"
    "**Pedido que se resolve com uma resposta NÃO usa ferramenta.** Se a pessoa só quer uma "
    "resposta — um cumprimento, um teste (\"responda com um ok\"), uma pergunta do que você "
    "sabe — responda direto e pare. Não saia listando pasta nem lendo arquivo para responder "
    "isso: fazer trabalho que ninguém pediu é erro, mesmo quando o trabalho dá certo. "
    "Ferramenta é para quando o pedido exige **olhar ou mexer** em algo.\n"
    "Regras:\n"
    "1. Quando o pedido exige olhar ou mexer no projeto, prefira SEMPRE usar ferramentas em "
    "vez de responder de memória.\n"
    "2. Para descobrir o estado do mundo, use list_dir/read_file; para mudar o estado, "
    "use write_file/edit_file/shell.\n"
    "3. Cada coisa tem a sua ferramenta, e é ela que você usa — nunca um comando nem "
    "Python para fazer o que já tem ferramenta:\n"
    "   • ler arquivo: read_file (em arquivo grande, leia por faixa: inicio/limite)\n"
    "   • criar/sobrescrever arquivo: write_file\n"
    "   • editar trecho: edit_file\n"
    "   • aplicar um diff inteiro: apply_patch\n"
    "   • apagar arquivo: delete_file\n"
    "   • criar pasta: create_directory\n"
    "   • apagar pasta: delete_directory\n"
    "   • mover: move_file · copiar: copy_file · renomear: rename_file\n"
    "   • listar pasta: list_dir\n"
    "   • procurar arquivo pelo nome: search_files\n"
    "   • procurar trecho de código: search_codebase (texto) ou regex_search (regex)\n"
    "   • ambiente da máquina: get_environment\n"
    "   • git: git_status · git_diff · git_log · git_commit · git_push · git_pull\n"
    "   • dependências: install_package · uninstall_package\n"
    "   • baixar arquivo da internet: download_file · enviar: upload_file\n"
    "   • rodar build/testes/comando de verdade: shell\n"
    "   • calcular, analisar, conferir um resultado: code_interpreter\n"
    "4. `code_interpreter` é para **calcular e analisar** (conta, parsear um texto, "
    "conferir um resultado) — nunca para ler, criar, editar, mover, copiar, renomear, "
    "listar ou apagar arquivo, e nunca para o que `shell`/git já fazem. `shell` é para "
    "programa de verdade (build, teste, git, install), não para substituir as ferramentas "
    "de arquivo. Se você se pegar escrevendo `pathlib`, `os.remove`, `shutil` ou "
    "`open(..., 'w')` dentro do code_interpreter, pare: existe ferramenta para isso.\n"
    "5. Narre **junto com a ferramenta**, nunca no lugar dela. A linha curta do que vai "
    "fazer (\"Vou listar a pasta para ver o que já existe.\") e a chamada da ferramenta vão "
    "na MESMA resposta. Encerrar um passo só com a narração não é trabalho: sem a chamada, "
    "nada mudou no disco, e é exatamente isso que faz a pessoa achar que você travou. Se "
    "você escreveu \"vou ler o X\", chame `read_file` na mesma resposta — sem exceção.\n"
    "6. Uma linha por vez, sem repetir a mesma frase e sem relatório no meio do "
    "caminho: a explicação completa fica para o fechamento. Nunca gaste um passo inteiro "
    "só descrevendo o que você já leu ou o que ainda falta ler.\n"
    "7. Execute uma ferramenta por vez, leia o resultado e decida o próximo passo.\n"
    "8. Valide o próprio trabalho (rode testes/comandos) antes de terminar.\n"
    "9. Quando a tarefa estiver completa, responda em texto claro com o que foi feito, "
    "em português do Brasil.\n"
    "10. Não invente saídas de comandos: se precisar de informação, chame uma ferramenta.\n"
    "11. Trabalhe dentro da pasta de trabalho informada. Se a tarefa pedir outro caminho "
    "e a ferramenta recusar, o caminho certo é **pedir autorização** (o pedido de "
    "permissão aparece para a pessoa na conversa) — não é contornar com Python ou shell.\n"
    "12. No Windows: para rodar Python inline use code_interpreter (aspas de `python -c` "
    "quebram no cmd); para scripts, grave o arquivo e execute com shell.\n"
    "13. Anunciar não é fazer. Se você escreveu \"vou fazer X\", a ferramenta que faz X tem "
    "que ser chamada agora, no mesmo passo — terminar uma resposta com um plano e sem "
    "nenhuma chamada de ferramenta significa que **nada** mudou no disco, e a pessoa fica "
    "olhando uma promessa. Sempre que a tarefa pede mudança, o primeiro passo é uma "
    "ferramenta de leitura (list_dir/read_file/search_files) e o trabalho começa ali.\n"
    "14. Se uma ferramenta falhar, o trabalho **não** acabou: leia o erro, ajuste o argumento "
    "(caminho relativo à pasta de trabalho, trecho único no edit_file) e chame de novo — ou "
    "use outra ferramenta para chegar no mesmo resultado. Só desista depois de tentar, e "
    "diga à pessoa o que falhou e por quê.\n"
    "15. Use os nomes exatos da lista acima. Nomes parecidos (`run_command`, "
    "`list_directory`, `run_code`, `read_file` para uma pasta) podem até ser aceitos, mas "
    "chamar a ferramenta certa é mais rápido e não gera erro de argumento.\n"
    "16. **Tarefa grande começa com um plano.** Antes de mexer em qualquer coisa, divida o "
    "pedido em itens curtos e concretos e registre com `update_todos` (todos os itens, o "
    "primeiro com `atual: true`). Só depois comece a executar, item por item — e a cada "
    "item terminado, chame `update_todos` de novo marcando-o com `feito: true` e apontando "
    "o próximo como `atual: true`. A pessoa vê a lista na conversa e acompanha."
    "\n   É grande o que tem várias etapas, vários arquivos/partes, refatoração, migração, "
    "\"faz tudo\", ou um pedido longo. Não é grande o que se resolve em uma ou duas "
    "ferramentas (ler um arquivo, criar um, rodar um teste): aí a lista só atrapalha.\n"
    "17. A lista é o **espelho** do que aconteceu, nunca do que você pretende: só marque "
    "`feito: true` depois de a ferramenta daquele item ter rodado. Item novo que aparecer "
    "no meio do caminho entra na lista, na posição dele."
)

#: O pedido é grande o bastante para valer um plano antes de executar?
#: Pega o que a pessoa escreve quando a tarefa tem várias partes.
TAREFA_GRANDE = re.compile(
    r"(\b(fase|fases|etapa|etapas|passo a passo|checklist|plano|refator\w*|migra\w*|"
    r"reescrev\w*|reorganiza\w*|implementa\w* tudo|todos os arquivos|v[aá]rios arquivos|"
    r"o projeto inteiro|do come[çc]o ao fim|v[aá]rios|em partes|divida|divide)\b"
    r"|^\s*[-*\u2022]\s+\S|^\s*\d+[.)]\s+\S|^\s*#{1,3}\s+\S)",
    re.IGNORECASE | re.MULTILINE,
)

#: Quantos verbos de ação diferentes no pedido já fazem dele uma tarefa grande.
ACOES_PARA_PLANO = 3

#: Tamanho do pedido (caracteres) a partir do qual ele é grande por definição: um pedido
#: longo é alguém descrevendo um trabalho com várias partes, e responder isso sem plano é
#: o que faz a tarefa sair pela metade.
CARACTERES_PARA_PLANO = 600

DIVIDIR_TAREFA = (
    "Antes de executar: esta tarefa é grande. Divida agora em itens curtos e concretos e "
    "registre o plano com `update_todos` (todos os itens de uma vez, o primeiro com "
    "`atual: true`). Só depois comece a executar — e a cada item terminado, chame "
    "`update_todos` de novo com a lista atualizada. Não comece pela ferramenta de trabalho "
    "antes de a lista existir."
)

EXIGIR_PLANO = (
    "Você começou a executar sem registrar o plano, e esta tarefa é grande. Chame "
    "`update_todos` AGORA com todos os itens (o que já fez marcado com `feito: true`, o "
    "próximo com `atual: true`) e siga daí, mantendo a lista em dia."
)

#: Quantas vezes o passo é REFEITO com a ferramenta obrigatória (`tool_choice:
#: "required"`) quando o modelo anuncia o próximo passo e encerra sem chamar nada.
#: Sem bronca no histórico: a resposta volta com a chamada que faltou, e o anúncio
#: sai da conversa para não virar exemplo. Esgotadas as forçadas, o loop fecha com
#: a verdade — mas obrigado, o modelo praticamente sempre age na primeira.
MAX_FORCADAS = 3

#: Cobrança quando o modelo termina sem ter conseguido rodar uma única ferramenta.
#: "As ferramentas deram erro em todas" não pode virar uma resposta de texto.
CONSERTAR_FERRAMENTA = (
    "Nenhuma ferramenta sua funcionou até agora, e a tarefa não avançou. Leia a mensagem de "
    "ERRO que voltou, corrija o argumento que a causou e chame a ferramenta de novo — "
    "caminho relativo à pasta de trabalho, trecho único no edit_file, comando existente no "
    "shell. Se o caminho certo for outro, use outra ferramenta. Não escreva um plano: "
    "execute."
)

#: Quantas vezes o loop cobra execução antes de aceitar que o modelo só quis falar.
MAX_COBRANCAS = 2

#: Quantas vezes o loop **retoma** uma tarefa que parou com itens do plano em aberto.
#: Terminar pela metade e encerrar a resposta era o sintoma: o agente começava, narrava que
#: ia continuar e parava ali.
MAX_RETOMADAS = 3


def retomar_tarefa(pendentes: list[dict[str, Any]]) -> str:
    """A cobrança de quem parou com itens pendentes na lista.

    Nomeia os itens em aberto: cobrança genérica ("continue") faz o modelo responder uma
    linha de intenção e parar de novo, que é exatamente o que se está consertando.
    """
    itens = "; ".join(str(item.get("texto", "")) for item in pendentes[:6])
    return (
        f"A lista que você registrou ainda tem {len(pendentes)} item(ns) pendente(s): "
        f"{itens}. A tarefa **não** terminou e a conversa não pode fechar agora. Continue "
        "pelo próximo item chamando a ferramenta que o executa — não escreva o que você "
        "vai fazer, faça. Quando o item terminar, chame `update_todos` de novo com a lista "
        "atualizada. **Se um item já está feito de verdade, não faça de novo: marque-o na "
        "lista.** Se o item não for mais possível, encerre-o explicando o motivo e marque-o "
        "como feito."
    )

#: Quantas vezes o orçamento de contexto é reduzido à metade quando o provedor recusa o
#: tamanho do pedido. O orçamento é uma estimativa; o limite real é do provedor, e duas
#: reduções (¼ do teto original) resolvem com folga qualquer diferença de conta.
MAX_REDUCOES = 2

#: Piso da redução: abaixo disso o histórico deixa de ser útil e o certo é parar e dizer.
MINIMO_ORCAMENTO = 16_000


class ContextoEstourado(Exception):
    """O provedor recusou o pedido por tamanho (não é falha da tarefa)."""

#: Falhas que o modelo **não** conserta insistindo: a ferramenta está desligada na
#: configuração, ou a própria pessoa negou a ação. Aí o certo é explicar e mudar de
#: caminho — cobrar a mesma chamada só gasta o tempo da tarefa.
SEM_CONSERTO = ("KODA_TOOLS_DENY", "a pessoa negou")

def acompanhar_comando(identificador: str) -> str:
    """A cobrança de quem deixou um comando rodando e fechou a tarefa por texto.

    É mensagem **interna** (entra no histórico, não na tela): o que a pessoa lê é o modelo
    decidindo — "tá tudo certo, vou continuar acompanhando" — e o comando aparecendo vivo na
    linha de baixo.
    """
    return (
        f"O comando {identificador} ainda está rodando (você não o interrompeu). Decida "
        "agora, em uma ferramenta: acompanhe com shell "
        f'{{"continuar": "{identificador}"}} ou pare com shell '
        f'{{"parar": "{identificador}"}}. Não encerre a tarefa com um comando rodando.'
    )


#: O id que a olhada devolve quando o comando passou dos `INTERVALO_DE_OLHADA`.
AINDA_RODANDO = re.compile(r"AINDA RODANDO.*?id=([0-9a-fA-F]+)")

CONTINUAR = (
    "(sua mensagem anterior veio vazia ou falhou) Continue a tarefa usando as ferramentas "
    "e, quando terminar, responda em texto. Narre junto: a linha curta e a chamada da "
    "ferramenta vão na mesma resposta — uma linha sozinha não faz nada."
)

#: Quantos passos seguidos de ferramenta, **sem uma palavra**, antes de o loop cobrar
#: narração. É **um**: os modelos Liz e Layze ficam calados do começo ao fim quando
#: ninguém cutuca, e o dono reclamou exatamente disso.
MAX_SILENCIO = 1

#: Quantas vezes o loop **força** uma fala (passo sem ferramenta nenhuma) numa tarefa.
#:
#: Pedir a linha no histórico não bastou: o `liz-4` recebia o pedido e continuava chamando
#: ferramenta, dez passos calado (medido). Sem ferramenta na mão ele não tem o que chamar —
#: só pode responder texto, e é isso que aparece na tela. O teto existe para a narração não
#: virar o trabalho: a cada fala forçada, uma chamada a mais.
MAX_NARRACOES = 6

NARRAR = (
    "Você rodou ferramentas sem escrever nada para a pessoa. Informe o que descobriu. "
    "Se o pedido já foi atendido, entregue o resultado final e encerre sem chamar outra "
    "ferramenta. Se ainda há trabalho pendente, escreva uma linha curta do próximo passo "
    "e chame a ferramenta necessária na mesma resposta. Exemplo para trabalho pendente: "
    '"Vi que o projeto tem js/ e css/; vou ler o js/main.js para achar o ponto de entrada." '
    "Não repita ferramentas cujo resultado já é suficiente para responder ao pedido."
)

#: Quantas vezes o loop troca uma **leitura** feita em código pela ferramenta certa. Uma
#: só: ler arquivo dentro de código que analisa coisa é comum e legítimo, e depois da
#: primeira vez o caminho certo já foi dito. As operações que mudam o disco (escrever,
#: criar, apagar, mover, copiar) não têm esse crédito — ver `Oportunidade.critica`.
TROCAS_POR_CODIGO = 1

#: Verbos que aparecem depois de "vou…" quando o modelo está **anunciando** o próximo
#: passo. A lista era curta e deixava passar justamente as frases que a pessoa via na tela
#: — "agora vou **analisar** os arquivos restantes" não estava aqui, então a resposta passou
#: por fechamento e a tarefa parou com o trabalho pela metade.
VERBOS_DE_ANUNCIO = (
    r"analis\w+|analisar|ler|l[êe]r|ver|verific\w+|confer\w+|chec\w+|test\w+|rodar|"
    r"execut\w+|criar|cri\w+|escrev\w+|edit\w+|ajust\w+|continu\w+|segu\w+|implement\w+|"
    r"corrig\w+|arrum\w+|mover|mova\w+|remov\w+|adicion\w+|instal\w+|build\w*|"
    r"compil\w+|revis\w+|termin\w+|finaliz\w+|abrir|abr\w+|olhar|olh\w+|listar|list\w+|"
    r"procur\w+|busc\w+|refator\w+|migr\w+|atualiz\w+|apli\w+|valida\w+|garantir|"
    r"deixar|come[çc]ar|montar|juntar|marcar|registrar|descobrir|entender|explicar|"
    r"resumir|mostrar|apresentar|fazer|investigar|inspecion\w+|explorar|percorrer|"
    r"comparar|mapear|conectar|integrar|preparar|organizar"
)

#: Marcas de quem **anuncia** uma ação em vez de executar: o "vou <verbo de trabalho>" e
#: os marcadores explícitos de "depois eu faço". "Depois disso" e "por fim" ficaram de
#: fora de propósito: sozinhos, aparecem numa resposta que **explica** o que já foi feito,
#: e marcar isso como anúncio transformava uma resposta pronta em "não terminei".
ANUNCIO = re.compile(
    r"(^|\b)(vou|irei|vamos|pretendo|deixe-me|deixa eu)\s+(?:agora\s+)?"
    rf"(?:{VERBOS_DE_ANUNCIO})\b"
    r"|\b(próximo passo|próxima etapa|a seguir|em seguida|seguir com|continuo daqui|"
    r"sigo daqui)\b",
    re.IGNORECASE | re.MULTILINE,
)

#: Quantas sentenças do fim da resposta entram na checagem de anúncio. O anúncio de quem
#: vai parar fica no fim ("…e agora vou analisar os arquivos restantes"); procurando no
#: texto inteiro, uma explicação longa que só **menciona** o próximo passo cairia na regra.
SENTENCAS_DO_FIM = 2

#: Marcas de **futuro**, sem depender do verbo que vem depois delas. Era este o furo: a
#: regra antiga procurava o verbo logo depois do "vou" e dentro de uma lista — e a lista
#: não tinha `deletar`. Um agente de verdade terminou uma tarefa de análise escrevendo
#: "Vou deletar o bench temporário e escrever a análise", com o `node` ainda rodando há
#: 153 s, e a conversa fechou ali: arquivo temporário no disco, análise não escrita. Marca
#: de futuro não sofre disso — quem escreve "vou…" está anunciando trabalho, seja qual for
#: o verbo.
FUTURO = re.compile(
    r"\b(vou|irei|vamos|pretendo|deixe-me|deixa eu|preciso|precisamos|quero|queremos|"
    r"tenho que|terei que|falta|faltam|ainda falta|próximo passo|próxima etapa|"
    r"em seguida|a seguir|seguir com|continuo daqui|sigo daqui|"
    r"i will|i'll|let me|next i|i'?m going to|need to|still need)\b",
    re.IGNORECASE,
)

#: Frase final que **começa** com verbo no infinitivo ("Escrever a análise agora."): em
#: português é futuro disfarçado, e é assim que um fechamento aparece sem nenhum "vou".
INFINITIVO_NO_FIM = re.compile(r"^\s*\w{4,}(?:ar|er|ir)\b", re.IGNORECASE)

# So a clausula final pode encerrar: uma acao posterior continua sendo anuncio.
FECHAMENTO_CONFIRMADO = re.compile(
    r"(?:^|[;.!?]\s*)(?:o\s+)?pr[óo]ximo passo\s+[ée]\s+"
    r"(?:apenas\s+)?(?:encerrar|finalizar)\s+(?:o teste|esta resposta|a resposta|a conversa)"
    r",\s*(?:pois|porque)\s+(?:o valor|o resultado|a leitura|a verifica[çc][ãa]o)\s+"
    r"j[áa]\s+(?:foi|est[áa])\s+(?:confirmad[oa]|verificad[oa]|conclu[íi]d[oa])"
    r"(?=\s*[.!?]?\s*$)",
    re.IGNORECASE,
)


def _frases(texto: str) -> list[str]:
    return [
        parte.strip()
        for parte in re.split(r"(?<=[.!?])\s+|\n+", texto or "")
        if parte.strip()
    ]


def _fim_do_texto(texto: str) -> str:
    """As últimas sentenças da resposta — onde fica o anúncio de quem vai encerrar."""
    return " ".join(_frases(texto)[-SENTENCAS_DO_FIM:])


def anunciou(texto: str) -> bool:
    """A resposta termina anunciando o que **ia** fazer, em vez de fechar o trabalho?

    Três testes, todos no fim do texto: marca de futuro (`vou…`, `preciso…`, `falta…`),
    frase final começando em infinitivo, e o vocabulário de anúncio da primeira versão.
    O vocabulário sozinho não bastava — sempre falta um verbo —, e é por isso que os
    outros dois olham a **forma** da frase, e não a palavra exata.
    """
    fim = FECHAMENTO_CONFIRMADO.sub("", _fim_do_texto(texto))
    if not fim.strip():
        return False
    return bool(ANUNCIO.search(fim) or FUTURO.search(fim) or INFINITIVO_NO_FIM.search(fim))


#: Anúncio → ferramenta, na ordem em que se procura. Só entra aqui ferramenta que **não
#: piora** nada se forçar errado: leitura, busca e comando. Escrita fica de fora de
#: propósito — forçar um `write_file` que o modelo não planejou direito grava arquivo
#: pela metade, e aí o estrago é maior do que parar e contar.
ANUNCIO_LEITURA: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"\b(listar|list|ver a pasta|estrutura da pasta|árvore|arvore|o que existe)\b",
            re.I,
        ),
        "list_dir",
    ),
    (
        re.compile(
            r"\b(procurar|buscar|encontrar|achar|search|find)\b[^.]{0,40}"
            r"\b(arquivo|files?|glob|padr[ãa]o)\b",
            re.I,
        ),
        "search_files",
    ),
    (
        re.compile(r"\b(procurar|buscar|grep|localizar|search)\b", re.I),
        "search_codebase",
    ),
    (
        re.compile(
            r"\b(ler|leia|li|lidas?|read|abrir|abre|open|conferir|verificar|ver|revisar|"
            r"analisar|checar|faltam?)\b",
            re.I,
        ),
        "read_file",
    ),
    (
        # Só **verbo** de execução: "bench"/"teste" são substantivos e aparecem no nome de
        # arquivo ("o bench.js"), o que já mandava um anúncio de leitura para o `shell`.
        re.compile(r"\b(rodar|roda|executar|executa|testar|medir|mede|build)\b", re.I),
        "shell",
    ),
)


def funcao_do_anuncio(texto: str) -> str | None:
    """A ferramenta que o anúncio está pedindo — quando dá para saber com segurança.

    É o plano B do `tool_choice: "required"`. Parte do catálogo (o `liz-nano`, medido)
    **ignora** a obrigatoriedade genérica e devolve texto outra vez; apontando a função
    pelo nome, esse mesmo modelo chama. Devolve `None` quando o anúncio não é claro: aí é
    melhor fechar com a verdade do que forçar a ferramenta errada.
    """
    if not texto.strip():
        return None
    for padrao, nome in ANUNCIO_LEITURA:
        if padrao.search(texto):
            return nome
    return None


def escolha_forcada(texto: str, tentativa: int) -> str | dict[str, Any]:
    """O `tool_choice` da tentativa forçada.

    Primeira tentativa: `"required"`, que é o que quase todo modelo respeita. Da segunda
    em diante: a ferramenta **pelo nome**, porque quem ignorou `required` obedece à função
    apontada. Sem anúncio claro, volta para `"required"`.
    """
    if tentativa <= 1:
        return "required"
    nome = funcao_do_anuncio(texto)
    if nome:
        return {"type": "function", "function": {"name": nome}}
    return "required"


# ---------------------------------------------------------------- portões de parada

#: Ferramentas que **mudam arquivo** e as que **executam alguma coisa**. As duas listas
#: existem para o portão de verificação: mudou arquivo de código e não executou nada depois
#: é entrega sem prova de que funciona.
MUDAM_ARQUIVO = (
    "write_file",
    "edit_file",
    "str_replace_editor",
    "apply_patch",
    "move_file",
    "copy_file",
    "rename_file",
    "delete_file",
    "create_directory",
    "delete_directory",
)
EXECUTAM = ("shell", "terminal", "code_interpreter")

#: Ferramentas que **só leem**: a mesma chamada, com o disco parado, dá o mesmo resultado.
#: É o que permite cortar a repetição sem mentir — ver `_chave_da_chamada` no `executar`.
SO_LEITURA = (
    "read_file",
    "list_dir",
    "search_files",
    "search_codebase",
    "grep",
    "regex_search",
    "vector_search",
    "get_environment",
    "get_problems",
    "linter",
    "git_status",
    "git_diff",
    "git_log",
    "web_search",
    "url_reader",
    "browser",
)


def _chave_da_chamada(nome: str, argumentos: dict[str, Any]) -> str:
    """Identidade da chamada: nome + argumentos, com as chaves em ordem.

    Serve para reconhecer a **mesma** leitura repetida — o modelo que lê o mesmo arquivo
    cinco vezes, ou roda o mesmo `list_dir` a cada passo. O dono viu isso acontecer e
    chamou de loop; é loop mesmo, e o gasto é dele (tempo e cota).
    """
    try:
        corpo = json.dumps(argumentos, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        corpo = str(argumentos)
    return f"{nome}:{corpo}"




def portao_de_parada(
    texto: str,
    *,
    plano_aberto: bool,
    cobrancas: int,
    ferramentas_ok: int,
    de_acao: bool,
    bloqueios: int,
) -> str | None:
    """A conversa pode fechar, ou entra uma cobrança? Devolve `(aviso, mensagem, portão)`.

    É o "stop gate" do Hermes (`agent/turn_stop_gates.py`) trazido para cá: quando o modelo
    para com uma resposta de texto, portões decidem se a conversa fecha. A ideia que se
    aprendeu lá, e que custou caro aqui, é que o sinal tem de ser de **estado** — o que foi
    mexido, o que foi executado, o que ficou em aberto — e não de vocabulário: lista de
    verbos sempre deixa escapar a frase que o modelo inventou.

    Nada aqui perde a resposta: o texto já saiu na tela e é o que fica guardado. O portão
    só decide se ele é o fim ou se vem mais trabalho.

    O que ele devolve é uma mensagem **interna** (entra no histórico, não na tela): quem
    está olhando a conversa não vê "pedindo para o agente tentar de novo" — vê o agente
    trabalhando. Aviso na tela é ruído; o que importa é o trabalho acontecer.
    """
    if plano_aberto:
        # O plano é tratado antes (o orçamento de retomadas renova com progresso), e uma
        # lista em aberto nunca permite fechar: o fechamento honesto diz o que falta.
        return None
    if not ferramentas_ok and de_acao and not bloqueios and cobrancas < MAX_COBRANCAS:
        return CONSERTAR_FERRAMENTA
    return None

#: Verbos de tarefa que pedem mudança de verdade na máquina. É o que separa "arruma esse "
#: bug" (usa ferramenta) de "o que é esse arquivo?" (resposta em texto é a resposta certa).
TAREFA_DE_ACAO = re.compile(
    r"\b(cria|crie|criar|adiciona|adicione|adicionar|implementa|implemente|implementar|"
    r"refatora|refatore|refatorar|corrige|corrija|corrigir|arruma|arrume|arrumar|"
    r"conserta|conserte|consertar|edita|edite|editar|altera|altere|alterar|muda|mude|mudar|"
    r"move|mova|mover|renomeia|renomeie|renomear|copia|copie|copiar|apaga|apague|apagar|"
    r"escreve|escreva|escrever|grava|grave|gravar|instala|instale|instalar|desinstala|"
    r"roda|rode|rodar|executa|execute|executar|testa|teste|testar|builda|compila|compile|"
    r"compilar|monta|monte|montar|converte|converta|converter|faz|fa\u00e7a|fazer|reorganiza|"
    r"termina|termine|terminar|continua|continue|continuar|"
    r"write|create|refactor|implement|add|move|rename|delete|edit|run|install|build|fix)\b",
    re.IGNORECASE,
)

#: Pergunta de verdade: "o que faz esse arquivo?" não precisa de ferramenta nenhuma.
PERGUNTA = re.compile(
    r"^\s*(o que|que|como|por que|porque|qual|quais|quando|onde|quem|quanto|quanta)\b",
    re.IGNORECASE,
)


def pedido_do_usuario(mensagens: list[dict[str, Any]]) -> str:
    """O último pedido da pessoa no histórico — é ele que diz se a tarefa é uma ação."""
    for mensagem in reversed(mensagens):
        if mensagem.get("role") != "user":
            continue
        texto = str(mensagem.get("content") or "").strip()
        # As mensagens internas do loop (cobrança de narração, continuação) não são pedido.
        if texto and texto not in (NARRAR, CONTINUAR, CONSERTAR_FERRAMENTA):
            return texto
    return ""


def pedido_grande(mensagens: list[dict[str, Any]]) -> bool:
    """O pedido tem várias partes? Então ele começa com um plano.

    Três sinais, qualquer um basta: o pedido é longo, ele marca várias etapas ("fase 1",
    lista numerada, "refatora") ou pede mais ações diferentes do que cabe numa tacada.
    Tarefa de uma ferramenta só — ler um arquivo, criar um, rodar um teste — não entra
    aqui: obrigar a uma lista nesses casos só faz o agente planejar em vez de trabalhar.
    """
    pedido = pedido_do_usuario(mensagens)
    if not pedido:
        return False
    if len(pedido) >= CARACTERES_PARA_PLANO:
        return True
    if TAREFA_GRANDE.search(pedido):
        return True
    acoes = {achado.group(0).lower() for achado in TAREFA_DE_ACAO.finditer(pedido)}
    return len(acoes) >= ACOES_PARA_PLANO


#: Pedido que se resolve com uma **resposta** — nada para mexer na máquina.
#:
#: O dono mandou "teste de funcionamento responda com um ok" e o agente saiu listando pasta,
#: lendo quatro arquivos e rodando `node --check`. A causa não era só o modelo: "teste" está
#: na lista de verbos de ação, então o loop tratava aquilo como tarefa e **cobrava**
#: ferramenta ("nenhuma ferramenta funcionou até aqui") quando ele respondia só "ok".
PEDIDO_DE_RESPOSTA = re.compile(
    r"^\s*(teste|testar|testando|responda|responde|me\s+responda|diga|diz|fale|me\s+diga|"
    r"me\s+fale|apenas|só|so|somente|oi|olá|ola|bom\s+dia|boa\s+tarde|boa\s+noite|"
    r"obrigado|valeu|ok)\b",
    re.IGNORECASE,
)

#: Tamanho a partir do qual o pedido é longo demais para ser só um cumprimento/resposta.
CARACTERES_DE_RESPOSTA = 120


def pedido_de_acao(mensagens: list[dict[str, Any]]) -> bool:
    """A pessoa pediu uma mudança de verdade, e não uma explicação nem uma resposta?"""
    pedido = pedido_do_usuario(mensagens)
    if not pedido:
        return False
    primeira = pedido.split("\n", 1)[0].strip()
    if PERGUNTA.match(primeira):
        return False
    # Pedido curto que começa pedindo resposta ("responda com um ok", "teste de
    # funcionamento", "oi") não é tarefa: cobrar ferramenta aqui é o que fazia o agente
    # sair investigando o projeto à toa.
    if len(pedido) <= CARACTERES_DE_RESPOSTA and PEDIDO_DE_RESPOSTA.match(primeira):
        return False
    return bool(TAREFA_DE_ACAO.search(pedido))


def precisa_cobrar(
    texto: str, *, de_acao: bool, ferramentas_ok: int, bloqueios: int = 0
) -> bool:
    """A resposta de texto pode encerrar a tarefa, ou é só anúncio?

    Duas regras, nesta ordem:

    - **anunciou** o que ia fazer ("vou seguir com...", "o plano é...", "próximo passo:"):
      cobra a execução, mesmo que já tenha rodado ferramenta antes — foi assim que a
      tarefa morreu no meio, com o plano na tela;
    - a tarefa é uma **ação** e nenhuma ferramenta funcionou ainda: cobra também, porque
      uma resposta de texto aí é sempre trabalho não feito. Exceção: quando a própria
      pessoa negou a ação — aí explicar é a resposta certa, e não insistir.
    """
    limpo = (texto or "").strip()
    if not limpo:
        return False
    if anunciou(limpo):
        return True
    return de_acao and ferramentas_ok == 0 and bloqueios == 0


#: Operações de arquivo escritas em Python, que têm ferramenta própria. O que se procura é
#: `pathlib`, `shutil`, `os.remove`/`os.makedirs`, `open(..., 'w')` e os primos — o caso que
#: enchia a conversa de "Rodar Python" para criar, ler, mover e apagar arquivo.
OPERACAO_DE_ARQUIVO = re.compile(
    r"(\bpathlib\b|\bshutil\b|\bos\.(remove|unlink|rmdir|removedirs|makedirs|mkdir|rename|"
    r"replace|listdir|walk|scandir|copy|copy2|copytree|move|stat|chmod)\b|"
    r"\bopen\s*\([^)]*['\"][wax]|\bf\.write\s*\(|\.write_text\s*\(|\.write_bytes\s*\("
    r"|\.read_text\s*\(|\.read_bytes\s*\()",
    re.IGNORECASE,
)

#: O que a operação parece querer, para o loop poder chamar a ferramenta certa. O último
#: campo diz se ela **muda o disco**: as que mudam nunca passam por código, as de leitura
#: passam uma vez (código que lê arquivo para analisar é trabalho legítimo).
OPORTUNIDADES: list[tuple[re.Pattern[str], str, str, bool]] = [
    (
        re.compile(r"(\.write_text\s*\(|\.write_bytes\s*\(|open\s*\([^)]*['\"][wa])", re.I),
        "write_file",
        "gravar arquivo",
        True,
    ),
    (
        re.compile(r"(\.mkdir\s*\(|os\.makedirs\b)", re.I),
        "create_directory",
        "criar pasta",
        True,
    ),
    (
        re.compile(r"(os\.remove\b|os\.unlink\b|\.unlink\s*\(|shutil\.rmtree\b)", re.I),
        "delete_file",
        "apagar arquivo",
        True,
    ),
    (
        re.compile(r"(os\.rename\b|os\.replace\b|\.rename\s*\()", re.I),
        "rename_file",
        "renomear",
        True,
    ),
    (
        re.compile(r"(shutil\.(move|copy|copy2|copytree)\b)", re.I),
        "copy_file",
        "mover/copiar",
        True,
    ),
    (
        re.compile(r"(\.read_text\s*\(|\.read_bytes\s*\(|open\s*\([^)]*['\"]r)", re.I),
        "read_file",
        "ler arquivo",
        False,
    ),
    (
        re.compile(r"(pathlib\.Path\s*\(|\.exists\s*\(|\.is_dir\s*\(|\.iterdir\s*\(|"
                   r"os\.listdir\b|os\.walk\b|r?glob)", re.I),
        "list_dir",
        "listar pasta",
        False,
    ),
]


#: Comandos de shell que fazem o que tem ferramenta própria: `rm`, `del`, `Remove-Item`,
#: `mv`, `mkdir`… Um `rm -rf pasta` no terminal não passa pela trava da pasta nem pelo
#: cartão de permissão — era a outra porta dos fundos, depois do `pathlib` no Python. O
#: comando tem de estar no começo ou depois de um separador (`&&`, `;`, `|`), senão
#: `git mv` e um `grep` que só *fala* de "mv" cairiam aqui sem motivo.
COMANDO_DE_ARQUIVO = re.compile(
    r"(^|[\n;&|]\s*|\bsudo\s+)(rm|del|erase|rd|rmdir|remove-item|mv|move|move-item|cp|"
    r"copy|copy-item|ren|rename|rename-item|md|mkdir|new-item|ni|touch|set-content|"
    r"add-content|out-file|tee)\b",
    re.IGNORECASE | re.MULTILINE,
)

#: Comando de shell → ferramenta que faz o mesmo, dentro da pasta de trabalho.
FERRAMENTA_DO_COMANDO = {
    "rm": "delete_file",
    "del": "delete_file",
    "erase": "delete_file",
    "remove-item": "delete_file",
    "rd": "delete_directory",
    "rmdir": "delete_directory",
    "mv": "move_file",
    "move": "move_file",
    "move-item": "move_file",
    "cp": "copy_file",
    "copy": "copy_file",
    "copy-item": "copy_file",
    "ren": "rename_file",
    "rename": "rename_file",
    "rename-item": "rename_file",
    "md": "create_directory",
    "mkdir": "create_directory",
    "new-item": "create_directory",
    "ni": "create_directory",
    "touch": "write_file",
    "set-content": "write_file",
    "add-content": "write_file",
    "out-file": "write_file",
    "tee": "write_file",
}


@dataclass(slots=True)
class Oportunidade:
    """Uma chamada de código que deveria ter sido uma ferramenta de arquivo."""

    devia: str
    verbo: str
    codigo: str
    critica: bool = False
    """Muda o disco? Escrita, criação, exclusão, mover e copiar mudam — e é por elas que
    não se passa: sem a ferramenta, não há checagem de pasta nem cartão de permissão."""


def oportunidade_de_ferramenta(nome: str, argumentos: dict[str, Any]) -> Oportunidade | None:
    """O código desta chamada está fazendo o que tem ferramenta própria?

    `code_interpreter` e `shell` não passam pela checagem de pasta nem pelo cartão de
    permissão, então viraram a porta dos fundos: em vez de `write_file`, o modelo escrevia
    Python com `pathlib`. Aqui isso é reconhecido na hora — e o loop devolve o caminho
    certo para o modelo em vez de aceitar a operação por fora das travas.
    """
    if nome in ("shell", "terminal"):
        comando = str(argumentos.get("comando") or argumentos.get("codigo") or "")
        achado = COMANDO_DE_ARQUIVO.search(comando)
        if achado is None:
            return None
        verbo = achado.group(2).lower()
        return Oportunidade(
            devia=FERRAMENTA_DO_COMANDO.get(verbo, ""),
            verbo=f"comando `{verbo}`",
            codigo=comando,
            critica=True,
        )
    if nome != "code_interpreter":
        return None
    codigo = str(argumentos.get("codigo") or argumentos.get("comando") or "")
    if not OPERACAO_DE_ARQUIVO.search(codigo):
        return None
    for padrao, devia, verbo, critica in OPORTUNIDADES:
        if padrao.search(codigo):
            return Oportunidade(devia=devia, verbo=verbo, codigo=codigo, critica=critica)
    return Oportunidade(devia="", verbo="mexer em arquivo", codigo=codigo, critica=True)


def aviso_de_ferramenta(oportunidade: Oportunidade) -> str:
    """O que volta para o modelo no lugar da execução."""
    alternativa = (
        f"Use a ferramenta `{oportunidade.devia}`"
        if oportunidade.devia
        else "Use as ferramentas de arquivo (list_dir/read_file/write_file/edit_file/...)"
    )
    return (
        f"ERRO: operação de arquivo em código (`{oportunidade.verbo}`). "
        f"{alternativa} para isso — ela roda dentro da pasta de trabalho e passa pelo "
        "cartão de permissão quando é o caso. `code_interpreter` e `shell` são para "
        "calcular e para programa de verdade (build, teste, git), não para mexer em "
        "arquivo. Chame a ferramenta certa agora."
    )

#: Quantas vezes o loop insiste quando o provedor responde erro **transitório** (429, 5xx,
#: conexão que caiu). Cinco, com o backoff abaixo, dá uns 38 segundos de janela: queda de
#: meio minuto no caminho até o serviço acontece, e desistir em 18 s matava a tarefa por um
#: soluço que passaria sozinho.
MAX_TENTATIVAS = 5

#: Base do backoff entre tentativas (segundos × número da tentativa, teto de 10s).
ESPERA_BASE = 3.0

#: Respostas vazias seguidas antes de desistir. Alto de propósito: o teto existe só para
#: provedor quebrado não girar para sempre queimando cota — desistir cedo era o defeito, e
#: resposta vazia acontece de verdade quando o modelo é cortado no meio de um contexto
#: gigante. Cada vazio empurra a continuação, calado.
MAX_VAZIAS = 20


@dataclass(slots=True)
class ToolCall:
    """Uma chamada pedida pelo modelo."""

    id: str
    name: str
    arguments: dict[str, Any]
    raw_arguments: str = "{}"

    def para_mensagem(self) -> dict[str, Any]:
        """Formato OpenAI, com os argumentos intactos (o proxy casa pelo id)."""
        return {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.raw_arguments or "{}"},
        }


@dataclass(slots=True)
class StepResult:
    """Um passo do modelo: texto e/ou pedidos de ferramenta."""

    text: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)


@dataclass(slots=True)
class ToolStep:
    """Passo de ferramenta, o que fica gravado junto da mensagem."""

    name: str
    arguments: dict[str, Any]
    output: str
    duration_ms: int
    call_id: str = ""
    ok: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "arguments": self.arguments,
            "output": self.output,
            "duration_ms": self.duration_ms,
            "call_id": self.call_id,
            "ok": self.ok,
        }


@dataclass(slots=True)
class Resultado:
    texto: str
    passos: list[ToolStep]
    completou: bool
    uso: dict[str, int]
    motivo: str = ""
    #: Última lista de tarefas que o modelo registrou, na ordem (vazia sem plano).
    #: É ela que fica gravada na mensagem — quem reabre a conversa vê o que foi feito.
    todos: list[dict[str, Any]] = field(default_factory=list)
    #: Tamanho do contexto no último passo, em tokens de entrada (`prompt_tokens`).
    #: É o que o medidor ao lado do modelo mostra: número do provedor, não estimativa.
    contexto: int = 0


class ToolModel(Protocol):
    """O que o loop precisa de um provedor: um passo com ferramentas à mão."""

    name: str
    ready: bool

    async def step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        model: str = "",
        escolha_ferramenta: str | dict[str, Any] | None = None,
    ) -> StepResult: ...


Emit = Callable[[str, dict[str, Any]], Awaitable[None]]

#: Pede permissão para uma ação e devolve `sim`/`sempre`/`nao`/`nunca`.
Aprovar = Callable[[dict[str, Any]], Awaitable[str]]


def _somar(destino: dict[str, int], origem: dict[str, Any]) -> None:
    for chave in destino:
        try:
            destino[chave] += int(origem.get(chave, 0) or 0)
        except (TypeError, ValueError):
            continue


def _faltando(limite: float | None) -> float | None:
    """Quanto tempo ainda resta do orçamento da tarefa."""
    return None if limite is None else limite - time.monotonic()


def _argumentos(call: ToolCall) -> dict[str, Any]:
    if isinstance(call.arguments, dict) and call.arguments:
        return call.arguments
    try:
        valor = json.loads(call.raw_arguments or "{}")
    except json.JSONDecodeError:
        return {}
    return valor if isinstance(valor, dict) else {}


async def executar(
    modelo: ToolModel,
    mensagens: list[dict[str, Any]],
    *,
    workspace: Path,
    max_steps: int,
    emit: Emit,
    negadas: set[str] | None = None,
    model: str = "",
    timeout_s: float | None = None,
    tentativas: int = MAX_TENTATIVAS,
    espera_final: float = 0.0,
    acesso_livre: bool = False,
    reasoning: bool = True,
    effort: str | None = None,
    aprovar: Aprovar | None = None,
    orcamento: int = contexto.ORCAMENTO_PADRAO,
) -> Resultado:
    """Roda até o modelo encerrar sem pedir ferramenta, ou até esgotar os passos.

    Falha do provedor não é falha da tarefa: cada passo é reenviado algumas vezes, com
    o histórico inteiro que já foi construído — o modelo retoma exatamente de onde
    parou, com os resultados das ferramentas já executadas no contexto.
    """
    tools = ferramentas.catalogo(negadas)
    historico = [dict(item) for item in mensagens]
    passos: list[ToolStep] = []
    uso = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    texto_final = ""
    #: Cuidado com o nome: `contexto` é o **módulo** importado (`contexto.compactar_historico`).
    contexto_usado = 0
    completou = False
    motivo = ""
    vazias = 0
    #: Quantas vezes o orçamento já foi reduzido por recusa de tamanho do provedor.
    reducoes = 0
    #: Passos seguidos com ferramenta e sem uma linha de texto. Chegando em
    #: `MAX_SILENCIO`, o loop cobra a narração em vez de deixar o modelo seguir calado: é
    #: o caso dos modelos que só falam no fim, e quem está olhando não tem como saber se
    #: ele está trabalhando ou parado.
    silencio = 0
    #: Quantas chamadas de código já foram trocadas pela ferramenta certa (ver
    #: `oportunidade_de_ferramenta`).
    trocas = 0
    #: Ferramentas que rodaram **de verdade** nesta tarefa (as que falharam não contam) e
    #: quantas vezes o loop já cobrou a execução de um anúncio sem ação.
    ferramentas_ok = 0
    cobrancas = 0
    #: Quantas vezes um passo que terminou em anúncio foi refeito com a ferramenta
    #: obrigatória (`tool_choice: "required"`) — ver o laço logo abaixo.
    forcadas = 0
    #: O que a pessoa (ou a configuração) bloqueou: ação negada no cartão de permissão ou
    #: ferramenta desligada. Bloqueio não é erro de argumento — o certo ali é explicar e
    #: mudar de caminho, e não cobrar a mesma chamada de novo.
    bloqueios = 0
    #: Quantas vezes a tarefa foi retomada por ter parado com itens do plano em aberto.
    retomadas = 0
    #: Id do comando que ficou rodando (a olhada devolveu "AINDA RODANDO"). Enquanto
    #: existir, a tarefa não fecha por texto: o modelo acompanha (`continuar`) ou para
    #: (`parar`) — fechar com um processo vivo deixa o comando rodando sem ninguém olhando.
    comando_rodando: str | None = None
    #: Quantas falas já foram **forçadas** (passo sem ferramenta) nesta tarefa.
    narracoes = 0
    #: Leituras já feitas nesta tarefa (chave da chamada → saída) e quantas vezes cada uma
    #: foi repetida. Corta o "lê o mesmo arquivo cinco vezes" sem inventar resultado: a
    #: memória é esvaziada a cada chamada que mexe no disco.
    leituras: dict[str, str] = {}
    repetidas: dict[str, int] = {}
    #: `ferramentas_ok` na última retomada: é o que diz se houve progresso desde então.
    retomada_base = 0
    #: O pedido é uma ação? Decide se uma resposta de texto pode encerrar a tarefa.
    de_acao = pedido_de_acao(mensagens)
    #: Tamanho do histórico no último aviso de compactação (ver o bloco no laço).
    avisado = 0
    #: Tarefa grande: começa com plano. `todos` é a última lista registrada, e
    #: `plano_feito` diz se ela já existe (é o que libera a execução).
    grande = pedido_grande(mensagens)
    todos: list[dict[str, Any]] = []
    plano_feito = False
    if grande:
        # A instrução entra como mensagem de pessoa, depois do pedido: é o formato que o
        # provedor aceita, e o modelo lê o "divida antes de executar" junto do pedido.
        historico.append({"role": "user", "content": DIVIDIR_TAREFA})
    limite = time.monotonic() + timeout_s if timeout_s else None

    # `max_steps` zero ou negativo é **sem teto de passos**. Tarefa grande de verdade não
    # cabe em número fixo: montar um projeto, refatorar um módulo ou rodar uma bateria de
    # testes passa de qualquer teto pequeno no meio de trabalho legítimo. Quem impede um
    # loop infinito aqui é o tempo (`timeout_s`), o contador de respostas vazias e o botão
    # de parar — não um número de passos.
    teto = max_steps if max_steps and max_steps > 0 else None
    numeros = count(1) if teto is None else range(1, teto + 1)

    for numero in numeros:
        if limite and time.monotonic() > limite:
            motivo = "o tempo da tarefa acabou antes de terminar"
            break

        # Projeto grande: o histórico do loop cresce a cada saída de ferramenta. Antes de
        # pedir o próximo passo, o que já foi resolvido encolhe — senão o pedido passa do
        # que o provedor aceita e a tarefa morre no meio, sem relação nenhuma com a
        # dificuldade do trabalho.
        tokens_antes, tokens_depois = contexto.compactar_historico(historico, orcamento)
        if tokens_depois and tokens_depois < tokens_antes:
            # O aviso aparece uma vez por "salto" de tamanho, e não a cada passo: a
            # compactação acontece ciclicamente numa tarefa longa (enche, encolhe, enche),
            # e repetir a mesma linha vinte vezes sujaria a conversa sem dizer nada novo.
            if tokens_antes - avisado >= max(1, orcamento // 4):
                avisado = tokens_antes
                await emit(
                    "delta",
                    {
                        "text": f"\n\n_(contexto compactado: ~{tokens_antes // 1000}k → "
                        f"~{tokens_depois // 1000}k tokens — o que já foi feito segue no "
                        "resumo)_\n\n"
                    },
                )

        # `estado` conta se o texto deste passo já saiu na tela pedaço a pedaço.
        estado = {"mostrou": False}
        try:
            resultado = await _com_tentativas(
                modelo,
                historico,
                tools,
                emit,
                numero,
                model,
                limite,
                tentativas,
                espera_final,
                estado,
                reasoning,
                effort,
            )
        except ContextoEstourado:
            # O provedor recusou o tamanho. O orçamento é estimativa; aqui ele vira o
            # limite **real**: encolhe pela metade e manda o mesmo passo de novo, em vez
            # de mostrar "context length exceeded" para quem pediu uma tarefa.
            if orcamento <= 0 or reducoes >= MAX_REDUCOES or orcamento <= MINIMO_ORCAMENTO:
                motivo = "o provedor recusou o tamanho do pedido e não coube nem reduzido"
                texto_final = (
                    "Não consegui continuar: o provedor recusou o pedido por tamanho e o "
                    "contexto já estava reduzido. Divida a tarefa em partes menores — "
                    "assim cada parte cabe no que o modelo aceita."
                )
                break
            reducoes += 1
            orcamento = max(MINIMO_ORCAMENTO, orcamento // 2)
            contexto.compactar_historico(historico, orcamento, janela=4)
            await emit(
                "delta",
                {
                    "text": "\n\n_(o provedor recusou o tamanho do pedido: encolhi o "
                    f"contexto para ~{orcamento // 1000}k tokens e sigo daqui)_\n\n"
                },
            )
            continue
        if resultado is None:
            motivo = "não consegui falar com o provedor"
            break

        _somar(uso, resultado.usage)
        contexto_usado = max(
            contexto_usado, int(resultado.usage.get("prompt_tokens", 0) or 0)
        )
        historico.append(_mensagem_assistente(resultado))

        if not resultado.calls and not resultado.text.strip():
            # Resposta vazia: empurra a continuação e segue — **sem** avisar na conversa.
            # O teto continua existindo só para provedor quebrado não girar para sempre
            # queimando cota; ele é alto de propósito, porque desistir cedo era o defeito.
            vazias += 1
            if vazias >= MAX_VAZIAS:
                motivo = f"o provedor respondeu vazio {vazias} vezes seguidas"
                break
            historico.append({"role": "user", "content": CONTINUAR})
            continue

        if resultado.text.strip():
            # Texto intermediário também aparece na tela; o respiro separa a narração
            # do que vem depois das ferramentas.
            sufixo = "\n\n" if resultado.calls else ""
            if estado["mostrou"]:
                # O texto já saiu pedaço a pedaço durante o passo: repetir aqui
                # duplicaria tudo o que o usuário já leu. Só o respiro entra.
                if sufixo:
                    await emit("delta", {"text": sufixo})
            else:
                await emit("delta", {"text": resultado.text + sufixo})

        if not resultado.calls:
            # Anúncio sem execução ("agora vou verificar…" e nenhuma ferramenta): o passo
            # é REFEITO com a ferramenta **obrigatória**. Sem bronca no histórico: o
            # anúncio sai da conversa (para não virar exemplo) e o trabalho acontece.
            #
            # Duas forças, porque uma só não cobre o catálogo: a primeira tentativa vai de
            # `tool_choice: "required"`; da segunda em diante a ferramenta é apontada pelo
            # nome, porque o `liz-nano` (medido) ignora a obrigatoriedade genérica e chama
            # quando a função é dita.
            #
            # `comando_rodando` entra aqui pelo mesmo motivo, e é o caso do comando longo:
            # com um processo vivo, fechar a tarefa por texto deixa o comando rodando sem
            # ninguém olhando — o modelo tem de decidir (acompanhar ou parar).
            while (
                (anunciou(resultado.text) or comando_rodando)
                and (ferramentas_ok or de_acao)
                and forcadas < MAX_FORCADAS
            ):
                forcadas += 1
                escolha = escolha_forcada(resultado.text, forcadas)
                historico.pop()  # o anúncio texto-only sai do histórico
                if comando_rodando:
                    # Comando vivo manda mais do que o anúncio: o que falta decidir é o que
                    # fazer com ele (acompanhar ou parar), e a ferramenta disso é o `shell`.
                    # Apontar a função pelo nome é mais direto do que `required` — o modelo
                    # já sabe qual é.
                    escolha = {"type": "function", "function": {"name": "shell"}}
                    historico.append(
                        {
                            "role": "user",
                            "content": acompanhar_comando(comando_rodando),
                        }
                    )
                forcado = await _com_tentativas(
                    modelo,
                    historico,
                    tools,
                    emit,
                    numero,
                    model,
                    limite,
                    tentativas,
                    espera_final,
                    {"mostrou": False},
                    reasoning,
                    effort,
                    escolha,
                )
                if forcado is None:
                    break
                _somar(uso, forcado.usage)
                contexto_usado = max(
                    contexto_usado, int(forcado.usage.get("prompt_tokens", 0) or 0)
                )
                historico.append(_mensagem_assistente(forcado))
                if forcado.text.strip():
                    await emit(
                        "delta",
                        {"text": forcado.text + ("\n\n" if forcado.calls else "")},
                    )
                resultado = forcado

        if not resultado.calls:
            # Resposta de texto: **candidata** a fechamento. Antes de aceitar, os portões
            # (`portao_de_parada`) olham o **estado** da tarefa — lista em aberto, mudança
            # sem prova, anúncio sem execução — e, se algum acusar trabalho pendente, a
            # conversa continua com uma cobrança. O texto já saiu na tela e é ele que fica
            # guardado: nenhum portão custa a resposta.
            pendentes = [item for item in todos if not item.get("feito")]
            # Trabalho feito desde a última retomada devolve o fôlego: numa tarefa longa o
            # agente narra e para várias vezes no caminho, e cada parada dessas gastava uma
            # retomada até o teto acabar no meio de trabalho que estava andando bem.
            if pendentes and ferramentas_ok > retomada_base:
                retomada_base = ferramentas_ok
                retomadas = 0
            # O sinal mais forte que existe, porque não depende do que o modelo escreveu:
            # é o que ele mesmo registrou que faltava fazer.
            if pendentes and retomadas < MAX_RETOMADAS:
                retomadas += 1
                historico.append({"role": "user", "content": retomar_tarefa(pendentes)})
                continue

            portao = portao_de_parada(
                resultado.text,
                plano_aberto=bool(pendentes),
                cobrancas=cobrancas,
                ferramentas_ok=ferramentas_ok,
                de_acao=de_acao,
                bloqueios=bloqueios,
            )
            if portao is not None:
                cobrancas += 1
                historico.append({"role": "user", "content": portao})
                continue

            texto_final = resultado.text
            completou = True
            # Cobrou o máximo e não adiantou: em vez de deixar na tela um plano que parece
            # trabalho feito, o fechamento diz o que **de fato** faltou.
            if pendentes:
                completou = False
                motivo = f"a lista ficou com {len(pendentes)} item(ns) pendente(s)"
                falta = "; ".join(str(item.get("texto", "")) for item in pendentes[:6])
                # A frase tem de ser verdadeira nos dois casos: quem não executou nada ouve
                # que nada mudou no disco; quem executou parte e parou ouve só o que falta
                # — dizer "nada foi executado" depois de o agente ter criado arquivos era
                # uma mentira na cara de quem viu as ferramentas rodando.
                texto_final = (
                    f"Não terminei a tarefa: falta {falta}. "
                    + (
                        "O que já foi feito está no disco. "
                        if ferramentas_ok
                        else "Nada disso foi executado. "
                    )
                    + 'Me diga "continue" que eu sigo do próximo item.'
                )
            elif precisa_cobrar(
                resultado.text,
                de_acao=de_acao,
                ferramentas_ok=ferramentas_ok,
                bloqueios=bloqueios,
            ):
                completou = False
                motivo = "o modelo encerrou anunciando o próximo passo, sem executá-lo"
                texto_final = (
                    "Não consegui concluir a tarefa: o modelo parou de agir mesmo com a "
                    "ferramenta obrigatória. "
                    + (
                        "O que já foi feito está no disco."
                        if ferramentas_ok
                        else "Nada mudou no disco."
                    )
                )
            break

        for chamada in resultado.calls:
            argumentos = _argumentos(chamada)
            await emit(
                "tool_call",
                {
                    "id": chamada.id,
                    "name": chamada.name,
                    "arguments": argumentos,
                    "step": numero,
                },
            )

            # O plano é a única ferramenta cujo **conteúdo** a interface precisa ver: a
            # lista vai como evento próprio, em vez de ficar escondida num resultado de
            # ferramenta que a pessoa teria de abrir para ler.
            if chamada.name == ferramentas.FERRAMENTA_DO_PLANO:
                itens = ferramentas.todos_dos_argumentos(argumentos)
                if itens:
                    todos = itens
                    plano_feito = True
                    await emit("todos", {"todos": itens, "step": numero})

            # Antes de mexer na máquina, a permissão. O que precisa de permissão é
            # decidido por `ferramentas.classificar` + `approvals`; aqui só se espera a
            # resposta (que pode ser um «sempre» já lembrado, sem passar pela tela).
            acao = ferramentas.classificar(chamada.name, argumentos, workspace)
            # A autorização desta chamada. Sair da pasta de trabalho é coisa que se
            # **pede**: quando a pessoa diz «sim» (ou «sempre», e aí a regra fica
            # lembrada), esta chamada roda com acesso livre. Sem isto o cartão prometia
            # uma autorização que a ferramenta recusava em seguida — e o modelo, sem
            # saída, ia fazer o mesmo com Python.
            liberado = acesso_livre
            if acao is not None and aprovar is not None:
                decisao = await aprovar(acao)
                if decisao in ("sim", "sempre") and ferramentas.fora_da_pasta(
                    chamada.name, argumentos, workspace
                ):
                    liberado = True
                if decisao in ("nao", "nunca"):
                    saida = (
                        f"ERRO: a pessoa negou esta ação ({acao['titulo']}). Não repita a "
                        "mesma chamada: siga por outro caminho ou explique o que precisa."
                    )
                    duracao = 0
                    ok = False
                    passo = ToolStep(
                        name=chamada.name,
                        arguments=argumentos,
                        output=saida,
                        duration_ms=0,
                        call_id=chamada.id,
                        ok=False,
                    )
                    passos.append(passo)
                    bloqueios += 1
                    await emit(
                        "tool_result",
                        {
                            "id": chamada.id,
                            "name": chamada.name,
                            "output": saida,
                            "duration_ms": 0,
                            "ok": False,
                            "step": numero,
                            "negado": True,
                        },
                    )
                    historico.append(
                        {"role": "tool", "tool_call_id": chamada.id, "content": saida}
                    )
                    continue

            # Código fazendo o que tem ferramenta própria (pathlib/shutil/open no
            # code_interpreter e no shell): não executa. O modelo recebe o caminho certo
            # e a chance de chamar a ferramenta — que é o que mantém a operação dentro da
            # pasta de trabalho e sob o cartão de permissão.
            oportunidade = oportunidade_de_ferramenta(chamada.name, argumentos)
            negado_por_codigo = oportunidade is not None and (
                oportunidade.critica or trocas < TROCAS_POR_CODIGO
            )
            if negado_por_codigo:
                trocas += 1

            inicio = time.perf_counter()
            chave = _chave_da_chamada(chamada.name, argumentos)
            repetida = chamada.name in SO_LEITURA and chave in leituras
            if repetida:
                # A mesma leitura, com o disco parado desde a primeira vez: o resultado é o
                # mesmo, e repetir a execução só gasta o tempo da tarefa. O que volta é o
                # resultado de antes **com o aviso**, para o modelo parar de rodar em círculo.
                repetidas[chave] = repetidas.get(chave, 0) + 1
                saida = (
                    f"(você já pediu exatamente isto antes, e nada mudou no disco desde "
                    f"então — é a {repetidas[chave]}ª vez. O resultado é o mesmo:)\n"
                    + leituras[chave]
                )
                if repetidas[chave] >= 2:
                    saida += (
                        "\n\nPARE de repetir esta chamada: você já tem o resultado. Use o que "
                        "está acima e siga para o próximo passo da tarefa — ou diga o que "
                        "falta, se não houver mais o que fazer."
                    )
            else:
                saida = (
                    aviso_de_ferramenta(oportunidade)
                    if negado_por_codigo and oportunidade is not None
                    else await asyncio.to_thread(
                        ferramentas.executar,
                        chamada.name,
                        argumentos,
                        workspace,
                        negadas,
                        acesso_livre=liberado,
                    )
                )
                if chamada.name in SO_LEITURA:
                    leituras[chave] = saida
                elif chamada.name in MUDAM_ARQUIVO or chamada.name in EXECUTAM:
                    # Mexeu no disco: o que estava guardado deixou de ser verdade. Guardar
                    # leitura velha e devolvê-la depois seria mentir para o modelo.
                    leituras.clear()
                    repetidas.clear()
            duracao = int((time.perf_counter() - inicio) * 1000)
            ok = saida_ok(saida, chamada.name)
            if ok:
                # O plano **não** conta como trabalho feito: quem só registrou a lista ainda
                # não mudou nada no disco, e é isso que as cobranças abaixo medem.
                if chamada.name != ferramentas.FERRAMENTA_DO_PLANO:
                    ferramentas_ok += 1
            elif any(marca in saida for marca in SEM_CONSERTO):
                bloqueios += 1

            # Comando que passou da olhada continua vivo: guarda o id para a tarefa não
            # fechar com ele rodando (ver o `while` do anúncio, mais abaixo).
            if AINDA_RODANDO.search(saida):
                comando_rodando = AINDA_RODANDO.search(saida).group(1)  # type: ignore[union-attr]
            elif chamada.name in ("shell", "terminal"):
                comando_rodando = None

            passo = ToolStep(
                name=chamada.name,
                arguments=argumentos,
                output=saida,
                duration_ms=duracao,
                call_id=chamada.id,
                ok=ok,
            )
            passos.append(passo)
            await emit(
                "tool_result",
                {
                    "id": chamada.id,
                    "name": chamada.name,
                    "output": saida,
                    "duration_ms": duracao,
                    "ok": ok,
                    "step": numero,
                },
            )
            historico.append(
                {"role": "tool", "tool_call_id": chamada.id, "content": saida}
            )

        # Fim do passo: o modelo pediu ferramenta e não disse nada. Conta; e, se já passou
        # do limite, cobra uma linha antes de continuar. Vai como mensagem de pessoa porque
        # é assim que o provedor aceita — depois dos resultados das ferramentas, sem
        # atropelar o casamento de `tool_call_id` que o host exige.
        silencio = 0 if resultado.text.strip() else silencio + 1
        if silencio >= MAX_SILENCIO and narracoes < MAX_NARRACOES:
            silencio = 0
            narracoes += 1
            # A cobrança entra no histórico **antes** do passo seguinte: custa zero chamada
            # extra. Tentar forçar a fala num passo só dela (sem ferramenta na mão) foi
            # medido e **descartado**: o gateway recusou esse pedido (400) e o ganho não
            # justificava uma chamada a mais por narração. O que faz esses modelos falarem é
            # o teto de tokens de saída (ver `MAX_TOKENS_SAIDA`): eles gastam o orçamento
            # pensando, e com teto pequeno não sobra nada para a linha.
            historico.append({"role": "user", "content": NARRAR})

        # O passo só registrou a lista: nada foi tentado, então não há erro para consertar.
        # Dizer "nenhuma ferramenta funcionou" aqui é falso e confunde — a cobrança certa
        # (lista com itens em aberto) aparece no passo seguinte, se o trabalho parar.
        so_plano = bool(resultado.calls) and all(
            chamada.name == ferramentas.FERRAMENTA_DO_PLANO for chamada in resultado.calls
        )

        # Nenhuma ferramenta desta tarefa funcionou até agora: numa tarefa de ação, isso não
        # é "não havia o que fazer" — é erro de argumento que precisa ser lido e corrigido.
        # Tarefa grande que arrancou sem plano: a lista é cobrada antes de o trabalho
        # continuar. Só uma vez — da segunda em diante, insistir só toma o tempo.
        if grande and not plano_feito and resultado.calls and cobrancas < MAX_COBRANCAS:
            cobrancas += 1
            historico.append({"role": "user", "content": EXIGIR_PLANO})

        if (
            not ferramentas_ok
            and not so_plano
            and de_acao
            and not bloqueios
            and cobrancas < MAX_COBRANCAS
        ):
            cobrancas += 1
            historico.append({"role": "user", "content": CONSERTAR_FERRAMENTA})

    if not completou and not texto_final:
        # A tarefa acabou no meio (teto de passos, tempo esgotado, provedor mudo).
        # A frase precisa dizer o que aconteceu **e** o que fazer agora: parar calado
        # deixa quem está olhando sem saber se ele ainda está trabalhando ou desistiu.
        if not motivo:
            motivo = (
                f"limite de {teto} passos atingido antes de terminar"
                if teto is not None
                else "a tarefa terminou sem resposta final"
            )
        texto_final = (
            f"Não terminei a tarefa: {motivo}. O que já foi feito está no disco."
        )

    return Resultado(
        texto=texto_final,
        passos=passos,
        completou=completou,
        uso=uso,
        contexto=contexto_usado,
        motivo=motivo,
        todos=todos,
    )


#: Código de saída no começo da saída de um comando/script (`_formatar`).
EXIT_CODE = re.compile(r"^exit code:\s*(-?\d+)", re.MULTILINE)

#: Ferramentas em que sair com código diferente de zero **não** é falha: o trabalho delas é
#: relatar o que encontraram, e "encontrei problemas" é resposta certa. O linter sobre um
#: arquivo com erro de sintaxe sai 1; `grep` sem acerto sai 1; `git diff` sem mudança sai 0
#: e `git status` sai 0 — para estas, o código de saída não diz nada sobre o trabalho.
SAIDA_NAO_E_FALHA = (
    "get_problems",
    "linter",
    "regex_search",
    "search_codebase",
    "search_files",
    "git_status",
    "git_diff",
    "git_log",
)


def saida_ok(saida: str, ferramenta: str = "") -> bool:
    """A ferramenta funcionou?

    Duas fontes de verdade: o `ERRO:` que as ferramentas devolvem em texto e o **código de
    saída** de quem rodou de verdade. Sem a segunda, um script que morreu com Traceback
    entrava no histórico como sucesso: o cartão da ferramenta ficava normal na tela (foi o
    caso de um `code_interpreter` que estourou `UnicodeEncodeError` e voltou como `ok`), o
    modelo achava que tinha dado certo e o loop não cobrava a correção.
    """
    limpo = (saida or "").lstrip()
    if limpo.startswith("ERRO"):
        return False
    if ferramenta in SAIDA_NAO_E_FALHA:
        return True
    codigo = EXIT_CODE.search(limpo)
    return not (codigo and int(codigo.group(1)) != 0)


def _mensagem_assistente(resultado: StepResult) -> dict[str, Any]:
    mensagem: dict[str, Any] = {"role": "assistant"}
    mensagem["content"] = resultado.text or None
    if resultado.calls:
        mensagem["tool_calls"] = [chamada.para_mensagem() for chamada in resultado.calls]
    return mensagem


async def _esperar(segundos: float, limite: float | None) -> bool:
    """Dorme respeitando o que resta do orçamento da tarefa; `False` se já acabou."""
    restante = _faltando(limite)
    if restante is not None and restante <= 0:
        return False
    await asyncio.sleep(segundos if restante is None else min(segundos, restante))
    return True


async def _trocar_conta(modelo: ToolModel, emit: Emit, numero: int) -> bool:
    """Pede outra conta ao provedor, quando ele sabe fazer isso (proxy com painel de contas)."""
    rotacionar = getattr(modelo, "rotate", None)
    if rotacionar is None:
        return False
    try:
        perfil = await rotacionar()
    except Exception:  # noqa: BLE001 — girar conta é melhor esforço, nunca derruba a tarefa
        return False
    if not perfil:
        return False
    return True


async def _executar_passo(
    modelo: ToolModel,
    historico: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    model: str,
    emit: Emit,
    estado: dict[str, bool],
    reasoning: bool = True,
    effort: str | None = None,
    escolha_ferramenta: str | dict[str, Any] | None = None,
) -> StepResult | None:
    """Roda um passo narrando o texto conforme ele é escrito.

    Quando o provedor sabe streamar com ferramentas (`step_streaming`), o texto do passo
    sai na tela enquanto o modelo escreve — antes isso só existia no `step()`, que é
    `stream: false` e devolvia o passo inteiro num delta só. Sem `step_streaming` cai no
    `step()` de sempre.

    `estado["mostrou"]` vira `True` na primeira vez que sai texto: quem chama usa isso para
    não repetir um passo que já apareceu na tela.

    `escolha_ferramenta` vai como `tool_choice` no pedido — usado quando o passo anterior
    terminou num anúncio sem execução (ver `escolha_forcada` e `MAX_FORCADAS`).
    """
    streamar = getattr(modelo, "step_streaming", None)
    if streamar is None:
        return await modelo.step(
            historico, tools, model, escolha_ferramenta=escolha_ferramenta
        )

    resultado: StepResult | None = None
    async for item in streamar(
        historico, tools, model, reasoning, effort, escolha_ferramenta=escolha_ferramenta
    ):
        if isinstance(item, StepResult):
            resultado = item
            continue
        if item.reasoning:
            # Raciocínio não é resposta: vai para a tela, mas não conta como "mostrou".
            await emit("reasoning", {"text": item.text})
            continue
        estado["mostrou"] = True
        await emit("delta", {"text": item.text})
    return resultado


async def _com_tentativas(
    modelo: ToolModel,
    historico: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    emit: Emit,
    numero: int,
    model: str = "",
    limite: float | None = None,
    tentativas: int = MAX_TENTATIVAS,
    espera_final: float = 0.0,
    estado: dict[str, bool] | None = None,
    reasoning: bool = True,
    effort: str | None = None,
    escolha_ferramenta: str | dict[str, Any] | None = None,
) -> StepResult | None:
    """Reenvia o passo quando quem falhou foi o provedor — e não desiste na primeira.

    Três defesas, nesta ordem: erro de cota/indisponibilidade é repetido com backoff
    (sob 429, martelar piora); erro "de vez" (400/401/403) ganha **uma** segunda chance
    em outra conta, quando o provedor expõe `rotate()` — é assim que cota por conta falha
    no meio de uma conversa; e, se tudo cair, ainda espera a janela curta de cooldown e
    tenta uma última vez — um 429 em rajada passa em segundos.
    """
    from ..providers.base import ProviderError, TransientProviderError

    restantes = max(1, tentativas)
    fatais = 1  # uma segunda chance por erro não-transitório, se houver outra conta
    ultima_cartada = espera_final > 0
    #: `estado["mostrou"]` vira `True` quando já saiu texto na tela: repetir o passo
    #: duplicaria o que o usuário já leu, então nesse caso é melhor parar e avisar.
    if estado is None:
        estado = {"mostrou": False}

    while True:
        try:
            return await _executar_passo(
                modelo, historico, tools, model, emit, estado, reasoning, effort,
                escolha_ferramenta,
            )
        except TransientProviderError as error:
            if estado["mostrou"]:
                await emit(
                    "delta",
                    {"text": f"\n\n[o provedor caiu no meio do passo {numero}: {error}]\n"},
                )
                return None
            restantes -= 1
            if restantes > 0:
                usadas = max(1, tentativas - restantes)
                await _trocar_conta(modelo, emit, numero)
                if not await _esperar(min(ESPERA_BASE * usadas, 10), limite):
                    return None
                continue
            if ultima_cartada:
                ultima_cartada = False
                restantes = 1
                if not await _esperar(espera_final, limite):
                    return None
                continue
            await emit(
                "delta", {"text": f"\n\n[erro do provedor no passo {numero}] {error}\n"}
            )
            return None
        except ProviderError as error:
            if estado["mostrou"]:
                await emit(
                    "delta",
                    {"text": f"\n\n[o provedor caiu no meio do passo {numero}: {error}]\n"},
                )
                return None
            # Recusa por tamanho é a única falha "de vez" que tem conserto daqui: o loop
            # encolhe o contexto (ver `ContextoEstourado` em `executar`). Checar antes de
            # girar conta — outra conta não faz o pedido caber.
            if contexto.estouro_de_contexto(str(error)):
                raise ContextoEstourado(str(error)) from error
            if fatais > 0 and await _trocar_conta(modelo, emit, numero):
                fatais -= 1
                continue
            await emit("delta", {"text": f"[erro do provedor no passo {numero}] {error}"})
            return None
