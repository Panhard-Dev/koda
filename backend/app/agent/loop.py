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
import hashlib
import json
import re
import threading
import time
from itertools import count
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .. import caminhos_marcados
from ..tools import ferramentas, registry
from .. import economia, mcp, ui_documento
from ..config import Settings, get_settings
from ..policy import guards
from . import contexto, dsml, historico_ferramentas, instrucoes_projeto, repeticao, subagente, validacao_ferramentas
from ..limits import LIMITES
from ..contracts.turn import StepResult, ToolCall, ToolStep, texto_do_conteudo
from ..contracts.tool_result import ToolResult
from ..contracts.control import ControlHistory
from ..contracts import mudancas
from .completion import verificar_arquivos, requires_effect
from .budget import task_budget, current as current_budget, BudgetExhausted

from .prompts import PROMPT_FERRAMENTAS, PLANEJAMENTO

#: O que a pessoa pediu nesta rodada. É a régua do "faça exatamente o que foi pedido,
#: nada além": a categoria é decidida **antes** do primeiro passo e decide o catálogo.
MODO_RESPOSTA = "resposta"
MODO_CODIGO = "codigo"


# ---------------------------------------------------------------- plano e tarefa grande

#: O pedido é grande o bastante para valer um plano antes de executar?
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
    "`atual: true`). Em seguida abra o cartão chamando a ferramenta **`mostrar_plano`** "
    "com `titulo`, `o_que_e`, `pra_que`, `por_que`, `como` (lista de "
    '{"titulo":"...","texto":"..."}), `mudancas` (lista de '
    '{"arquivo":"...","texto":"..."}) e `resultado`. A ferramenta desenha o cartão — não '
    "escreva o plano em prosa. Se `mostrar_plano` não estiver no catálogo, use o bloco "
    "```koda-plano``` com o mesmo JSON. Pergunte se pode começar — só execute depois do "
    "sim. Quando a pessoa aceitar, execute item a item e, a cada item terminado, chame "
    "`update_todos` de novo com a lista atualizada."
)

EXIGIR_PLANO = (
    "Você começou a executar sem registrar o plano, e esta tarefa é grande. Chame "
    "`update_todos` AGORA com todos os itens (o que já fez marcado com `feito: true`, o "
    "próximo com `atual: true`) e siga daí, mantendo a lista em dia."
)


# ---------------------------------------------------------------- erros do provedor

#: Onde os provedores costumam guardar a frase legível dentro do corpo do erro.
_CHAVES_DE_MENSAGEM = (
    "message",
    "mensagem",
    "msg",
    "detail",
    "error_description",
    "reason",
    "description",
    "text",
)


def _texto_de_erro(valor: Any, profundidade: int = 0) -> str | None:
    """A frase legível de um corpo de erro, seja qual for o formato do provedor."""
    if profundidade > 3:
        return None
    if isinstance(valor, str):
        texto = valor.strip()
        return texto or None
    if isinstance(valor, dict):
        for chave in _CHAVES_DE_MENSAGEM:
            achado = _texto_de_erro(valor.get(chave), profundidade + 1)
            if achado:
                return achado
        if "error" in valor:
            return _texto_de_erro(valor["error"], profundidade + 1)
    if isinstance(valor, list) and valor:
        return _texto_de_erro(valor[0], profundidade + 1)
    return None


def _codigo_do_erro(valor: Any, profundidade: int = 0) -> str | None:
    """O código do erro (`insufficient_credits`, `invalid_api_key`…), quando existe."""
    if profundidade > 3:
        return None
    if isinstance(valor, dict):
        for chave in ("code", "codigo", "type"):
            codigo = valor.get(chave)
            if isinstance(codigo, str) and codigo.strip():
                return codigo.strip()
        if "error" in valor:
            return _codigo_do_erro(valor["error"], profundidade + 1)
    if isinstance(valor, list) and valor:
        return _codigo_do_erro(valor[0], profundidade + 1)
    return None


def _recusa_em_portugues(codigo: str, detalhe: str) -> str:
    """Traduz as recusas mais comuns; o resto sai como o provedor escreveu."""
    baixo = f"{codigo} {detalhe}".lower()
    if (
        "insufficient_credits" in baixo
        or "insufficient balance" in baixo
        or "no credit" in baixo
        or "credit balance" in baixo
        or "insufficient_quota" in baixo
        or "quota exhausted" in baixo
        or "exceeded your current quota" in baixo
    ):
        return "a conta do provedor está sem créditos — recarregue e tente de novo"
    if (
        "invalid_api_key" in baixo
        or "invalid api key" in baixo
        or "unauthorized" in baixo
        or "authentication" in baixo
    ):
        return "a credencial da conta do provedor foi recusada — reconecte a conta no Koda"
    if "rate_limit" in baixo or "rate limit" in baixo or "too many requests" in baixo:
        return "o provedor está limitando os pedidos agora — espere um pouco e tente de novo"
    return detalhe


def motivo_do_provedor(erro: BaseException | str) -> str:
    """O que mostrar quando o provedor recusa: uma frase, nunca o JSON cru.

    Vários adaptadores colocam o corpo HTTP inteiro dentro do `ProviderError`. Sem
    isto, a conversa exibia `{"error":{"code":...}}` como se fosse a resposta — o
    celular parecia quebrado. Aqui o JSON vira a explicação de dentro dele; o
    cabeçalho humano do adaptador («o provedor respondeu 402») é mantido.
    """
    texto = str(erro).strip()
    inicio = texto.find("{")
    if inicio < 0:
        return texto[:600]
    try:
        corpo, _ = json.JSONDecoder().raw_decode(texto[inicio:])
    except (ValueError, TypeError):
        return texto[:600]

    detalhe = _texto_de_erro(corpo)
    codigo = _codigo_do_erro(corpo)
    prefixo = texto[:inicio].strip().rstrip(":;,-")
    if detalhe:
        frase = _recusa_em_portugues(codigo or "", detalhe)
        return (f"{prefixo}: {frase}" if prefixo else frase)[:600]
    if codigo:
        frase = _recusa_em_portugues(codigo, "")
        return (f"{prefixo}: {frase}" if prefixo else frase)[:600]
    if prefixo:
        return prefixo[:600]
    return "o provedor recusou o pedido sem explicar o motivo"

#: Cobrança interna quando o plano foi registrado mas **não** foi apresentado no bloco
#: visual — o caso do plano que sai em prosa e a pessoa nem vê a interface. Depois dela,
#: o próximo texto do modelo tem de ser o bloco (e nada de ferramenta).
EXIGIR_BLOCO_PLANO = (
    "O plano desta tarefa não está no cartão visual — e é nele que a pessoa decide. "
    "Chame agora a ferramenta `mostrar_plano` com `titulo`, `o_que_e`, `pra_que`, "
    "`por_que`, `como` (lista de `{titulo, texto}`), `mudancas` (lista de "
    "`{arquivo, texto}`) e `resultado`. Se ela não estiver no catálogo, apresente o mesmo "
    "plano num único bloco ```koda-plano``` com **JSON válido** (nada de lista em prosa "
    "dentro do bloco). Depois PARE: nenhuma outra ferramenta, porque quem autoriza o "
    "começo é a pessoa, não você."
)

#: O plano apresentado no cartão interativo. É esta marca (e não vocabulário de "plano")
#: que o portão procura no texto do modelo.
BLOCO_PLANO = re.compile(r"```koda-plano\b", re.IGNORECASE)

#: A fala da pessoa que **destrava** o plano. Lista conservadora de propósito: o portão
#: segura o trabalho, então um falso positivo aqui pularia o portão — e um falso negativo
#: só custa a pessoa dizer "pode começar" (ou apertar o botão do cartão).
FALA_ACEITE = re.compile(
    r"plano\s+aceito|aceito\s+o\s+plano|t[áa]\s+aprovado|aprov[oóa]|pode\s+come[çc]ar|"
    r"pode\s+iniciar|pode\s+seguir|manda\s+ver|vai\s+em\s+frente|bora\b|"
    r"continu[ae]\b|retom[ae]\b",
    re.IGNORECASE,
)


def _aceitou_plano(mensagens: list[dict[str, Any]]) -> bool:
    """A pessoa já disse «pode começar» (ou variante) na última fala dela?

    Olha a **última** mensagem de pessoa: o plano destrava pela resposta ao cartão, não
    por um sim antigo no meio da conversa. Mensagens internas do loop não contam — elas
    entram no `historico`, nunca nas `mensagens` originais.
    """
    # Texto livre (inclusive citação, negação ou pergunta) nunca concede capacidade.
    # A decisão é consumida de forma transacional pela rota antes desta rodada.
    return False


#: O bloco visual que carrega quiz. Se o texto já tem **qualquer** bloco `koda-visual`,
#: o modelo usou a interface — e a cobrança do portão não se aplica (a prosa em volta é
#: só companhia do bloco, que é o que a pessoa clica).
BLOCO_QUIZ = re.compile(r"```koda-visual\b", re.IGNORECASE)

#: Uma pergunta numerada ("1. Qual é..." / "3) Em que ano...") no texto corrido.
PERGUNTA_NUMERADA = re.compile(r"^\s*\d+[.)]\s+.+\?", re.MULTILINE)

#: Vocabulário de quiz — só dispara junto com a lista numerada, para não pegar lista
#: técnica ("3 passos?") nem sumário de conversa.
ASSUNTO_QUIZ = re.compile(
    r"\bquiz\b|\bteste\s+(seu|de)\s+conhecimento\b|\bperguntas\b|corrig|sua\s+nota|"
    r"\bresponda\b",
    re.IGNORECASE,
)

#: Cobrança interna do portão do quiz: o modelo escreveu as perguntas como texto e a
#: pessoa fica sem clicar em nada. Vale para o modelo responder de novo, e não para
#: avisar quem está olhando.
EXIGIR_BLOCO_QUIZ = (
    "Você escreveu o quiz como texto corrido — assim a pessoa não consegue responder "
    "clicando. Reapresente as MESMAS perguntas em blocos ```koda-visual``` do tipo "
    "`quiz`, um bloco por pergunta, cada um com o JSON "
    '{"tipo":"quiz","pergunta","opcoes","correta","explicacao"} — o campo '
    '`"tipo":"quiz"` é obrigatório; sem ele a interface não desenha o quiz — '
    "e não repita a lista em texto depois."
)


def _quiz_em_texto(texto: str) -> bool:
    """O modelo entregou quiz como lista de texto, sem bloco visual nenhum?

    O sinal é estrutural: três ou mais perguntas numeradas terminando em «?» + assunto
    de quiz. Três é o mínimo que distingue um quiz de verdade de um "quer perguntar
    algo?" no meio da resposta. Com bloco `koda-visual` no texto, não há o que cobrar.
    """
    if BLOCO_QUIZ.search(texto):
        return False
    perguntas = re.findall(r"^\s*\d+[.)]\s+.+\?", texto, re.MULTILINE)
    return len(perguntas) >= 3 and bool(ASSUNTO_QUIZ.search(texto))


# ------------------------------------------------------- portão do bloco perdido (geral)
#
# O quiz é um caso do problema geral: **dado que a interface desenha** entregue como
# texto. Os casos que o texto traem são três, e todos têm assinatura estrutural — não
# depende do modelo "lembrar" do prompt:
#
#   1. JSON de bloco com a etiqueta errada: ```json { "tipo": "barras", ... } — os dados
#      estão certos, o código da cerca é que não é `koda-visual`, e o Koda não desenha.
#   2. Tabela em markdown: a interface tem o bloco `tabela` (com balão, com hover) —
#      a versão em pipe é a mesma informação sem nada.
#   3. Quiz em lista numerada (o detector próprio, acima).
#
#: Os tipos que o Koda desenha — o que procura dentro de uma cerca ```json``` é um
#: destes valores em `"tipo"`.
TIPOS_KODA = (
    "barras|empilhadas|linhas|area|pizza|rosca|dispersao|bolha|radar|timeline|sankey|"
    "tabela|mapa|mapa-radial|passos|comparacao|diagrama|fluxograma|diffs|arvore|metrica|"
    "citacao|quiz|plano"
)
TIPO_DE_BLOCO_NO_JSON = re.compile(
    r'"tipo"\s*:\s*"(?:' + TIPOS_KODA + r')"\s*[,}]', re.IGNORECASE
)
CERCA_CODIGO = re.compile(r"```[a-zA-Z]*\s*\n(.*?)```", re.DOTALL)
LINHA_DE_TABELA = re.compile(r"^\s*\|.+\|\s*$", re.MULTILINE)
SEPARADOR_DE_TABELA = re.compile(r"^\s*\|[\s:|-]+\|\s*$", re.MULTILINE)

EXIGIR_ETIQUETA = (
    "Você montou os dados de um bloco visual, mas usou a etiqueta errada na cerca — "
    "com ```json``` o Koda NÃO desenha, mostra código cru. Reenvie o MESMO JSON dentro "
    "de um bloco ```koda-visual``` (ou ```koda-grafico```/```koda-mapa```, conforme o "
    "tipo) e não repita os dados em texto."
)

EXIGIR_TABELA = (
    "Você desenhou a resposta como tabela em texto puro — a interface tem o bloco "
    "`tabela`, que é clicável e legível. Reapresente num bloco ```koda-visual``` com o "
    "JSON {\"titulo\",\"colunas\":[...],\"linhas\":[[...]]} e não repita a tabela em "
    "markdown."
)


def _bloco_perdido(texto: str) -> str | None:
    """Dado desenhável entregue como texto? Devolve a cobrança, ou None se não há.

    Se o texto **já tem qualquer bloco koda-***, o modelo usou a interface — prosa em
    volta de bloco é companhia, não defeito. A ordem importa: etiqueta errada é o pior
    (mostra código cru na tela), depois tabela, depois quiz.
    """
    if re.search(r"```koda-", texto, re.IGNORECASE):
        return None
    for cerca in CERCA_CODIGO.finditer(texto):
        if TIPO_DE_BLOCO_NO_JSON.search(cerca.group(1)):
            return EXIGIR_ETIQUETA
    if SEPARADOR_DE_TABELA.search(texto) and len(LINHA_DE_TABELA.findall(texto)) >= 4:
        # header + separador + pelo menos duas linhas de dados
        return EXIGIR_TABELA
    if _quiz_em_texto(texto):
        return EXIGIR_BLOCO_QUIZ
    return None


#: A resposta **entregou** dado desenhável pela interface — bloco koda-* (quiz, tabela,
#: gráfico, mapa, plano). É o sinal único de "o pedido já está na tela do jeito que a
#: pessoa clica": uma resposta assim **fecha** a rodada, mesmo que carregue uma frase de
#: futuro ("posso montar mais uma rodada") ou que a rodada não tenha chamado ferramenta
#: nenhuma.
#:
#: Sem esta régua, o quiz/tabela/gráfico entregue certinho ainda recebia cutucão de
#: ferramenta ("nenhuma ferramenta sua funcionou") porque `de_acao` olha só o pedido —
#: e "faça um quiz" tem verbo de ação. O modelo obedecia, saía listando a pasta do
#: projeto que ninguém pediu para ver e oferecia mais uma rodada no fim, tudo **depois**
#: de já ter entregue (visto em 16/10/2026).
ENTREGOU_VISUAL = re.compile(r"```koda-", re.IGNORECASE)


# ------------------------------------------------- tetos de persistência (não de trabalho)
#
# A regra é esta: **não existe teto de passos nem de chamadas**. Teto fixo trunca tarefa
# grande no meio, em silêncio. O que existe é o limite de quantas vezes o loop **insiste** depois
# de o modelo parar de agir.
#
# Todos os contadores abaixo são **renovados a cada trabalho novo** (`ferramentas_ok`
# avançando). Uma tarefa longa e legítima — que pode durar horas — nunca esbarra neles:
# quem esbarra é o modelo que para de executar e só repete intenção. E o que acontece ao
# esbarrar não é cortar trabalho: é **fechar a rodada com o estado guardado**, para a pessoa
# retomar de onde parou (ver `Resultado.retomavel`).
#
# Nenhum deles é opcional: medido no projeto de origem, um comando vivo com o modelo
# respondendo só texto levava o processo a 511 MB em 6 s (laço infinito).

#: Quantas vezes o anúncio insistente é retomado por mensagem **interna** antes de o loop
#: aceitar que o modelo não vai agir.
#:
#: Eram **10**, e o dono viu o que isso faz numa tela: o modelo degenera, anuncia o mesmo
#: passo com outras palavras e a conversa vira **dez linhas iguais** antes de o loop desistir.
#: Medido com a `nable-4-mini-preview` num contexto longo: ela devolve `finish_reason: stop`
#: sem texto e sem chamada (o host responde 200 e vazio em ~1 s) — não é o app que perde a
#: chamada, é o modelo que não a faz. Quem precisa de cutucão legítimo age no primeiro ou no
#: segundo; do terceiro em diante já é degeneração, e o certo é **fechar a rodada** com o
#: cartão de tarefa não concluída (que tem o botão Retomar) em vez de insistir na frente de
#: quem está olhando.
MAX_RETOMADAS_ANUNCIO = 3

#: Quantas vezes o loop cobra execução antes de aceitar que o modelo só quis falar.
MAX_COBRANCAS = 2

#: Quantas vezes o loop **retoma** uma tarefa que parou com itens do plano em aberto.
MAX_RETOMADAS = 10

#: Quantos passos seguidos de ferramenta, **sem uma palavra**, antes de o loop cobrar
#: narração. É **um**: os modelos Liz e Layze ficam calados do começo ao fim quando
#: ninguém cutuca, e o dono reclamou exatamente disso.
MAX_SILENCIO = 1

#: Quantas vezes o loop **força** uma fala (passo sem ferramenta nenhuma) numa tarefa.
MAX_NARRACOES = 6

NARRAR = (
    "Você rodou ferramentas sem escrever nada para a pessoa. Informe o que descobriu. "
    "Se o pedido já foi atendido, entregue o resultado final e encerre sem chamar outra "
    "ferramenta. Se ainda há trabalho pendente, escreva uma linha curta do próximo passo "
    "e chame a ferramenta desse próximo passo na mesma resposta. Exemplo para trabalho "
    'pendente: "Vi que o projeto tem js/ e css/; vou ler o js/main.js para achar o ponto '
    'de entrada." Não repita ferramentas cujo resultado já é suficiente para responder ao '
    "pedido."
)

#: Cobrança quando o modelo termina sem ter conseguido rodar uma única ferramenta.
#: "As ferramentas deram erro em todas" não pode virar uma resposta de texto.
CONSERTAR_FERRAMENTA = (
    "Nenhuma ferramenta sua funcionou até agora, e a tarefa não avançou. Leia a mensagem de "
    "ERRO que voltou, corrija o argumento que a causou e chame a ferramenta de novo — "
    "caminho relativo à pasta de trabalho, trecho único no edit_file, comando existente no "
    "shell. Se o caminho certo for outro, use outra ferramenta. Não escreva um plano: "
    "execute."
)

RETOMAR_ANUNCIO = (
    "Você anunciou o próximo passo e encerrou a resposta sem chamar ferramenta nenhuma. "
    "O anúncio não faz o trabalho. Releia o pedido original e o estado atual, escolha por "
    "conta própria a ferramenta mais adequada entre as disponíveis e chame-a com argumentos "
    "completos. Não repita a promessa nem peça ao loop para escolher por você. Se não resta "
    "nada a fazer, informe o que foi concluído; se uma ferramenta falhou, use o erro para "
    "corrigir a chamada ou escolha outra abordagem."
)

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

    #: A tarefa **andou** antes do corte: ferramentas rodaram e o disco mudou. É o que
    #: distingue "cortei o contexto e a tarefa segue completa pelo que já foi feito" de
    #: uma falha de verdade — quem consome o `Resultado` decide pela marca em vez de
    #: re-ler a frase do fechamento.
    concluido: bool = False

    def __init__(self, mensagem: str, *, concluido: bool = False) -> None:
        super().__init__(mensagem)
        self.concluido = concluido

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

CONTINUAR_TRUNCADA = (
    "A resposta anterior atingiu o limite de saída do provedor e foi interrompida. "
    "Continue exatamente do ponto em que parou; não repita ações que já foram executadas. "
    "Se algum pedido de ferramenta veio incompleto, envie novamente essa chamada com os "
    "argumentos completos. Não encerre a tarefa até concluir o pedido original."
)

#: O **alô** ao modelo quando o raciocínio dele entra em laço — a mesma coisa repetida por
#: dezenas de milhares de caracteres. Em vez de encerrar a rodada, devolve-se a vez a ele com
#: um cutucão: o trabalho estava em andamento, e o que ele já pensou pode bastar para
#: responder. Matar o pensamento à força tirava dele essa chance.
#:
#: Medido: a `nable-4` repetiu **97 mil caracteres** da mesma coisa e não parou sozinha. O
#: teto de tokens de saída (131 072) está longe demais para servir de freio — por isso o corte
#: vem do vigia de repetição (`agent/repeticao.py`), e não do teto.
ALO_DE_RACIOCINIO = (
    "Você está repetindo o mesmo raciocínio em laço e o pensamento foi interrompido. Pare de "
    "pensar e aja agora: se já tem o que precisa, escreva a resposta em texto; se precisa de "
    "uma ferramenta, chame-a com os argumentos completos."
)

#: Quantos alôs antes de aceitar que o modelo não sai do laço sozinho. Baixo de propósito: um
#: modelo que precisa do cutucão age no primeiro; do terceiro em diante já é degeneração, e
#: insistir só gasta cota na frente de quem está olhando.
MAX_ALOS_DE_RACIOCINIO = 3

#: O que fica na tela quando o laço de raciocínio não cede aos alôs e a rodada é encerrada.
AVISO_DE_RACIOCINIO_EM_LOOP = (
    "_(o raciocínio do modelo entrou em repetição e a rodada foi interrompida — retome para "
    "ele continuar)_"
)

#: A retomada pedida pelo **botão** da interface, e não por uma mensagem digitada.
#:
#: É uma mensagem **interna**: entra no histórico que o modelo lê, e **não** na conversa
#: gravada. Era esse o defeito da versão antiga — o Retomar mandava `text: "continue"` e
#: criava uma bolha de pessoa na tela, como se o dono tivesse digitado a palavra mágica.
#:
#: Por ser interna, ela também sai da régua do pedido (`pedido_do_usuario`): quem retoma a
#: tarefa quer a **mesma** tarefa de antes, com as mesmas ferramentas — reler "continue"
#: como pedido novo classificaria a rodada como resposta e tiraria o catálogo.
RETOMAR_TAREFA = (
    "A pessoa clicou em Retomar: a rodada anterior não terminou. Continue exclusivamente "
    "o pedido original reproduzido nesta mensagem, respeitando todas as restrições dele. "
    "Use o histórico e o registro das ferramentas já executadas para seguir do próximo "
    "passo; não explore arquivos ou tarefas sem relação com esse pedido."
)

#: O botão **Fazer** do cartão de plano. Diferente do Retomar: aqui não se planeja de
#: novo — o plano já foi lido e aprovado, e a rodada seguinte é a execução dele. Sem esta
#: distinção o modelo relia o pedido original ("monte um plano") e apresentava o plano
#: outra vez, agora sem botão, em vez de fazer o trabalho.
EXECUTAR_PLANO_APROVADO = (
    "A pessoa aprovou o plano que você apresentou, clicando em Fazer. Execute agora esse "
    "plano, do começo ao fim, com as ferramentas disponíveis: não reapresente o plano, "
    "não chame `mostrar_plano` de novo, não peça outra confirmação e não repita etapas "
    "já concluídas. Ao terminar, entregue o resultado do pedido original reproduzido "
    "nesta mensagem."
)

#: As ferramentas que **mexem no disco**. É delas que sai a lista de "o que foi alterado"
#: que o portão de conferência lê — e o que a interface usa para saber se pode afirmar que
#: o trabalho já feito foi mantido.
FERRAMENTAS_QUE_MEXEM = frozenset(
    {
        "write_file",
        "edit_file",
        "str_replace_editor",
        "apply_patch",
        "delete_file",
        "create_directory",
        "move_file",
        "copy_file",
        "rename_file",
        "delete_directory",
    }
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
    r"(^|\b)(vou|irei|vamos|pretendo|deixe-me|deixa eu|preciso|precisamos|quero|queremos|"
    r"tenho que|terei que|need to|i need to)\s+(?:agora\s+)?"
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
#:
#: `quero`/`queremos` **saíram** daqui e foram para o `ANUNCIO` (que exige um verbo de
#: trabalho logo depois): sozinhos, apareciam em fechamento legítimo — "Terminei. Quero
#: destacar que o build passou." — e o loop forçava uma chamada por causa de uma palavra.
#: `falta`/`preciso` ficam: "Falta apagar o bench" é trabalho pendente de verdade, e a
#: negação ("Não falta nada.") é tratada pelo `_NEGACAO`.
FUTURO = re.compile(
    r"\b(vou|irei|vamos|pretendo|deixe-me|deixa eu|preciso|precisamos|"
    r"tenho que|terei que|falta|faltam|ainda falta|próximo passo|próxima etapa|"
    r"em seguida|a seguir|seguir com|continuo daqui|sigo daqui|"
    r"i will|i'll|let me|next i|i'?m going to|need to|still need)\b",
    re.IGNORECASE,
)

#: Negação **imediatamente antes** de uma marca de futuro: "não vou fazer mais nada",
#: "não falta nada", "não preciso rodar de novo". O que vem depois disso é fechamento, não
#: anúncio — e tratá-lo como anúncio era metade dos falsos positivos.
_NEGACAO = re.compile(
    r"(?:\bnão|\bnao|\bnunca|\bnenhum\w*|\bnada|\bsem|\bjamais)\s+(?:\w+\s+){0,2}$",
    re.IGNORECASE,
)

#: **Pedido à pessoa** logo depois de uma marca de futuro: "Preciso que você cole o erro",
#: "Falta você colar o código", "Quero que me mande o stacktrace". O agente está pedindo
#: algo a quem está do outro lado — é fechamento, não anúncio de trabalho próprio.
#:
#: Sem esta regra, "Preciso que você cole o código/erro aqui pra eu trabalhar em cima" foi
#: lido como "vou fazer" e uma rodada que **já tinha respondido tudo** fechou com o cartão
#: "tarefa não concluída" e o botão Retomar (visto em 03/10/2026). A `_NEGACAO` não pega
#: este caso: pedir algo não é negar nada.
PEDIDO_A_PESSOA_DEPOIS = re.compile(
    r"^\s*(?:que\s+)?(?:voc[êe]s?|vc|tu|contigo|com\s+voc[êe]s?"
    r"|me\s+(?:col[ae]|manda|mande|passe|passa|d[êe]|diz|envie|envia|diga|conte|conta|"
    r"informe|informa|mostre|mostra))\b",
    re.IGNORECASE,
)

#: Verbos na forma de **pedido** (imperativo/subjuntivo), não no infinitivo. É o que separa
#: "que você **cole** o erro" (pedido) de "os testes que você **pediu**" (oração relativa,
#: dentro de um anúncio de verdade).
_VERBOS_DE_PEDIDO = (
    r"col[ae]|manda|mande|envia|envie|diga|diz|passe|passa|mostre|mostra|conte|conta|"
    r"informe|informa|escreve|escreva|posta|poste"
)

#: **Pedido à pessoa antes da marca de futuro** — o imperativo dirigido a quem lê:
#: "**Me manda** o código ou a dúvida direto **que eu vou** nisso." (visto em 03/10/2026,
#: o segundo fechamento que o cartão pegou). Aqui a marca de futuro é **consequência** do
#: que a pessoa mandar, e não trabalho que o agente deixou de fazer.
#:
#: O verbo é exigido na forma de pedido de propósito: casar só o "que você" transformaria
#: "Vou rodar os testes **que você pediu**" — anúncio legítimo — em fechamento.
PEDIDO_A_PESSOA_ANTES = re.compile(
    rf"\bme\s+(?:{_VERBOS_DE_PEDIDO})\b|\b(?:voc[êe]s?|vc|tu)\s+(?:{_VERBOS_DE_PEDIDO})\b",
    re.IGNORECASE,
)

#: Onde uma sentença termina — para o pedido de antes valer só **dentro da mesma sentença**.
_LIMITE_DE_SENTENCA = re.compile(r"(?<=[.!?])\s+|\n+")


def _sentenca_antes(texto: str, pos: int) -> str:
    """O pedaço da **mesma sentença** que vem antes de `pos`."""
    partes = _LIMITE_DE_SENTENCA.split(texto[:pos])
    return partes[-1] if partes else ""


def _sentenca_em(texto: str, pos: int) -> str:
    """A sentença inteira que contém `pos`."""
    inicio = 0
    for limite in _LIMITE_DE_SENTENCA.finditer(texto):
        if limite.end() > pos:
            return texto[inicio : limite.start()]
        inicio = limite.end()
    return texto[inicio:]


#: Fechamento de **espera**: o agente diz que aguarda a pessoa ("Fico no aguardo", "Vou
#: aguardar o seu retorno"). Mesma família do pedido à pessoa — a vez é de quem lê, não há
#: trabalho a executar. Só `aguard*`: `esperar` é ambíguo ("vou esperar o build terminar" é
#: trabalho de verdade).
ESPERA_PELA_PESSOA = re.compile(r"\baguard\w+", re.IGNORECASE)


def _marcas_descartadas(texto: str, padrao: re.Pattern[str]) -> bool:
    """**Todas** as marcas deste padrão são descartáveis?

    Descartável é a marca que não é anúncio de trabalho do agente: **negada** ("não vou
    fazer mais nada"), **pedido à pessoa** ("me manda o código", "que você cole o erro") ou
    **espera pela pessoa** ("vou aguardar seu retorno"). Nos três casos a vez é de quem lê.
    """
    achados = list(padrao.finditer(texto))
    if not achados:
        return False
    return all(
        _NEGACAO.search(texto[: achado.start()])
        or bool(PEDIDO_A_PESSOA_DEPOIS.match(texto[achado.end() :]))
        or bool(PEDIDO_A_PESSOA_ANTES.search(_sentenca_antes(texto, achado.start())))
        or bool(ESPERA_PELA_PESSOA.search(_sentenca_em(texto, achado.start())))
        for achado in achados
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

    Três testes, todos no fim do texto: marca de futuro (`vou…`, `próximo passo…`), frase
    final começando em infinitivo, e o vocabulário de anúncio da primeira versão.

    O que **não** conta como anúncio: marca de futuro **negada** ("não vou fazer mais
    nada"), **pedido à pessoa** ("Preciso que você cole o erro") e o fechamento confirmado.
    A lista de verbos de futuro foi enxugada — `quero`, `preciso` e `falta` aparecem em
    resposta pronta ("Feito! Não falta nada.") e forçavam uma chamada de ferramenta à toa.
    """
    fim = FECHAMENTO_CONFIRMADO.sub("", _fim_do_texto(texto))
    if not fim.strip():
        return False
    if _marcas_descartadas(fim, ANUNCIO) and _marcas_descartadas(fim, FUTURO):
        return False
    if ANUNCIO.search(fim) and not _marcas_descartadas(fim, ANUNCIO):
        return True
    if FUTURO.search(fim) and not _marcas_descartadas(fim, FUTURO):
        return True
    return bool(INFINITIVO_NO_FIM.search(fim))


#: Anúncio → ferramenta, na ordem em que se procura. Aqui ficam leituras/buscas e comando.
# ---------------------------------------------------------------- portões de parada

#: Ferramentas que **só leem**. Um sucesso numa ferramenta que pode mudar o estado do mundo
#: reinicia a janela de detecção de repetição das outras chamadas.
SO_LEITURA = (
    "read_file",
    "read_attachment",
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
    """Identidade canônica da chamada: nome + argumentos, com chaves em ordem."""
    nome = registry.canonico(nome)
    try:
        corpo = json.dumps(argumentos, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        corpo = str(argumentos)
    return f"{nome}:{corpo}"


def _chave_de_repeticao(
    nome: str,
    argumentos: dict[str, Any],
    pedido: str,
    todos: list[dict[str, Any]],
) -> str:
    """Assinatura estável da chamada dentro do pedido e do plano atuais.

    Não inclui todo o histórico de tool results: ele cresce a cada volta e esconderia
    justamente a repetição que queremos detectar. O pedido original e o estado do plano
    mudam quando o contexto de trabalho muda de forma relevante.
    """
    contexto_tarefa = json.dumps(
        {
            "pedido": pedido,
            "plano": [
                {"texto": str(item.get("texto", "")), "feito": bool(item.get("feito"))}
                for item in todos
            ],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    identidade = _chave_da_chamada(nome, argumentos) + "\0" + contexto_tarefa
    return hashlib.sha256(identidade.encode("utf-8")).hexdigest()


#: Pergunta de verdade: "o que faz esse arquivo?" não precisa de ferramenta nenhuma.
PERGUNTA = re.compile(
    r"^\s*(o que|que|como|por que|porque|pq|qual|quais|quando|onde|quem|quanto|quanta)\b",
    re.IGNORECASE,
)

#: Pergunta **conceitual** — definição, diferença, funcionamento — mesmo quando cita uma
#: palavra do projeto ("o que é uma função?", "qual a diferença entre lista e tupla?",
#: "como funciona o git?"). É conversa: o modelo responde com o que sabe, sem catálogo.
#: Vem antes dos marcadores de projeto porque "função", "classe", "teste" e "git" estão
#: lá, e sem isto uma pergunta de estudo ganhava ferramenta sem precisar. Um verbo de ação
#: em qualquer lugar ("...? arruma isso") continua vencendo, como manda a regra do dono.
PERGUNTA_CONCEITUAL = re.compile(
    r"^\s*(?:"
    r"o\s+que\s+(?:[ée]|s[ãa]o|significa)\b|"
    r"qual\s+(?:[ée]\s+)?(?:a\s+)?diferen[çc]a\b|"
    r"me\s+(?:explica|explique|ensina|ensine)\s+(?:o\s+que\s+)?(?:[ée]|s[ãa]o|significa)\b|"
    r"me\s+(?:explica|explique)\s+(?:a\s+)?diferen[çc]a\b|"
    r"(?:explica|explique|define|defina)\s+(?:o\s+que\s+)?(?:[ée]|s[ãa]o|significa)\b|"
    r"(?:explica|explique)\s+(?:a\s+)?diferen[çc]a\b|"
    r"como\s+funciona\b"
    r")",
    re.IGNORECASE,
)

#: A pergunta sobre **função** usa o verbo "faz" sem pedir ação: "o que faz esse arquivo?"
#: é conversa, e tratar o "faz" como tarefa fazia o loop cobrar ferramenta de quem só
#: queria uma explicação. A remoção vale só para a pergunta: o que vier depois dela
#: ("...? arruma ele") continua sendo pedido de trabalho.
PERGUNTA_SOBRE_FUNCAO = re.compile(
    r"\bo\s+que\b[^?.\n]{0,80}\bfaz\b",
    re.IGNORECASE,
)

# Uma pergunta sobre capacidade descreve ação hipotética, sem pedir execução.
PERGUNTA_DE_CAPACIDADE = re.compile(
    r"\b(?:o\s*que|oque)\s+(?:(?:voc[êe]|vc|tu)\s+)?(?:pode|consegue|sabe)\s+fazer\b",
    re.IGNORECASE,
)

#: Verbos de tarefa que pedem mudança de verdade na máquina. É o que separa "arruma esse
#: bug" (usa ferramenta) de "o que é esse arquivo?" (resposta em texto é a resposta certa).
TAREFA_DE_ACAO = re.compile(
    r"\b(cria|crie|criar|adiciona|adicione|adicionar|implementa|implemente|implementar|"
    r"refatora|refatore|refatorar|corrige|corrija|corrigir|arruma|arrume|arrumar|"
    r"conserta|conserte|consertar|resolve|resolva|resolver|"
    r"edita|edite|editar|altera|altere|alterar|muda|mude|mudar|"
    # "mexe" é o verbo que o dono usa para pedir trabalho ("mexe em algo"), e não estava
    # em nenhuma régua: o pedido caía como conversa e a rodada ia sem catálogo.
    r"mexe|mexa|mexer|meche|mecha|mecher|põe|poe|ponha|pôr|coloca|coloque|colocar|"
    r"tira|tire|tirar|remove|remova|remover|deixa|deixe|deixar|ajusta|ajuste|ajustar|"
    r"configura|configure|configurar|ativa|ative|ativar|desativa|desative|desativar|"
    r"limpa|limpe|limpar|"
    r"move|mova|mover|renomeia|renomeie|renomear|copia|copie|copiar|apaga|apague|apagar|"
    r"escreve|escreva|escrever|grava|grave|gravar|instala|instale|instalar|desinstala|"
    # "lista" faltava, e era o buraco do pedido mais comum de todos: "lista o que tem na
    # pasta onde você está" não tinha verbo de ação reconhecido, a rodada virava **resposta**
    # (sem catálogo) e o modelo respondia que não existe fisicamente — não porque escolheu
    # não usar ferramenta, mas porque não tinha nenhuma. Medido: 2 de 3 frases do relatório
    # do dono caíam aqui.
    # "lista" e "teste" também são substantivos ("lista e tupla", "teste unitário"). Como
    # verbo, vêm seguidos de um complemento; sem esta condição, uma pergunta conceitual
    # ganhava catálogo só pela palavra — e o inverso ("lista o que tem na pasta") continua
    # casando porque o complemento está lá.
    r"lista\s+(?=(?:o|a|os|as|me|tudo|todos|todas|quais|onde|o\s+que|se|isso|aquilo|que|"
    r"a[íi]|pra|para|arquivos?|pastas?|diret[óo]rios?|comandos?|processos?|servi[çc]os?|"
    r"modelos?|contas?|provedores?|ferramentas?|skills?|agentes?|commits?|branches?)\b)"
    r"|liste|listar|"
    r"roda|rode|rodar|executa|execute|executar|testa|"
    r"teste\s+(?=(?:o|a|os|as|me|tudo|isso|se|que|no|na|com|essa|esse|ele|ela|aquilo|"
    r"a[íi]|pra|para)\b)|testar|builda|compila|compile|"
    r"compilar|monta|monte|montar|converte|converta|converter|faz|fa\u00e7a|fazer|reorganiza|"
    r"termina|termine|terminar|continua|continue|continuar|"
    # Abrir, subir, ligar, iniciar e fechar: era o buraco do pedido real do dono —
    # "abre o host dele pra mim pfvr" não era considerado tarefa de ação, e sem isso o
    # anúncio "vou subir o servidor" não tinha nada que o obrigasse a virar ferramenta.
    r"abre|abra|abrir|fecha|feche|fechar|sobe|suba|subir|levanta|levante|levantar|"
    r"liga|ligue|ligar|inicia|inicie|iniciar|reinicia|reinicie|reiniciar|"
    r"para|pare|parar|mostra|mostre|mostrar|confere|confira|conferir|"
    r"verifica|verifique|verificar|atualiza|atualize|atualizar|manda|mande|mandar|"
    r"envia|envie|enviar|baixa|baixe|baixar|abre|open|start|launch|close)\b",
    re.IGNORECASE,
)

# Uma correção do usuário não autoriza a ação mencionada nela. Remover só a
# negação preserva uma nova instrução explícita na mesma mensagem.
NEGACAO_DE_PEDIDO = re.compile(
    r"\bn[ãa]o\s+pedi\s+(?:(?:para|pra)\s+)?(?:(?:voc[êe]|vc)\s+)?"
    r"(?:fazer|faz(?:er)?|executar|executa[r]?|mexer|mexe[r]?)\s+"
    r"(?:nada|isso|aquilo)\b",
    re.IGNORECASE,
)


def pedido_do_usuario(mensagens: list[dict[str, Any]]) -> str:
    """O último pedido da pessoa no histórico — **só o que ela escreveu**.

    Duas coisas saem daqui, e as duas já custaram caro:

    - O texto vem de `contexto.texto_do_conteudo`, e não de `str(content)`: num turno com
      imagem o `content` é uma lista de partes, e `str()` traria o data URL inteiro dentro —
      o pedido pareceria gigante só por causa do base64.
    - O bloco de anexos sai por `contexto.sem_anotacoes`: ele é anotação **nossa**. A lista
      de arquivos em itens (`- image.png (…)`) casava com a régua de plano, e "fala o que tá
      escrito nessa foto" virava uma tarefa grande que o agente mandava a pessoa dividir em
      itens antes de executar.

    Também não é pedido o resumo de compactação: ele é contexto de fundo, não uma fala de
    ninguém — e é longo o bastante para disparar a régua de plano sozinho.
    """
    for mensagem in reversed(mensagens):
        if mensagem.get("role") != "user":
            continue
        texto = contexto.sem_anotacoes(
            contexto.texto_do_conteudo(mensagem.get("content"))
        )
        # As mensagens internas do loop (cobrança de narração, continuação, retomada pelo
        # botão) não são pedido: a régua da categoria tem de olhar a **tarefa de verdade**.
        if texto.startswith("[contexto compactado]"):
            continue
        if texto and texto not in (
            NARRAR,
            CONTINUAR,
            CONSERTAR_FERRAMENTA,
            RETOMAR_TAREFA,
        ):
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
    r"^\s*(responda|responde|me\s+responda|diga|diz|fale|me\s+diga|"
    r"me\s+fale|me\s+explica|me\s+explique|explica|explique|ensina|ensine|"
    r"resume|resuma|me\s+conta|conta|"
    # "escreva 6 frases curtas sobre patos": pedido de palavras com verbo de escrita.
    # Só quando o complemento é texto (frases/linhas/parágrafos/poema) — "escreva um
    # arquivo" continua sendo trabalho.
    r"escreva?\s+(?:\d+\s+)?(?:frases?|linhas?|par[áa]grafos?|um\s+poema|um\s+texto|um\s+resumo)|"
    r"apenas|só|so|somente|oi|olá|ola|opa|salve|e\s+a[íi]|tudo\s+bem|tudo\s+bom|"
    r"bom\s+dia|boa\s+tarde|boa\s+noite|obrigado|valeu|vlw|beleza|blz|ok)\b",
    re.IGNORECASE,
)

#: "teste de funcionamento responda com um ok": o "teste" aqui pede palavras, não execução.
#:
#: Só vale quando o próprio pedido diz que quer resposta. "teste o app" é tarefa e não
#: pode cair nesta régua — era o que acontecia quando "teste" estava na lista genérica de
#: respostas: o verbo de ação era engolido e a rodada ia sem catálogo.
TESTE_DE_RESPOSTA = re.compile(
    r"^\s*(teste|testar|testando)\b[^\n]*\b(responda|responde|diga|diz|fale|informe|ok)\b",
    re.IGNORECASE,
)

#: Tamanho a partir do qual o pedido é longo demais para ser só um cumprimento/resposta.
CARACTERES_DE_RESPOSTA = 120


#: Verbos que pedem **palavras**, não trabalho: "responda apenas: x", "me diga se…".
#:
#: É o que separa "responda apenas: restrições registradas" de "arrume o bug". Sem esta
#: régua o loop olhava só o vocabulário de ação e via "teste" no começo da frase — foi
#: assim que um pedido de resposta virou duas cobranças de ferramenta e uma varredura da
#: pasta de trabalho (achado do QA, 01/10/2026).
SOMENTE_RESPOSTA = re.compile(
    r"\b(responda|responde|me\s+responda|diga|me\s+diga|diz|fale|me\s+fale|informe|"
    r"confirme)\s+(apenas|somente|s[óo]|só\s+que)\b"
    r"|\b(apenas|somente|s[óo])\s+(responda|responde|diga|fale|informe|confirme)\b",
    re.IGNORECASE,
)

#: "Ferramentas de web", "ferramentas de arquivo": a proibição é **daquele grupo**, não de
#: todas. Sem esta exclusão, "não use ferramentas de web" desligava o catálogo inteiro — a
#: rodada ficava sem terminal, sem arquivo e sem nada, e o modelo respondia que não podia
#: usar ferramenta. Era um dos caminhos do defeito que o dono relatou em 02/11/2026.
_FERRAMENTA_ESPECIFICA = r"(?!\s*(?:de|do|da|dos|das|para|pra|nem|exceto|al[ée]m|como)\b)"

#: "Não use ferramenta nenhuma", "sem usar ferramenta", "responda apenas" — a rodada roda
#: **sem catálogo**: a ferramenta não é oferecida, e o modelo não tem como chamá-la.
#:
#: É a forma mais honesta de honrar uma instrução negativa. Antes, "não usar web nem
#: arquivos" era só uma frase no meio do pedido: o modelo recebia o catálogo inteiro,
#: escolhia `list_dir` e a resposta exibia os nomes das pastas e dos arquivos da pessoa.
#:
#: A proibição **absoluta** é só quando não vem um complemento: "não use ferramentas de
#: web" é uma restrição de web, e quem a escreve continua podendo usar o terminal.
SEM_FERRAMENTA_NENHUMA = re.compile(
    r"\b(n[ãa]o|sem)\s+(us\w*|utiliz\w*|cham\w*|acion\w*)\s+"
    r"(?:(?:nenhuma|nenhum)\s+)?(?:ferramenta|ferramentas|instrumento)\b"
    + _FERRAMENTA_ESPECIFICA
    + r"|\bsem\s+usar\s+(?:(?:nenhuma)\s+)?(?:ferramenta|ferramentas)\b"
    + _FERRAMENTA_ESPECIFICA
    + r"|\bsem\s+(?:ferramenta|ferramentas|nenhum\s+instrumento)\b"
    + _FERRAMENTA_ESPECIFICA,
    re.IGNORECASE,
)

#: Como a pessoa **nega**, em uma régua só, usada pelas quatro proibições abaixo.
#:
#: "não use", "sem usar", "não me mostre", "não nos informe" e "não quero que você leia" são
#: a mesma instrução dita de jeitos diferentes. Antes cada régua repetia a sua própria
#: abertura e as variantes escapavam: "não quero que você leia meus arquivos" não casava com
#: nada e a rodada seguia com o catálogo inteiro.
ABERTURA_DE_NEGACAO = (
    r"(?:\b(n[ãa]o|sem)\s+"
    r"(?:quero\s+que\s+(?:voc[êe]|vc)\s+|queria\s+que\s+(?:voc[êe]|vc)\s+)?"
    r"(?:me\s+|nos\s+|te\s+)?)"
)

#: "Não use arquivos", "não liste pastas", "não acesse o disco", "não acesse recursos
#: locais": **tudo o que alcança a máquina** sai da rodada (`FERRAMENTAS_LOCAIS`), e não só
#: as ferramentas de arquivo — o mesmo conteúdo fica a um `shell` ou a um
#: `code_interpreter` de distância.
#:
#: A pessoa continua podendo pedir que você escreva código na resposta.
SEM_ARQUIVOS = re.compile(
    ABERTURA_DE_NEGACAO
    + r"(us\w*|utiliz\w*|cham\w*|acion\w*|acess\w*|abr\w*|baix\w*|le\w*|"
    r"list\w*|olh\w*|mex\w*|varr\w*|consult\w*)\s+"
    # "não use **ferramentas de** arquivo": o grupo é o que fica proibido, não o catálogo.
    r"(?:(?:ferramentas?|recursos?)\s+de\s+)?(?:(?:n[oa]s?|o|a|os|as|meus?|seus?)\s+)?"
    r"(arquivos?|pastas?|diret[óo]rios?|disco|workspace|projeto|desktop|[áa]rea\s+de\s+trabalho|"
    # "não acesse **recursos locais**", "não acesse a máquina", "não mexa no meu computador":
    # a proibição de acesso local dita com estas palavras também conta. Sem elas, o pedido
    # do dono ("não acesse recursos locais") passava batido pela régua inteira.
    r"recursos?\s+locais?|nada\s+local|m[áa]quina|computador|sistema)\b"
    r"|\b(sem|n[ãa]o\s+consultar)\s+(?:(?:ferramentas?|recursos?)\s+(?:de\s+)?)?"
    r"(arquivos?|pastas?|diret[óo]rios?|o\s+disco)\b"
    # "não use web **nem arquivos**": a segunda metade da lista negada também conta.
    r"|\bnem\s+(arquivos?|pastas?|diret[óo]rios?|o\s+disco)\b"
    r"|\bnem\s+(recursos?\s+locais?|nada\s+local)\b",
    re.IGNORECASE,
)

#: "Não use o shell", "não rode comando", "sem terminal": o grupo que executa comando sai.
#:
#: Régua própria, e não a de arquivo: quem proíbe o shell continua podendo pedir a leitura
#: de um arquivo pelo caminho próprio. `code_interpreter` e os gerenciadores de pacote vão
#: junto — os três rodam código na máquina, e deixar um de fora é deixar a porta aberta.
SEM_SHELL = re.compile(
    ABERTURA_DE_NEGACAO
    + r"(us\w*|utiliz\w*|cham\w*|acion\w*|abr\w*|rod\w*|execut\w*)\s+"
    # "não use **ferramentas de** shell": sai só o grupo de shell.
    r"(?:(?:ferramentas?|recursos?)\s+de\s+)?(?:(?:n[oa]s?|o|a|os|as)\s+)?"
    r"(shell|terminal|console|linha\s+de\s+comando|"
    r"comandos?|bash|cmd|powershell)\b"
    r"|\bsem\s+(?:(?:ferramentas?|recursos?)\s+(?:de\s+)?)?(shell|terminal|comandos?)\b"
    r"|\bnem\s+(o\s+)?(shell|terminal)\b",
    re.IGNORECASE,
)

#: "Não leia minhas variáveis de ambiente", "não veja meus processos", "não me diga o SO",
#: "não inspecione o hardware", "não acesse informações do servidor".
#:
#: É a lista do QA, item por item. Cada uma dessas perguntas se responde com o **estado da
#: máquina**, e o Koda respondia de fato: o relatório pegou SO, caminhos, shell, Python e Git
#: devolvidos numa rodada em que o usuário tinha proibido o acesso local. Sem esta régua,
#: "não leia minhas variáveis de ambiente" não casava com nenhuma proibição — o pedido
#: chegava ao modelo como pergunta comum, com o catálogo inteiro na mão.
SEM_AMBIENTE = re.compile(
    ABERTURA_DE_NEGACAO
    + r"(us\w*|utiliz\w*|cham\w*|acion\w*|acess\w*|abr\w*|le\w*|list\w*|"
    r"olh\w*|varr\w*|consult\w*|inspecion\w*|investig\w*|examin\w*|detect\w*|descubr\w*|"
    r"enxerg\w*|ver|veja|mostr\w*|inform\w*|diga|diz|fale)\s+"
    # "não use **ferramentas de** ambiente": o grupo é o que fica proibido.
    r"(?:(?:ferramentas?|recursos?)\s+de\s+)?"
    # "não leia **minhas** variáveis", "não veja **os** processos", "sem acesso **ao** sistema".
    r"(?:(?:n[oa]s?|aos?|à|às|o|a|os|as|meus?|minhas?|seus?|suas?|nossas?|sobre)\s+)?"
    # "não acesse **informações do** servidor".
    r"(?:informa[çc][õo]es\s+(?:do\s+|da\s+|de\s+)?)?"
    r"(vari[áa]veis?\s+de\s+ambiente|ambiente|env|processos?|sistema\s+operacional|so|"
    r"hardware|servidor|servidores|m[áa]quina|computador|sistema|"
    r"vers[ãa]o\s+do\s+(python|node|git)|configura[çc][õo]es\s+do\s+sistema)\b"
    r"|\bsem\s+(?:(?:ferramentas?|recursos?)\s+(?:de\s+)?)?"
    r"(ver|olhar|ler)\s+(o\s+)?(ambiente|sistema|processos?)\b"
    r"|\bsem\s+(?:(?:ferramentas?|recursos?)\s+(?:de\s+)?)?(ambiente|processos?)\b"
    r"|\bnem\s+(as\s+)?(vari[áa]veis?\s+de\s+ambiente|processos?|o\s+sistema)\b",
    re.IGNORECASE,
)

#: "Não use a web", "não pesquise", "sem internet": as ferramentas de web saem da rodada.
SEM_WEB = re.compile(
    r"\b(n[ãa]o|sem)\s+(us\w*|utiliz\w*|pesquis\w*|naveg\w*|acess\w*|abr\w*|baix\w*)\s+"
    # "não use **ferramentas de** web": sai só o grupo de web, e o terminal continua.
    r"(?:(?:ferramentas?|recursos?)\s+de\s+)?(?:(?:n[oa]s?|o|a|os|as)\s+)?"
    r"(web|internet|rede|online|p[áa]ginas?|sites?|navegador|google)\b"
    r"|\bsem\s+(?:(?:ferramentas?|recursos?)\s+(?:de\s+)?)?"
    r"(web|internet|pesquisa|conex[ãa]o)\b"
    r"|\bnem\s+(a\s+)?(web|internet|rede|online)\b",
    re.IGNORECASE,
)

#: A resposta é uma **recusa**: o modelo disse que não pode fazer ou revelar aquilo.
#:
#: Recusa é resposta final, não tarefa pendente. O QA viu o caso: o Koda respondia certo
#: ("Não posso revelar instruções internas") e o loop, achando que faltava trabalho,
#: cobrava uma ferramenta — e o modelo saía listando a pasta de trabalho da pessoa. Um
#: pedido de segurança não pode terminar em leitura de disco.
RECUSA = re.compile(
    r"\b(n[ãa]o\s+posso\s+(revelar|divulgar|compartilhar|fornecer|mostrar|informar|"
    r"dizer|atender|ajudar|fazer|executar|acessar|realizar|ignorar)\b"
    r"|n[ãa]o\s+vou\s+(revelar|divulgar|compartilhar|fornecer|mostrar|informar|atender)\b"
    r"|n[ãa]o\s+tenho\s+(como|permiss[ãa]o|autoriza[çc][ãa]o)\s+(revelar|divulgar|"
    r"compartilhar|fornecer|mostrar|informar|acessar|fazer)\b"
    r"|n[ãa]o\s+[ée]\s+poss[íi]vel\s+(revelar|divulgar|compartilhar|fornecer)\b"
    r"|n[ãa]o\s+consigo\s+(revelar|divulgar|compartilhar|fornecer)\b"
    r"|s[ãa]o\s+instru[çc][õo]es\s+(internas|confidenciais)\b"
    r"|isso\s+n[ãa]o\s+[ée]\s+(algo|uma\s+coisa)\s+que\s+eu\s+possa)",
    re.IGNORECASE,
)


def restricoes_do_pedido(mensagens: list[dict[str, Any]]) -> tuple[set[str], bool]:
    """O que a pessoa pediu para **não** usar nesta rodada.

    Devolve as ferramentas a tirar do catálogo e, quando o pedido é de resposta pura
    ("responda apenas…", "não use ferramenta nenhuma"), o sinal de rodar sem catálogo
    nenhum. Vale para o **último** pedido da pessoa: a restrição é daquela tarefa, e não
    uma regra que fica valendo para a conversa inteira.
    """
    pedido = pedido_do_usuario(mensagens)
    if caminhos_marcados.marcador_presente(pedido):
        return set(), False
    if not pedido:
        return set(), False
    if SEM_FERRAMENTA_NENHUMA.search(pedido) or (
        SOMENTE_RESPOSTA.search(pedido) and PERGUNTA_RESTRITA.search(pedido)
    ):
        return set(), True
    proibidas: set[str] = set()
    if SEM_ARQUIVOS.search(pedido):
        proibidas.update(registry.FERRAMENTAS_LOCAIS)
    if SEM_SHELL.search(pedido):
        proibidas.update(registry.FERRAMENTAS_DE_SHELL)
    if SEM_AMBIENTE.search(pedido):
        proibidas.update(registry.FERRAMENTAS_DO_AMBIENTE)
    if SEM_WEB.search(pedido):
        proibidas.update(registry.FERRAMENTAS_WEB)
    return proibidas, False


def _explicar_restricoes(
    historico: list[dict[str, Any]],
    proibidas: set[str],
    sem_ferramentas: bool,
    modo: str = MODO_CODIGO,
) -> None:
    """Avisa o modelo, no prompt de sistema, o que **não** está no catálogo desta rodada.

    Tirar a ferramenta sem dizer nada faz o modelo pedir o que não existe — ou, pior,
    responder como se tivesse usado. O aviso transforma a restrição da pessoa numa
    instrução explícita, do mesmo jeito que o "não use a Web" já faz no prompt de sistema.
    """
    if not historico or historico[0].get("role") != "system":
        return

    # A segunda causa do furo, e a mais insidiosa: o prompt de ferramentas continuava no
    # sistema mandando o agente **chamar ferramenta** ("Nunca responda de memória o que uma
    # ferramenta responde. Chame a ferramenta: read_file, shell…") numa rodada em que o
    # catálogo estava vazio. O modelo recebia as duas ordens contraditórias e resolvia a
    # favor da primeira: emitia a chamada assim mesmo — e o loop executava. Tirar o prompt
    # junto com o catálogo é o que faz "sem ferramenta" ser uma rodada sem ferramenta de
    # verdade, e não uma rodada com o manual na mão e as ferramentas escondidas.
    if sem_ferramentas:
        conteudo = str(historico[0].get("content", ""))
        if PROMPT_FERRAMENTAS in conteudo:
            historico[0] = {
                **historico[0],
                "content": conteudo.replace(PROMPT_FERRAMENTAS, "").strip(),
            }

    if sem_ferramentas:
        aviso = (
            "NESTA RODADA NÃO HÁ FERRAMENTA NENHUMA. A pessoa pediu uma resposta direta: "
            "responda com o que você já sabe, em português do Brasil, e não pergunte se "
            "deve usar ferramenta nem peça permissão para isso. Qualquer chamada de "
            "ferramenta é recusada pelo próprio serviço — não insista e não tente outro "
            "caminho. Se você não tem a informação, diga que **não tem acesso**; não "
            "estime, não suponha e não invente."
        )
    elif modo == MODO_RESPOSTA:
        aviso = (
            "ESTA RODADA É SÓ CONVERSA. Responda exatamente o que foi pedido, direto, em "
            "português do Brasil, com o que você já sabe — sem listar, ler, criar ou "
            "alterar nada. Não fale sobre ferramentas, permissões ou limitações: apenas "
            "responda."
        )
    elif proibidas:
        grupos: list[str] = []
        if proibidas >= registry.FERRAMENTAS_LOCAIS:
            grupos.append(
                "tudo o que alcança a máquina dela — arquivos (read_file, write_file, "
                "list_dir…), shell, code_interpreter, get_environment e git"
            )
        elif proibidas >= registry.FERRAMENTAS_DE_ARQUIVO:
            grupos.append(
                "as ferramentas de arquivo (read_file, write_file, edit_file, list_dir, "
                "search_files…)"
            )
        if proibidas >= registry.FERRAMENTAS_WEB:
            grupos.append("as ferramentas de web (web_search, url_reader, browser)")
        restantes = (
            proibidas
            - registry.FERRAMENTAS_LOCAIS
            - registry.FERRAMENTAS_DE_ARQUIVO
            - registry.FERRAMENTAS_WEB
        )
        if restantes:
            grupos.append(", ".join(sorted(restantes)))
        aviso = (
            "A pessoa pediu para **não** usar "
            + "; ".join(grupos)
            + " nesta rodada. Elas não estão disponíveis: não as chame, não ofereça e não "
            "peça permissão para usá-las — e não tente chegar no mesmo lugar por outra "
            "ferramenta (o shell não substitui a leitura de arquivo, o interpretador de "
            "código não substitui o shell). Responda com o que você já sabe e, quando não "
            "souber, diga que **não tem acesso** em vez de estimar."
        )
    else:
        return

    historico[0] = {
        **historico[0],
        "content": f"{historico[0].get('content', '')}\n\n{aviso}",
    }


#: O que a pessoa marca com `@` no pedido: `@sub.revisor`, `@mcp.navegador`, `@skill.revisao`.
#:
#: O ponto separa o tipo do nome, e o tipo aceita o apelido que a mão escreve (`agente` e
#: `sub` são a mesma coisa). O nome aceita letra, número, `-`, `_` e `.`.
MENCAO = re.compile(r"@(sub|agente|mcp|skill)\.([A-Za-z0-9._-]+)", re.IGNORECASE)


def mencoes_do_pedido(mensagens: list[dict[str, Any]]) -> list[dict[str, str]]:
    """O que a pessoa marcou com `@` no **último** pedido dela.

    Só o último: a marca é uma ordem para esta rodada, não uma configuração que fica valendo.
    Varrer o histórico inteiro faria um `@sub.revisor` de dez mensagens atrás continuar
    mandando no trabalho de agora.
    """
    texto = ""
    for mensagem in reversed(mensagens):
        if mensagem.get("role") == "user":
            texto = texto_do_conteudo(mensagem.get("content"))
            break

    vistos: dict[str, dict[str, str]] = {}
    for achado in MENCAO.finditer(texto):
        tipo = achado.group(1).lower()
        if tipo == "agente":
            tipo = "sub"
        nome = achado.group(2).strip()
        if not nome:
            continue
        vistos[f"{tipo}.{nome.lower()}"] = {
            "tipo": tipo,
            "nome": nome,
            "bruto": achado.group(0)[1:],
        }
    return list(vistos.values())


def _instrucoes_da_skill(skills: Any, nome: str) -> str:
    """As instruções da skill marcada com `@`, quando ela existe e está ligada.

    Devolve vazio quando não dá: a mensagem de sistema já diz que a skill foi pedida, e uma
    skill que sumiu no meio do caminho não pode derrubar a rodada inteira.
    """
    if skills is None:
        return ""
    try:
        return str(skills.instrucoes(nome))
    except Exception:  # noqa: BLE001 — skill ausente ou desligada não derruba a rodada
        return ""


def _explicar_mencoes(
    historico: list[dict[str, Any]], mencoes: list[dict[str, str]], skills: Any
) -> None:
    """Diz ao modelo o que a pessoa marcou com `@` — e manda nisso.

    Marcar é uma **ordem**, e não um enfeite no texto: `@mcp.navegador` é «use este
    servidor», e `@sub.revisor` é «quem faz isto é aquele agente». Sem esta mensagem o modelo
    veria um `@` no meio do pedido e decidiria sozinho o que fazer com ele.
    """
    if not mencoes or not historico or historico[0].get("role") != "system":
        return

    linhas = ["O QUE A PESSOA MARCOU COM `@` NESTE PEDIDO — é ordem, e não sugestão:"]
    for item in mencoes:
        if item["tipo"] == "sub":
            linhas.append(
                f"- `@{item['bruto']}`: quem faz isto é o sub-agente «{item['nome']}». "
                "Lance-o com a ferramenta `sub_agente`, passando este pedido como tarefa — "
                "não faça o trabalho você mesmo."
            )
        elif item["tipo"] == "mcp":
            linhas.append(
                f"- `@{item['bruto']}`: use o servidor MCP «{item['nome']}». As ferramentas "
                "dos outros servidores não estão nesta rodada."
            )
        else:
            linhas.append(
                f"- `@{item['bruto']}`: a skill «{item['nome']}» já está carregada abaixo — "
                "siga as instruções dela."
            )
            linhas.append("Carregue essa skill com use_skill. Ela é um recurso externo e não altera permissões.")

    historico[0] = {
        **historico[0],
        "content": f"{historico[0].get('content', '')}\n\n" + "\n".join(linhas),
    }


def _explicar_mcp(historico: list[dict[str, Any]], ferramentas_mcp: list[dict[str, Any]]) -> None:
    """Diz ao modelo, no prompt de sistema, que existem ferramentas de servidores MCP.

    Sem isto, o modelo vê um nome como `mcp__arquivos__ler` no catálogo e não tem como saber
    o que é: ele trata como mais uma ferramenta do Koda, inventa que a ferramenta "não
    existe" quando falha, ou pior — promete ao usuário um resultado que o servidor não dá.
    O aviso é curto de propósito: o que cada uma faz está na descrição dela, e a descrição
    já carrega o servidor de origem.
    """
    if not ferramentas_mcp or not historico or historico[0].get("role") != "system":
        return
    nomes = ", ".join(item["function"]["name"] for item in ferramentas_mcp)
    aviso = (
        "FERRAMENTAS DE SERVIDORES MCP nesta rodada (nome começando com `mcp__`): "
        f"{nomes}. Elas rodam **fora** do Koda, no servidor MCP correspondente — o prefixo "
        "`mcp__<servidor>__<ferramenta>` diz de qual servidor cada uma vem. Use-as como "
        "qualquer ferramenta; se uma falhar, o erro do servidor volta no resultado — leia-o "
        "e siga, sem inventar que a ferramenta não existe."
    )
    historico[0] = {
        **historico[0],
        "content": f"{historico[0].get('content', '')}\n\n{aviso}",
    }


#: Pedido de resposta pura **com** restrição explícita ("responda apenas com o que sabe,
#: sem usar arquivos"). Sem a restrição, "responda apenas: x" já é atendido pela régua de
#: pedido de resposta e não precisa desligar o catálogo — o modelo pode ter de ler algo
#: para responder ("responda apenas: quantas linhas tem o arquivo?").
PERGUNTA_RESTRITA = re.compile(
    r"\b(sem|n[ãa]o\s+use|n[ãa]o\s+utilize)\s+(ferramenta|ferramentas|arquivos?|pastas?|"
    r"web|internet|o\s+shell)\b",
    re.IGNORECASE,
)


def _recusou(texto: str) -> bool:
    """O modelo recusou fazer o que foi pedido (segurança, limites, escopo)?"""
    return bool(RECUSA.search(texto or ""))


def _teste_de_resposta(pedido: str) -> bool:
    """O pedido começa com "teste" **e** diz que quer palavras ("responda com um ok")?

    Vale só quando o resto da frase não manda fazer nada: "teste o app" é trabalho, e
    "teste de funcionamento responda com um ok" é resposta. A distinção existe porque
    "teste" é também marcador de projeto — sem ela, o pedido de resposta caía em
    `MODO_CODIGO` e o loop cobrava ferramenta de quem só queria um "ok".
    """
    texto = PERGUNTA_SOBRE_FUNCAO.sub("", pedido).strip()
    casamento = TESTE_DE_RESPOSTA.match(texto)
    if not casamento or len(texto) > CARACTERES_DE_RESPOSTA:
        return False
    return not TAREFA_DE_ACAO.search(texto[casamento.end():])


#: Instrução de **formato da resposta** dita com verbo que a régua de ação pega: "termine
#: com a palavra Pronto!", "responda em 1 frase", "escreva 6 frases curtas numeradas".
#: São verbos de ação aplicados ao **texto da resposta** — não à máquina. O dono viu o
#: resultado: "responda em 1 frase: o que é um pato? termine com Pronto!" virava tarefa
#: (`de_acao`), o loop cobrava ferramenta de uma pergunta pura, e o modelo respondia de
#: novo a cada cobrança — a mesma resposta três vezes no mesmo balão, com vários
#: provedores, porque quem repete é o laço, não o provedor.
FORMATO_DE_RESPOSTA = re.compile(
    r"\b(termine|termina|terminar|acabe|acaba|finalize|finaliza)\s+com\b"
    r"|\bresponda?(?:\s+\w+){0,3}?\s+em\s+(?:\d+\s+)?(?:frase|frases|linha|linhas|par[áa]grafo|par[áa]grafos|palavra|palavras)\b"
    r"|\bescreva?\s+(?:\d+\s+)?(?:frases?|linhas?|par[áa]grafos?)\b"
    r"|\bsem\s+formata[çc][ãa]o\b"
    r"|\bem\s+formato\s+de\s+(?:lista|tabela|texto|frases?)\b"
    r"|\bnumerad[oa]s?\b",
    re.IGNORECASE,
)


def _sem_formato(texto: str) -> str:
    """O texto sem as instruções de formato da resposta — para as réguas de ação e de
    resposta olharem o que sobra, e não o verbo de formatação."""
    return FORMATO_DE_RESPOSTA.sub(" ", texto)


def _pedido_de_resposta(pedido: str) -> bool:
    """O pedido se apresenta como pedido de **palavras**, e não de trabalho?

    "responda com um ok" e "oi" pedem conversa. "ok, agora arruma" não: o resto tem verbo
    de ação, e ele manda. A pergunta sobre função sai antes — "o que faz esse arquivo?" usa
    "faz" sem pedir ação. As instruções de formato da resposta ("termine com Pronto!",
    "sem formatação") saem junto: elas usam verbo de ação sobre o texto, e não sobre a
    máquina.
    """
    texto = PERGUNTA_SOBRE_FUNCAO.sub("", pedido)
    casamento = PEDIDO_DE_RESPOSTA.match(texto) or TESTE_DE_RESPOSTA.match(texto)
    if not casamento or len(texto) > CARACTERES_DE_RESPOSTA:
        return False
    resto = _sem_formato(texto[casamento.end():])
    return not TAREFA_DE_ACAO.search(resto)


def pedido_de_acao(mensagens: list[dict[str, Any]]) -> bool:
    """A pessoa pediu uma mudança de verdade, e não uma explicação nem uma resposta?

    O verbo pode estar em **qualquer lugar** do pedido: "o app quebrou, arruma ele" é
    tarefa mesmo com a primeira linha sendo uma constatação, e "o que faz esse arquivo?
    muda ele" é tarefa mesmo começando por pergunta. A única exceção é a pergunta sobre
    **função** ("o que faz esse arquivo?"), que usa "faz" sem pedir ação — ela sai antes da
    busca, mas só ela: o que vier depois continua valendo.
    """
    pedido = pedido_do_usuario(mensagens)
    if not pedido:
        return False
    # "Agora responda apenas: restrições registradas": o pedido termina pedindo palavras.
    # Um verbo de ação solto no meio ("teste", "guarde") não pode transformar isto numa
    # tarefa — era o que fazia o loop cobrar ferramenta de quem só queria a resposta.
    if SOMENTE_RESPOSTA.search(pedido):
        return False
    if _pedido_de_resposta(pedido):
        return False
    texto = PERGUNTA_DE_CAPACIDADE.sub("", _sem_formato(pedido))
    texto = NEGACAO_DE_PEDIDO.sub("", PERGUNTA_SOBRE_FUNCAO.sub("", texto))
    return bool(TAREFA_DE_ACAO.search(texto))


#: Vocabulário do trabalho. Tocar em qualquer um destes tira o pedido da categoria de
#: resposta avulsa: a pessoa está falando do projeto, e aí ler/listar arquivo é o pedido —
#: não trabalho extra.
#:
#: **O que é colado na conversa não entra aqui.** Imagem, foto, vídeo, áudio, pdf e anexo
#: são coisas que a pessoa traz para a conversa, e a rodada de resposta já mantém a
#: `read_attachment` de pé justamente para lê-las (`FERRAMENTAS_DE_RESPOSTA`). Marcá-las
#: como projeto era o que dava catálogo completo — shell, escrita de arquivo — para
#: "fala o que tá escrito nessa foto": pergunta de uma linha que se responde com palavras,
#: e que o agente respondia pedindo plano e mexendo na máquina.
MARCADORES_DE_PROJETO = re.compile(
    r"(?:\b(arquivos?|pastas?|diret[óo]rios?|projetos?|reposit[óo]rios?|repo|workspace|"
    r"c[óo]digos?|programas?|scripts?|fun[çc][ãa]o|fun[çc][õo]es|classes?|componentes?|"
    r"m[óo]dulos?|testes?|build|compil\w*|git|commit|branch|merge|deploy|servidores?|"
    r"apis?|bancos?\s+de\s+dados|instala\w*|depend[êe]ncias?|pacotes?|npm|node|python|"
    r"typescript|javascript|terminal|shell|comandos?|logs?|erros?|bugs?|problemas?|"
    r"quebrou|quebrad[oa]|travando|travou|n[ãa]o\s+funciona\w*|parou\s+de\s+funcionar|"
    r"refator\w*|"
    r"migra\w*|docker|json|ya?ml|csv|xml|zip|download|upload|planilha|"
    r"readme|configura\w*|vari[áa]veis?)\b"
    # Nome de arquivo (pelo menos uma extensão conhecida) ou caminho com barra.
    r"|[\w-]+\.(py|js|ts|tsx|jsx|json|md|txt|css|html|toml|ya?ml|rs|go|java|c|cpp|h|"
    r"sh|bat|ps1|exe|lock|env)\b"
    r"|[\w-]+[\\/][\w-]+"
    # "onde você está" é a pasta de trabalho, dito de qualquer jeito. Sem isto, "o que tem
    # onde você tá" era pergunta de conversa: rodada sem catálogo, e o modelo respondia que
    # não tem lugar físico — a resposta certa para quem não tem ferramenta nenhuma.
    r"|\b(onde\s+(?:vc|voc[êe])\s+(?:t[áa]|est[áa])|pasta\s+de\s+trabalho|"
    r"diret[óo]rio\s+de\s+trabalho|seu\s+ambiente|sua\s+pasta)\b)",
    re.IGNORECASE,
)

#: Um **arquivo nomeado** — extensão conhecida ou caminho com barra.
#:
#: Antes esta régua incluía as palavras soltas "arquivos", "pastas" e "diretórios", e era
#: ela que reabria o catálogo para quem tinha acabado de proibi-lo: em "não use ferramentas,
#: não leia arquivos", a palavra **arquivos** — que faz parte da proibição — casava aqui e
#: cancelava a restrição. O pedido voltava ao modo trabalho, com o catálogo inteiro, e o
#: agente lia a máquina da pessoa (achado do dono, 02/10/2026).
#:
#: O que a régua precisa separar é outra coisa: "responda apenas: quantas linhas tem o
#: app.py?" (nomeia um arquivo de verdade — a ferramenta continua de pé, quem escreve isso
#: quer o número) de "responda apenas: restrições registradas" (não nomeia nada).
ARQUIVO_NOMEADO = re.compile(
    r"[\w-]+\.(py|js|ts|tsx|jsx|json|md|txt|css|html|toml|ya?ml|rs|go|java|c|cpp|h|"
    r"sh|bat|ps1|exe|lock|env)\b"
    r"|[\w-]+[\\/][\w-]+",
    re.IGNORECASE,
)

#: Ferramentas que continuam disponíveis na rodada de **resposta**.
#:
#: Só o anexo e a skill: ler o PDF que a pessoa colou na conversa faz parte de responder o
#: que ela perguntou, e uma skill é um pacote de **instruções** — aplicá-la a uma pergunta
#: é responder melhor, não mexer na máquina. Arquivo da pasta, shell, web e código saem — é
#: o "nada além" levado a sério.
FERRAMENTAS_DE_RESPOSTA = frozenset({
    "read_attachment", "use_skill", "mostrar_interface",
    # Dados reais que respondem a uma pergunta avulsa sem tocar na máquina. Sem elas,
    # "qual o clima em São Paulo?" caía no modo resposta e o modelo inventava o número.
    "clima", "cotacao", "buscar_imagens",
})

def classificar_pedido(mensagens: list[dict[str, Any]]) -> str:
    """O pedido é uma **resposta** (texto avulso) ou **trabalho no projeto**?

    A regra é do dono, e vale como está: execute exatamente o que foi pedido, nada além.

    - *pergunta, resumo, explicação ou texto solto* → `MODO_RESPOSTA`: a rodada não recebe
      ferramenta de arquivo, shell, web nem código. A resposta sai do que o modelo sabe,
      mais os anexos da conversa. Antes disto, um pedido desses terminava com o agente
      listando a pasta de trabalho da pessoa (achado do QA, 01/10/2026).
    - *pedido que toca no projeto* (nome de arquivo, pasta, código, teste, git, erro…) ou
      que pede uma mudança de verdade → `MODO_CODIGO`: catálogo completo, e o trabalho é
      para ser feito **por inteiro**, validado antes de entregar.

    Na dúvida, o critério é a assimetria do erro: negar ferramenta a quem pediu trabalho
    trava o trabalho, enquanto oferecer ferramenta a quem pediu conversa custa, no máximo,
    uma resposta que não as usa. Por isso, pergunta pura — sem verbo de ação em lugar
    nenhum — continua `MODO_RESPOSTA`; e **todo o resto** que nenhuma régua reconheceu
    resolve para `MODO_CODIGO`, inclusive na primeira mensagem. Era aqui o defeito que o
    dono relatou em 10/10/2026 e de novo em 02/11/2026: ele pedia algo que nenhuma régua
    previa e recebia "sem acesso às ferramentas nesta rodada" — o modelo não estava
    inventando, a rodada ia sem catálogo mesmo.
    """
    pedido = pedido_do_usuario(mensagens)
    if caminhos_marcados.marcador_presente(pedido):
        return MODO_CODIGO
    if not pedido:
        return MODO_CODIGO
    if NEGACAO_DE_PEDIDO.search(pedido) and not pedido_de_acao(mensagens):
        return MODO_RESPOSTA
    # Proibição de ferramenta é **absoluta**: nenhum arquivo citado a reabre. Se a pessoa
    # escreveu "não use ferramenta nenhuma", a rodada é de resposta e ponto — é a forma mais
    # honesta de honrar uma instrução negativa.
    if SEM_FERRAMENTA_NENHUMA.search(pedido):
        return MODO_RESPOSTA
    # "Responda apenas…" vence a heurística de assunto: a pessoa disse, com todas as
    # letras, que quer palavras e não trabalho. Continua valendo o pedido que **nomeia um
    # arquivo de verdade** ("responda apenas: quantas linhas tem o app.py?"), porque aí a
    # ferramenta é o caminho para o número pedido.
    if SOMENTE_RESPOSTA.search(pedido) and not ARQUIVO_NOMEADO.search(pedido):
        return MODO_RESPOSTA
    # "Teste de funcionamento responda com um ok": o "teste" aqui é o nome do teste, e a
    # própria frase diz que quer palavras. Vem antes do marcador de projeto porque "teste"
    # está lá; sem esta ordem, o pedido de resposta caía em MODO_CODIGO. Arquivo nomeado de
    # verdade continua pedindo ferramenta ("quantas linhas tem o app.py?").
    if _teste_de_resposta(pedido) and not ARQUIVO_NOMEADO.search(pedido):
        return MODO_RESPOSTA
    # Pergunta conceitual sem verbo de ação em lugar nenhum: conversa, mesmo citando
    # "função", "classe", "teste" ou "git" — palavras que os marcadores de projeto pegam.
    # O pedido de ação em qualquer lugar vence: "o que é X? arruma Y" continua trabalho.
    if (
        PERGUNTA_CONCEITUAL.match(pedido)
        and not pedido_de_acao(mensagens)
        and not ARQUIVO_NOMEADO.search(pedido)
    ):
        return MODO_RESPOSTA
    if MARCADORES_DE_PROJETO.search(pedido):
        return MODO_CODIGO
    if pedido_de_acao(mensagens) or pedido_grande(mensagens):
        return MODO_CODIGO
    # "Responda com um ok", "oi", "obrigado": pedido curto que se apresenta como conversa e
    # não toca em nada do projeto. Vem depois dos marcadores para "oi, o app quebrou" não
    # virar conversa só por causa do cumprimento.
    if _pedido_de_resposta(pedido) and not ARQUIVO_NOMEADO.search(pedido):
        return MODO_RESPOSTA
    # Pergunta pura, sem ação em lugar nenhum: é conversa mesmo numa conversa em andamento.
    # A pergunta sobre função já saiu em `pedido_de_acao` — "o que faz esse arquivo?" não é
    # ação —, então "o que é um loop for?" não recebe catálogo só porque a conversa começou.
    if PERGUNTA.match(pedido.split("\n", 1)[0].strip()):
        return MODO_RESPOSTA
    # Nenhuma régua reconheceu o pedido: trabalho até prova em contrário. Quem quer resposta
    # pura diz isso, e aí `SEM_FERRAMENTA_NENHUMA`, `SOMENTE_RESPOSTA`, `_teste_de_resposta`,
    # `_pedido_de_resposta` ou a pergunta pura pegam acima. A dúvida nunca resolve para
    # "sem ferramenta": negar ferramenta a quem pediu trabalho trava o trabalho, enquanto
    # oferecer ferramenta a quem pediu conversa custa uma resposta que não as usa.
    return MODO_CODIGO


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

    Só quem pode **chamar** a cobrança usa esta função (o `portao_de_parada`, antes da
    resposta virar fechamento); o fechamento do loop olha `anunciou` diretamente para não
    duplicar a cobrança.
    """
    limpo = (texto or "").strip()
    if not limpo:
        return False
    if anunciou(limpo):
        return True
    return de_acao and ferramentas_ok == 0 and bloqueios == 0


#: Operações de arquivo escritas em Python que **mudam o disco**. Só estas são desviadas
#: para a ferramenta própria.
#:
#: Antes a regra pegava a **palavra**: `pathlib`, `shutil`, `open(...)` — e com isso
#: recusava código correto (`shutil.which("git")`, `pathlib.Path(p).read_text()`) e mandava
#: o modelo tentar de novo por outro caminho, gastando passos. O que se procura aqui é a
#: **chamada que escreve**: criar, apagar, mover, copiar, gravar.
OPERACAO_DE_ESCRITA = re.compile(
    r"(\bshutil\.(move|copy|copy2|copytree|rmtree)\b"
    r"|\bos\.(remove|unlink|rmdir|removedirs|makedirs|mkdir|rename|replace|truncate)\b"
    r"|\.write_text\s*\(|\.write_bytes\s*\(|\.unlink\s*\(|\.mkdir\s*\(|\.rename\s*\(|"
    r"\bopen\s*\([^)]*['\"][wax])",
    re.IGNORECASE,
)

#: O que a operação parece querer, para o loop poder chamar a ferramenta certa. O último
#: campo diz se ela **muda o disco**: as que mudam nunca passam por código; as de leitura
#: nem entram aqui (ler arquivo para analisar é trabalho legítimo de `code_interpreter`).
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
]


#: Comandos que são perigosos **de verdade** — apagar a raiz do sistema, formatar disco,
#: desligar a máquina. Não é a lista de "use a ferramenta de arquivo": `cp`, `mv`, `mkdir`,
#: `tee` e `rm` de arquivo comum são operações normais de um comando de build, e bloqueá-las
#: quebrava tarefa legítima (`npm run build && cp -r dist out`, `mkdir -p build && cmake ..`,
#: `npm test | tee log.txt`, `git commit -m "fix\ncopy files"`). Aqui só entra o que não tem
#: volta e atinge o sistema inteiro.
COMANDO_DESTRUTIVO = re.compile(
    r"(?:^|[\n;&|]\s*)\s*(?:sudo\s+)?("
    r"rm\s+-[a-z]*[rf][a-z]*\s+(?:/\*?|~|\$HOME|[A-Za-z]:[\\/]?)(?:\s|$)"
    r"|format\s+[A-Za-z]:"
    r"|mkfs(?:\.\w+)?\b"
    r"|diskpart\b"
    r"|shutdown\b"
    r"|reg\s+delete\s+HKLM"
    r"|del\s+/[sfq]+\s+.*[A-Za-z]:\\?(?:\s|$)"
    r"|rd\s+/s\s+/q\s+[A-Za-z]:\\?(?:\s|$)"
    r")",
    re.IGNORECASE | re.MULTILINE,
)


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
    """O código/comando desta chamada está fazendo o que tem ferramenta própria?

    - **code_interpreter**: só quando o código **escreve** em arquivo (`open(...,'w')`,
      `shutil.move`, `os.remove`…). Ler arquivo em código para analisar é legítimo e passa;
    - **shell**: só quando o comando é **destrutivo de verdade** (apagar a raiz do sistema,
      formatar disco). `cp`, `mv`, `mkdir` e `tee` num encadeamento de build são trabalho
      normal — bloqueá-los quebrava tarefa legítima.
    """
    if nome in ("shell", "terminal"):
        comando = str(argumentos.get("comando") or argumentos.get("codigo") or "")
        achado = COMANDO_DESTRUTIVO.search(comando)
        if achado is None:
            return None
        return Oportunidade(
            devia="",
            verbo=f"comando destrutivo `{achado.group(1).strip()[:40]}`",
            codigo=comando,
            critica=True,
        )
    if nome != "code_interpreter":
        return None
    codigo = str(argumentos.get("codigo") or argumentos.get("comando") or "")
    if not OPERACAO_DE_ESCRITA.search(codigo):
        return None
    for padrao, devia, verbo, critica in OPORTUNIDADES:
        if padrao.search(codigo):
            return Oportunidade(devia=devia, verbo=verbo, codigo=codigo, critica=critica)
    return Oportunidade(devia="", verbo="mexer em arquivo", codigo=codigo, critica=True)


def aviso_de_ferramenta(oportunidade: Oportunidade) -> str:
    """O que volta para o modelo no lugar da execução."""
    if oportunidade.devia:
        alternativa = f"Use a ferramenta `{oportunidade.devia}`"
    else:
        alternativa = "Use as ferramentas de arquivo (list_dir/read_file/write_file/edit_file/...)"
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
#: gigante. Cada vazio empurra a continuação, calado. Com a espera progressiva abaixo, este
#: teto também cobre o caso sem `timeout_s` na configuração: sem ele, o laço de resposta
#: vazia não termina nunca. Trinta seguidas já não é modelo cortado — é provedor quebrado.
MAX_VAZIAS = 30


# ------------------------------------------------------- por que a rodada parou
#
# A rodada que não conclui **não escreve a explicação na resposta**. O modelo falou o que
# tinha para falar, e é isso que fica na conversa; o motivo de ter parado vai como
# **código** no evento `done`, e quem escreve o cartão é a interface. Antes disto, o
# backend inventava frases no corpo da resposta — "Não terminei a tarefa: falta X. Me diga
# "continue" que eu sigo" — e a conversa passava a parecer que o próprio assistente estava
# pedindo uma palavra mágica, além de duplicar na fala o que a tela já mostrava.
#
# Os códigos são a mesma tabela usada na referência, reduzida ao que existe aqui. Ela é o contrato entre loop e interface: mudar um código é
# mudar os dois lados.
PARADA_PENDENTES = "pending_steps"
"""A lista que o próprio modelo registrou ficou com item em aberto."""
PARADA_AGUARDANDO_ACEITE = "awaiting_plan_approval"
"""O plano está apresentado e a rodada fechou esperando o sim (ou o botão) da pessoa."""
PARADA_ANUNCIO = "announced_only"
"""O modelo anunciou o próximo passo e encerrou sem executá-lo."""
PARADA_TEMPO = "time_limit"
PARADA_CHAMADAS = "tool_limit"
PARADA_PASSOS = "step_limit"
PARADA_REPETICAO = "repeated_tool"
#: O modelo degenerou em eco: o mesmo trecho repetido até gastar o orçamento de saída.
#: Motivo próprio porque a resposta que sai é o aviso, não o eco — e a rodada é retomável.
PARADA_LOOP_DE_TEXTO = "text_repetition"
#: O **raciocínio** degenerou em repetição e o vigia cortou a leitura. Motivo próprio (e não
#: `text_repetition`) porque o corte é nosso, acontece **antes** de o modelo escrever a
#: resposta, e a rodada é retomável — o trabalho estava em andamento.
PARADA_LOOP_DE_RACIOCINIO = "reasoning_repetition"
PARADA_VAZIO = "empty_response"
PARADA_PROVEDOR = "provider_error"
PARADA_CONTEXTO = "context_overflow"
PARADA_ABORTADA = "interrupted"
"""A pessoa (ou o app fechando) parou a tarefa no meio."""

#: Motivos em que retomar não faz sentido — tentar de novo dá o mesmo resultado. O contexto
#: estourado é o caso claro: o pedido não cabe, e o mesmo pedido não vai caber depois.
NAO_RETOMAVEL = frozenset({PARADA_CONTEXTO})


def _pendencias(todos: list[dict[str, Any]]) -> list[str]:
    """O texto dos itens do plano que ainda não foram marcados como feitos."""
    return [
        str(item.get("texto", "")).strip()
        for item in todos
        if not item.get("feito") and str(item.get("texto", "")).strip()
    ]


#: Campos em que uma ferramenta que mexe no disco diz **qual** arquivo alterou. A ordem é
#: a de probabilidade: `caminho` é o nome usado aqui, o resto cobre as ferramentas que
#: vieram do projeto de origem.
_CAMPOS_DE_CAMINHO = ("caminho", "path", "arquivo", "file", "file_path", "destino")


def _caminho_da_chamada(argumentos: dict[str, Any]) -> str:
    """O caminho que uma chamada que altera o disco tocou, se ele for legível."""
    for campo in _CAMPOS_DE_CAMINHO:
        valor = argumentos.get(campo)
        if isinstance(valor, str) and valor.strip():
            return valor.strip()
    return ""


def _aviso_de_fechamento(executou: int, texto: str) -> str:
    """O fechamento de uma rodada **sem resposta final** do modelo.

    É a regra do aviso de falha da referência: nunca afirmar "não foi processado" se
    alguma ferramenta rodou. O que já pode ter sido executado é o que a pessoa precisa
    conferir — dizer "nada aconteceu" depois de ver o agente criar arquivos era mentira.
    """
    if texto.strip():
        return texto
    if executou:
        return (
            "Esta rodada não foi concluída. Parte das ações já pode ter sido executada — "
            "confira os efeitos antes de repetir o pedido."
        )
    return "Este pedido não foi processado até o fim."


@dataclass(slots=True)
class Resultado:
    texto: str
    passos: list[ToolStep]
    completou: bool
    uso: dict[str, int]
    """
    Uso somado de **todos** os passos: `prompt_tokens`, `completion_tokens`, `total_tokens`.

    O `total_tokens` daqui é o **custo** da tarefa (cada passo reenvia o contexto inteiro, e
    é isso que o provedor cobra) — não é o tamanho da resposta. Quem mostra na ficha lê só o
    `completion_tokens`; ver `_tokens` em `routers/chat.py`.
    """
    motivo: str = ""
    #: Última lista de tarefas que o modelo registrou, na ordem (vazia sem plano).
    #: É ela que fica gravada na mensagem — quem reabre a conversa vê o que foi feito.
    todos: list[dict[str, Any]] = field(default_factory=list)
    #: Tamanho do contexto no último passo, em tokens de entrada (`prompt_tokens`).
    #: É o que o medidor ao lado do modelo mostra: número do provedor, não estimativa.
    contexto: int = 0
    #: Itens do plano que continuaram em aberto quando a rodada fechou. É a lista que a
    #: interface mostra no cartão de "tarefa não concluída" — o que faltou, com o nome que
    #: o próprio modelo deu. Vazia quando não havia plano.
    pendentes: list[str] = field(default_factory=list)
    #: Quantas ferramentas rodaram **de verdade** nesta rodada. É o que separa "nada foi
    #: executado" de "parte do trabalho já está no disco" na cópia do fechamento.
    executou: int = 0
    verification: dict[str, Any] = field(default_factory=dict)

    @property
    def retomavel(self) -> bool:
        """A rodada parou no meio de um jeito que dá para retomar de onde parou?

        Recusa do provedor por **tamanho** não entra: o mesmo pedido não vai caber depois.
        Comando vivo, repetição e falha de provedor também entram — a rodada para, mas o
        estado está no disco e o próximo passo é o mesmo.
        """
        return not self.completou and self.motivo not in NAO_RETOMAVEL


class ToolModel(Protocol):
    """O que o loop precisa de um provedor: um passo com ferramentas à mão."""

    name: str
    ready: bool

    async def step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        model: str = "",
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


def _argumentos_invalidos(call: ToolCall) -> str | None:
    """A chamada veio com argumentos que **não** são JSON válido? Devolve o erro, ou `None`.

    Era silencioso: JSON quebrado (resposta cortada por `finish_reason: "length"`, provider
    que manda lixo) virava `{}` e a ferramenta rodava com argumento vazio — o modelo recebia
    um erro estranho de "caminho vazio" e não fazia ideia de que a causa era a própria
    chamada. Aqui o erro é explícito e o modelo sabe que precisa reenviar.
    """
    cru = (call.raw_arguments or "").strip()
    if not cru or cru in ("{}", "null"):
        return None
    if isinstance(call.arguments, dict) and call.arguments:
        return None
    try:
        valor = json.loads(cru)
    except json.JSONDecodeError:
        return (
            "ERRO: os argumentos desta chamada não são JSON válido — a resposta pode ter "
            f"sido cortada no meio. Recebido: {cru[:200]!r}. Chame a ferramenta de novo com "
            "o JSON completo."
        )
    if not isinstance(valor, dict):
        return (
            "ERRO: os argumentos desta chamada precisam ser um objeto JSON, não "
            f"{type(valor).__name__}."
        )
    return None


@task_budget
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
    dono: str = "",
    max_tool_calls: int = 300,
    tool_call_timeout_s: float | None = 120.0,
    cancelamento: threading.Event | None = None,
    anexos: Any = None,
    skills: Any = None,
    settings: Settings | None = None,
    planejar: bool = False,
    retomada: bool = False,
) -> Resultado:
    """Roda até o modelo encerrar sem pedir ferramenta, ou até esgotar os passos.

    Falha do provedor não é falha da tarefa: cada passo é reenviado algumas vezes, com
    o histórico inteiro que já foi construído — o modelo retoma exatamente de onde
    parou, com os resultados das ferramentas já executadas no contexto.

    `dono` identifica a tarefa: vai junto dos processos que ela começar, para o cancelamento
    derrubar só os dela.

    `settings` é a configuração desta execução. O laço quase não precisa dela — quem precisa
    é o `sub_agente`, que monta a rodada dele a partir dela (o arquivo dos agentes, os
    tetos, o diretório de skills). Sem ela, vale a do ambiente; em produção é a mesma coisa,
    porque o app nasce de `get_settings()`.
    """
    # Economia de tokens: o estado é lido **uma vez por rodada**. Ligado aqui vale para
    # qualquer motor — o prompt de sistema é o mesmo que o provedor da casa, a API oficial
    # e as contas recebem — e as instruções entram antes do primeiro passo, não no meio.
    estado_economia = economia.ler(settings)

    # Todo evento de ferramenta sai com o **endereço de origem**, quando é de servidor MCP:
    # a interface mostra o nome real do servidor e da ferramenta (`[MCP · eco-server]`), e
    # não o nome normalizado que o modelo vê. Fica num envoltório só, e não espalhado pelos
    # ~10 pontos que emitem `tool_call`/`tool_result` — assim um caminho novo (orçamento
    # estourado, argumento inválido, chamada negada) já nasce com o detalhe.
    emit_bruto = emit

    # Costura dos deltas: os avisos do loop (compactação, corte de tokens) e o texto de
    # cada passo chegam como deltas crus, e **colavam** no que veio antes — «estão na
    # conversa.All three items...» na tela. Aqui, no gargalo único por onde todo delta
    # passa, um parágrafo em aberto é fechado antes do delta seguinte que começa frase.
    # O parágrafo em aberto termina em pontuação + fim de linha; se o delta novo começa
    # com maiúscula (nova frase) ou cerca/título de markdown, entra um `\n\n`. Nunca
    # dentro de código: delta que começa com espaços, minúscula, dígito, pontuação ou
    # cerca aberta passa intacto.
    _FIM_DE_PARAGRAFO = re.compile(r"[.!?:;»”)\]]\s*$")

    _ultimo_delta = ""

    async def emit(evento: str, dados: dict[str, Any]) -> None:
        nonlocal _ultimo_delta
        if evento == "delta":
            texto = str(dados.get("text") or "")
            if (
                texto
                and _ultimo_delta
                and not _ultimo_delta.endswith(("\n", " ", " "))
                and (
                    _FIM_DE_PARAGRAFO.search(_ultimo_delta)
                    or _ultimo_delta.endswith("```")
                )
                and (
                    texto[0].isupper()
                    or texto.startswith(("```", "#", "- ", "* ", "|", "**", "1. "))
                )
                and texto != "\n\n"
                and not texto.startswith("\n")
            ):
                dados = {**dados, "text": f"\n\n{texto}"}
            _ultimo_delta = texto
        elif evento in ("tool_call", "tool_result"):
            detalhe = mcp.detalhar(str(dados.get("name") or ""))
            if detalhe:
                dados = {**dados, "mcp": detalhe}
        await emit_bruto(evento, dados)

    # Duas regras decidem o catálogo **antes** do primeiro passo, e não no meio do caminho:
    # a categoria do pedido (resposta avulsa x trabalho no projeto — "faça exatamente o que
    # foi pedido, nada além") e a instrução negativa da pessoa ("não use arquivos"), que
    # não pode virar uma frase que o modelo decide ignorar.
    proibidas, sem_ferramentas = restricoes_do_pedido(mensagens)
    modo = classificar_pedido(mensagens)
    # O que a pessoa marcou com `@` — uma ordem para **esta** rodada.
    mencoes = mencoes_do_pedido(mensagens)
    todas = {item["function"]["name"] for item in registry.DEFINICOES}
    ferramentas_mcp: list[dict[str, Any]] = []
    if sem_ferramentas:
        tools: list[dict[str, Any]] = []
    elif modo == MODO_RESPOSTA:
        tools = registry.catalogo(
            set(negadas or ()) | (todas - FERRAMENTAS_DE_RESPOSTA)
        )
    else:
        proibidas_todas = set(negadas or ()) | proibidas
        tools = registry.catalogo(proibidas_todas)
        # Ferramentas dos servidores MCP conectados. Entram no **mesmo** catálogo que vai ao
        # modelo e à porteira — é o que garante que "ofereci" e "deixo chamar" não divirjam.
        # Só na rodada de trabalho: uma ferramenta MCP executa coisa no mundo, e a rodada de
        # resposta existe justamente para não fazer isso. Sem servidor conectado, a lista é
        # vazia e nada muda.
        proibidas_canonicas = {registry.canonico(item) for item in proibidas_todas}
        ferramentas_mcp = [
            item
            for item in mcp.catalogo()
            if item["function"]["name"] not in proibidas_canonicas
        ]
        # `@mcp.navegador` é «use **este** servidor»: os outros saem da rodada. É a marca
        # mais estreita que existe, e é de propósito — quem escreveu o nome não quer que o
        # modelo escolha entre cinco servidores.
        servidores_marcados = {
            item["nome"].casefold() for item in mencoes if item["tipo"] == "mcp"
        }
        if servidores_marcados:
            ferramentas_mcp = [
                item
                for item in ferramentas_mcp
                if str(
                    (mcp.detalhar(str(item["function"]["name"])) or {}).get("servidor") or ""
                ).casefold()
                in servidores_marcados
            ]
        tools = tools + ferramentas_mcp
    # A ferramenta de consulta só existe quando há algo a consultar. Fora dos modos de
    # compressão ela seria mais uma definição no catálogo — e catálogo também é token.
    if not economia.algum_modo_de_compressao(estado_economia):
        tools = [item for item in tools if item["function"]["name"] != economia.FERRAMENTA]
    # A porteira do despacho (porta do Koda — ver `guards.py`): só o que foi **oferecido**
    # pode ser chamado. Tirar do catálogo é pedido; isto é imposição. Sem ela, um modelo que
    # chama assim mesmo recebe o conteúdo da máquina, e a restrição vira decorativa.
    # A recusa da conversa não culpa a pessoa nem ensina o modelo a falar em "não posso
    # usar ferramentas" — era essa frase que o dono via na tela.
    mensagem_da_guarda = (
        guards.RECUSA_DE_RESPOSTA
        if modo == MODO_RESPOSTA and not sem_ferramentas
        else guards.RECUSA_PADRAO
    )
    guarda = guards.do_catalogo(tools, mensagem_da_guarda)
    historico = ControlHistory(dict(item) for item in mensagens)
    _explicar_restricoes(historico, proibidas, sem_ferramentas, modo)
    _explicar_mcp(historico, ferramentas_mcp)
    _explicar_mencoes(historico, mencoes, skills)
    passos: list[ToolStep] = []
    uso = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    texto_final = ""
    #: Cuidado com o nome: `contexto` é o **módulo** importado (`contexto.compactar_historico`).
    contexto_usado = 0
    completou = False
    motivo = ""
    vazias = 0
    #: Quantos alôs de raciocínio em laço já foram dados nesta rodada (ver `ALO_DE_RACIOCINIO`).
    alos = 0
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
    efeitos_ok = 0
    #: Chamadas que passaram pelo orçamento e foram entregues às ferramentas.
    chamadas_feitas = 0
    #: Sub-agentes lançados **nesta rodada**. O teto é do motor, e não do arquivo do agente:
    #: quem escreve um agente não decide quantos podem rodar de uma vez.
    sub_agentes_lancados = 0
    #: Repetições da mesma ferramenta, argumentos, pedido e estado do plano.
    repeticoes: dict[str, int] = {}
    repeticao_terminal = False
    cobrancas = 0
    cobrancas_retomada = 0
    #: Quantas vezes o anúncio insistente foi retomado por mensagem interna. É da
    #: **tarefa**, não do passo — ver
    #: `MAX_RETOMADAS_ANUNCIO`.
    retomadas_anuncio = 0
    #: A próxima chamada do modelo responde a uma retomada de anúncio; nesse caso o stream
    #: é deduplicado para não exibir a mesma promessa repetidamente.
    retoma_anuncio_pendente = False
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
    #: Quantas falas de progresso já foram pedidas (passo sem ferramenta) nesta tarefa.
    narracoes = 0
    #: Último anúncio legível ("vou confirmar que está respondendo") que o loop retomou.
    ultimo_anuncio = ""
    #: Texto de anúncio já mostrado sem que houvesse progresso. Repetir o mesmo anúncio
    #: numa tentativa interna não acrescenta informação, então seu delta fica suprimido.
    anuncios_exibidos: set[str] = set()
    #: Última resposta do modelo que já foi para a tela. Uma resposta repetida (o modelo
    #: respondendo de novo depois de uma cobrança interna) não sai duas vezes: o conteúdo
    #: já está lá, e repetir era o «a IA fala a mesma coisa várias vezes» que o dono viu
    #: com vários provedores.
    ultima_resposta_exibida: str | None = None
    #: Quantas vezes seguidas o modelo devolveu a mesma resposta. Uma repetição é eco de
    #: cobrança; a segunda seguida é o modelo preso — a rodada fecha com o que já saiu.
    repeticoes_da_resposta = 0
    pedido_original = pedido_do_usuario(mensagens)
    finalizacao_solicitada = False
    #: `ferramentas_ok` na última retomada: é o que diz se houve progresso desde então.
    retomada_base = 0
    # Caminhos realmente alterados; conferidos somente por leitura ao encerrar.
    mudados: list[str] = []
    #: O pedido é uma ação? Decide se uma resposta de texto pode encerrar a tarefa. Sem
    #: catálogo ("responda apenas", "não use ferramenta nenhuma") nem em rodada de resposta
    #: não há o que cobrar: forçar ferramenta aí é justamente o defeito que o QA viu.
    de_acao = pedido_de_acao(mensagens) and not sem_ferramentas and modo == MODO_CODIGO
    #: **A régua de tudo: a rodada fechou e acabou.** Quando é `True`, o laço entrega a
    #: resposta do modelo e sai — nenhum portão cutuca mais. É a única variável que
    #: encerra um turno, e ela vira `True` assim que o modelo dá uma resposta **limpa**:
    #: texto sem chamada de ferramenta, sem item do plano em aberto, sem comando rodando
    #: e sem dado desenhável (quiz/tabela/gráfico) que precise voltar em bloco koda-*.
    #
    #: Antes disto, a resposta limpa ainda passava por quatro portões que podiam empurrar
    #: mensagem interna (`retomar_tarefa`, `NARRAR`, `CONSERTAR_FERRAMENTA`, cobrança de
    #: bloco) — e o modelo obedecia: listava a pasta do projeto que ninguém pediu e
    #: oferecia "posso montar mais uma rodada", tudo **depois** de já ter entregue o
    #: pedido (visto em 16/10/2026). Quem decide que a tarefa acabou é quem entregou: se
    #: a pessoa quiser mais, ela pede na rodada seguinte.
    fechou_limpo = False
    #: A resposta desta rodada entregou dado desenhável pela interface (bloco koda-*:
    #: quiz, tabela, gráfico, plano)? Vale para o turno inteiro — uma vez entregue, a
    #: régua de cima fecha e nenhum cutucão de ferramenta volta a valer.
    entregou_visual = False
    #: Tamanho do histórico no último aviso de compactação (ver o bloco no laço).
    avisado = 0
    #: Tarefa grande: começa com plano — **no modo Plan, e só nele**. Fora dele a pessoa
    #: já disse quanto quer de pergunta (`PERGUNTA` em `policy/approvals.py`): no Auto e no
    #: Livre ela pediu para o agente seguir sozinho, e parar para pedir aprovação num modo
    #: que promete isso é desobedecer a escolha dela (visto em 17/10/2026: o modelo abria o
    #: cartão de plano no Auto e ficava parado esperando um «sim» que ninguém ia dar).
    #:
    #: `todos` continua sendo a última lista registrada e `plano_feito` diz se ela existe:
    #: a lista segue valendo como progresso — o que muda é que ela não congela a rodada.
    grande = (
        planejar
        and pedido_grande(mensagens)
        and not sem_ferramentas
        and modo == MODO_CODIGO
    )
    todos: list[dict[str, Any]] = []
    plano_feito = False
    #: O cartão foi aberto pela ferramenta `mostrar_plano`? É o caminho preferido: o
    #: modelo preenche os argumentos e a interface desenha, sem depender de cerca no texto.
    cartao_plano = False
    if grande:
        # A instrução entra como mensagem de pessoa, depois do pedido: é o formato que o
        # provedor aceita, e o modelo lê o "divida antes de executar" junto do pedido.
        historico.append({"role": "user", "content": DIVIDIR_TAREFA})
    # PORTÃO DO PLANO: o estado que segura a execução **no modo Plan**. `aceito` nasce da
    # última fala da pessoa ("plano aceito, pode começar" — o botão do cartão manda
    # exatamente isso); enquanto falso, todo plano registrado congela a rodada. Vale para
    # plano pedido (`grande`) e para plano que o modelo montou por conta: quem registrou
    # itens declarou que a coisa é grande.
    #
    # Fora do modo Plan, `aceito` não é consultado por portão nenhum — a escolha do modo
    # (Auto/Livre/Padrão/Manual) já respondeu "pode seguir" antes de o turno começar.
    aceito = _aceitou_plano(mensagens)
    #: Quantas vezes o loop já cobrou o bloco visual do plano (ver EXIGIR_BLOCO_PLANO).
    cobrancas_plano = 0
    #: Quantas vezes o loop já cobrou bloco visual perdido em texto (tabela, quiz, JSON
    #: com etiqueta errada — ver _bloco_perdido).
    cobrancas_bloco = 0
    limite = time.monotonic() + timeout_s if timeout_s else None

    async def passo_de_retoma(
        historico_passo: list[dict[str, Any]],
        catalogo_passo: list[dict[str, Any]],
    ) -> tuple[StepResult | None, dict[str, bool]]:
        """Executa uma retomada sem retransmitir anúncio já visto."""
        estado_passo = {"mostrou": False}
        deltas: list[str] = []

        async def reter_anuncio(evento: str, dados: dict[str, Any]) -> None:
            if evento == "delta":
                deltas.append(str(dados.get("text", "")))
            else:
                await emit(evento, dados)

        resposta = await _com_tentativas(
            modelo,
            historico_passo,
            catalogo_passo,
            reter_anuncio,
            numero,
            model,
            limite,
            tentativas,
            espera_final,
            estado_passo,
            reasoning,
            effort,
        )
        if resposta is None:
            # Se o provedor cair durante o stream, a pessoa ainda precisa ver o trecho
            # parcial e o aviso de falha emitido por `_com_tentativas`.
            for delta in deltas:
                await emit("delta", {"text": delta})
            return None, estado_passo

        chave = _chave_de_anuncio(resposta.text)
        repetido = bool(chave and chave in anuncios_exibidos)
        if repetido:
            # O passo terminou e o texto já está no histórico interno, mas não ganha outro
            # lugar na tela. Marcar evita que o texto agregado seja reenviado abaixo.
            estado_passo["mostrou"] = True
        else:
            for delta in deltas:
                await emit("delta", {"text": delta})
            if chave:
                anuncios_exibidos.add(chave)
        return resposta, estado_passo

    # `max_steps` zero ou negativo desliga explicitamente o teto configurável.
    teto = max_steps if max_steps and max_steps > 0 else None
    numeros = count(1) if teto is None else range(1, teto + 1)

    for numero in numeros:
        if limite and time.monotonic() > limite:
            motivo = PARADA_TEMPO
            break

        finalizando_orcamento = bool(
            max_tool_calls and chamadas_feitas >= max_tool_calls
        )
        if finalizando_orcamento and not finalizacao_solicitada:
            historico.append(
                {
                    "role": "user",
                    "content": (
                        f"O limite de {max_tool_calls} chamadas de ferramenta foi atingido. "
                        "Não peça mais ferramentas. Resuma o que foi concluído, o que ficou "
                        "pendente e se a tarefa está completa."
                    ),
                }
            )
            finalizacao_solicitada = True

        # Projeto grande: o histórico do loop cresce a cada saída de ferramenta. Antes de
        # pedir o próximo passo, o que já foi resolvido encolhe — senão o pedido passa do
        # que o provedor aceita e a tarefa morre no meio, sem relação nenhuma com a
        # dificuldade do trabalho.
        # Headroom: antes da compactação de emergência, as saídas de ferramenta mais
        # velhas já viram um resumo com o id do original. É o que mantém o contexto
        # folgado sem esperar o provedor recusar o tamanho.
        if estado_economia.get("headroom"):
            economia.enxugar_historico(historico, estado_economia, settings)
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

        # Repara chamadas interrompidas sem remover mensagens do histórico.
        historico_ferramentas.recuperar(historico)

        # `estado` conta se o texto deste passo já saiu na tela pedaço a pedaço.
        estado = {"mostrou": False}
        try:
            catalogo_do_passo = [] if finalizando_orcamento else tools
            if retoma_anuncio_pendente:
                retoma_anuncio_pendente = False
                resultado, estado = await passo_de_retoma(
                    historico, catalogo_do_passo
                )
            else:
                resultado = await _com_tentativas(
                    modelo,
                    historico,
                    catalogo_do_passo,
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
        except BudgetExhausted:
            motivo = PARADA_PASSOS
            completou = False
            break
        except ContextoEstourado as estouro:
            # O provedor recusou o tamanho. O orçamento é estimativa; aqui ele vira o
            # limite **real**: encolhe pela metade e manda o mesmo passo de novo, em vez
            # de mostrar "context length exceeded" para quem pediu uma tarefa.
            if orcamento <= 0 or reducoes >= MAX_REDUCOES or orcamento <= MINIMO_ORCAMENTO:
                # O motivo é **código**, não frase: quem monta o texto é a interface, a
                # partir do contrato (`PARADA_*`). E este é o único motivo que não vale
                # retomar — o mesmo pedido não vai caber depois (ver `NAO_RETOMAVEL`).
                motivo = PARADA_CONTEXTO
                # Quem cortou o contexto foi o **loop**, não o modelo: com trabalho já no
                # disco, a tarefa não pode sair como falha — o relatório que fechou cada
                # item está lá, e a pessoa decide se manda continuar.
                estouro.concluido = ferramentas_ok > 0
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
        if limite and time.monotonic() > limite:
            motivo = PARADA_TEMPO
            break
        if resultado is None:
            motivo = PARADA_PROVEDOR
            break

        _somar(uso, resultado.usage)
        contexto_usado = max(
            contexto_usado, int(resultado.usage.get("prompt_tokens", 0) or 0)
        )
        # Sem texto nem chamadas, o passo não forma uma mensagem de assistente válida.
        if resultado.calls or resultado.text.strip():
            historico.append(_mensagem_assistente(resultado))

        if resultado.truncado:
            # Eco degenerado: o modelo gastou o orçamento repetindo o mesmo trecho. Empurrar a
            # continuação aqui costura o eco na resposta final — é assim que a mesma coisa
            # aparece duas vezes na tela (achado 8 do QA) com dezenas de milhares de tokens
            # (achado 11). O mecanismo vem de `DUP-repetition_guard.py` do Koda, portado em
            # `repeticao.py`; o laço não decide mais isso sozinho.
            if repeticao.dominada_por_repeticao(resultado.text):
                motivo = PARADA_LOOP_DE_TEXTO
                texto_final = repeticao.AVISO_DE_REPETICAO
                await emit("delta", {"text": f"\n\n{repeticao.AVISO_DE_REPETICAO}\n\n"})
                break
            # O provedor cortou a resposta no teto de tokens: o texto e/ou os argumentos das
            # ferramentas podem ter vindo pela metade. O aviso é explícito em vez de aceitar
            # uma chamada quebrada como se fosse válida.
            await emit(
                "delta",
                {
                    "text": "\n\n_(a resposta foi cortada no teto de tokens do modelo — "
                    "sigo do que veio completo)_\n\n"
                },
            )

        if resultado.repetiu:
            # O **raciocínio** virou laço e o provedor cortou a leitura (ver
            # `VigiaDeRepeticao`). Não é o caso do `truncado` acima: ali o modelo gastou o
            # orçamento escrevendo o eco; aqui ele não chegou a escrever — só repetiu o
            # pensamento, e o texto do passo sai vazio. Por isso este teste vem **antes** do
            # contador de respostas vazias: sem ele, um laço de raciocínio seria contado como
            # "provedor devolvendo vazio" e a rodada morreria por um motivo errado.
            alos += 1
            if alos > MAX_ALOS_DE_RACIOCINIO:
                motivo = PARADA_LOOP_DE_RACIOCINIO
                texto_final = AVISO_DE_RACIOCINIO_EM_LOOP
                await emit("delta", {"text": f"\n\n{AVISO_DE_RACIOCINIO_EM_LOOP}\n\n"})
                break
            # O alô: devolve a vez ao modelo, dizendo o que aconteceu e o que fazer agora.
            historico.append({"role": "user", "content": ALO_DE_RACIOCINIO})
            continue

        if not resultado.calls and not resultado.text.strip():
            if resultado.truncado:
                # Alguns modelos gastam o orçamento pensando e devolvem conteúdo vazio com
                # finish_reason=length. Isso não é uma conclusão: pede continuação sem
                # consumir o limite de respostas vazias.
                historico.append({"role": "user", "content": CONTINUAR_TRUNCADA})
                continue
            # Resposta vazia não é conclusão. Empurra a continuação e segue, com espera
            # progressiva para um provedor que está devolvendo vazio não gerar chamadas
            # rápidas em sequência. O usuário ainda pode cancelar a execução.
            vazias += 1
            if vazias >= MAX_VAZIAS:
                motivo = PARADA_VAZIO
                break
            espera = min(ESPERA_BASE * vazias, 30.0)
            # **A tela não pode ficar muda.** Sem este aviso, o provedor devolvendo vazio
            # significava até `MAX_VAZIAS` esperas caladas (≈12 min com o teto de 30 s), com a
            # linha de trabalho girando e nada dizendo por quê. O aviso é transitório: diz o
            # que está acontecendo, quanto falta e que o Parar interrompe.
            await _avisar_espera(
                emit,
                f"O provedor respondeu vazio — insistindo ({vazias}/{MAX_VAZIAS}) em "
                f"{espera:.0f} s. O Parar interrompe.",
                tentativa=vazias,
                total=MAX_VAZIAS,
            )
            if not await _esperar(espera, limite):
                motivo = PARADA_TEMPO
                break
            historico.append({"role": "user", "content": CONTINUAR})
            continue

        vazias = 0
        if resultado.text.strip():
            # Eco do modelo: a mesma resposta que já foi para a tela. Suprime o delta —
            # o conteúdo já está lá — e, na segunda repetição seguida, fecha a rodada com
            # o que já saiu: o modelo está preso num laço de reformular o que entregou,
            # e cada cobrança interna só rende mais uma cópia.
            eco = _mesmo_texto(resultado.text, ultima_resposta_exibida)
            if eco:
                repeticoes_da_resposta += 1
                if repeticoes_da_resposta >= 2 and not resultado.calls:
                    texto_final = ultima_resposta_exibida or resultado.text
                    completou = True
                    break
            else:
                repeticoes_da_resposta = 0
                ultima_resposta_exibida = resultado.text
            await _emitir_texto_do_passo(resultado, estado, emit, pular_texto=eco)

        # Recusa é **fechamento**, não trabalho pendente. O modelo disse que não pode
        # fazer ou revelar aquilo — cobrar uma ferramenta aqui é pedir que ele procure
        # outro jeito, e o jeito que ele encontrava era listar a pasta da pessoa. Só vale
        # para quem não executou nada ainda e não deixou comando rodando: no meio de uma
        # tarefa, um "não posso" pontual pode ser só um passo difícil.
        if (
            not resultado.calls
            and not comando_rodando
            and not bloqueios
            and ferramentas_ok == 0
            and _recusou(resultado.text)
        ):
            texto_final = resultado.text
            completou = True
            break

        if resultado.truncado and not resultado.calls:
            historico.append({"role": "user", "content": CONTINUAR_TRUNCADA})
            continue

        if finalizando_orcamento and not resultado.calls:
            pendentes = [item for item in todos if not item.get("feito")]
            texto_final = resultado.text.strip()
            completou = (
                bool(texto_final) and not pendentes and not anunciou(texto_final)
            )
            if pendentes:
                motivo = PARADA_PENDENTES
            elif not completou:
                motivo = PARADA_CHAMADAS
            break

        if not resultado.calls:
            if anunciou(resultado.text):
                chave_anuncio = _chave_de_anuncio(resultado.text)
                if chave_anuncio:
                    anuncios_exibidos.add(chave_anuncio)
            # O anúncio não passa por trabalho feito, em **qualquer** rodada de trabalho:
            # depende de haver catálogo (`tools`) e de a rodada ser de código — não do que o
            # modelo escreveu nem de já ter rodado algo antes. Exigir `ferramentas_ok` aqui
            # era o furo: o primeiro anúncio de quem **ainda não executou nada** era o caso
            # mais comum, e era justamente o que encerrava a tarefa.
            #
            # A exceção é a régua única: resposta que **já entregou** dado desenhável
            # (quiz/tabela/gráfico em bloco koda-*) fecha a rodada mesmo carregando uma
            # frase de futuro — o que foi pedido está na tela, e cutucar ferramenta aí
            # fazia o modelo listar a pasta do projeto e oferecer "mais uma rodada"
            # (visto em 16/10/2026).
            if (
                (anunciou(resultado.text) or comando_rodando)
                and (modo == MODO_CODIGO or bool(comando_rodando))
                and not entregou_visual
                and not bloqueios
                and tools
                and retomadas_anuncio < MAX_RETOMADAS_ANUNCIO
            ):
                retomadas_anuncio += 1
                if comando_rodando:
                    historico.append(
                        {"role": "user", "content": acompanhar_comando(comando_rodando)}
                    )
                else:
                    ultimo_anuncio = resultado.text
                    historico.append(
                        {
                            "role": "user",
                            "content": (
                                f"O seu anúncio foi: “{ultimo_anuncio.strip()[:300]}”. "
                                + RETOMAR_ANUNCIO
                            ),
                        }
                    )
                retoma_anuncio_pendente = True
                continue

        if resultado.truncado and not resultado.calls:
            historico.append({"role": "user", "content": CONTINUAR_TRUNCADA})
            continue

        if resultado.calls:
            # Cada passo com chamada nova mostra que o modelo voltou a agir. As retomadas
            # futuras começam com orçamento próprio, sem limitar tarefas longas legítimas.
            retomadas_anuncio = 0

        if not resultado.calls:
            # Resposta de texto: **candidata** a fechamento. Antes de aceitar, uma única
            # régua decide se ainda há trabalho de verdade: item do plano em aberto,
            # comando rodando sem serem encerrados, dado desenhável que precisa voltar em
            # bloco, ou anúncio de passo sem execução. O sinal é de **estado** — o que
            # ficou em aberto, o que ainda está rodando — e nunca de vocabulário.
            #
            # Nada aqui perde a resposta: o texto já saiu na tela e é ele que fica
            # guardado. A régua só decide se a rodada fecha de vez (`fechou_limpo`) ou se
            # o loop cutuca o modelo com **uma** mensagem interna — nunca uma sequência
            # de portões empilhados, que era o que fazia a IA continuar depois de entregar.
            pendentes = [item for item in todos if not item.get("feito")]

            # O botão Retomar só aparece para uma tarefa interrompida. Se o pedido
            # original era de ação e esta nova rodada ainda não executou ferramenta,
            # texto como "blocos 7–17 lidos" não é prova de progresso. A compactação
            # pode ter removido as chamadas antigas da janela viva; peça a próxima
            # chamada real antes de aceitar o encerramento.
            if retomada and de_acao and tools and ferramentas_ok == 0 and not bloqueios:
                if cobrancas_retomada < 2:
                    cobrancas_retomada += 1
                    historico.append({
                        "role": "user",
                        "content": (
                            "Esta é uma retomada de tarefa interrompida. Nesta rodada você "
                            "ainda não executou ferramenta nenhuma: não afirme que leu, "
                            "alterou ou verificou novos itens. Use o checkpoint da retomada "
                            "e chame agora a próxima ferramenta necessária com argumentos "
                            "completos. Só relate progresso depois do resultado real."
                        ),
                    })
                    continue
                motivo = PARADA_CHAMADAS
                texto_final = resultado.text
                completou = False
                break

            # A régua de tudo: resposta limpa fecha a rodada. Só há trabalho a cutucar
            # quando o estado mostra que sobrou algo (itens do plano em aberto, comando
            # ainda rodando) ou quando o texto é anúncio/promessa do que **ia** fazer —
            # quem já entregou não é cutucado, mesmo que a rodada não tenha chamado
            # ferramenta nenhuma. É o caso do quiz/tabela/gráfico entregue pela interface:
            # a entrega é o fim do turno, não um passo no meio.
            entregou_visual = entregou_visual or bool(ENTREGOU_VISUAL.search(resultado.text)) or cartao_plano
            if planejar and (cartao_plano or BLOCO_PLANO.search(resultado.text) or
                    ('"tipo"' in resultado.text and '"plano"' in resultado.text)):
                texto_final = resultado.text
                completou = False
                motivo = PARADA_AGUARDANDO_ACEITE
                break
            bloco_que_falta = None if entregou_visual else _bloco_perdido(resultado.text)
            sem_entrega = (de_acao and tools and not planejar and not entregou_visual
                           and (not ferramentas_ok or (requires_effect(pedido_original) and not efeitos_ok)))
            # Em Plan, tarefa de ação grande **entrega o cartão**: um plano em prosa não
            # fecha a rodada limpa, senão o portão abaixo nunca roda e a pessoa fica sem
            # os botões Desistir/Fazer (visto em 05/11/2026).
            falta_cartao = (
                planejar and grande and de_acao and not aceito
                and not cartao_plano
                and not BLOCO_PLANO.search(resultado.text)
            )
            fechou_limpo = (
                not pendentes
                and not comando_rodando
                and not bloco_que_falta
                and not (modo == MODO_CODIGO and anunciou(resultado.text) and not entregou_visual)
                and not sem_entrega
                and not falta_cartao
            )
            if ferramentas_ok > retomada_base:
                retomada_base = ferramentas_ok
                retomadas = 0
                cobrancas = 0
            if fechou_limpo:
                texto_final = resultado.text
                completou = True
                break

            # PORTÃO DO PLANO (fechamento por texto): o plano está apresentado e a
            # pessoa ainda não disse sim. A rodada **fecha aqui** — pendência de plano
            # esperando aceite não é item esquecido a retomar, e a cobrança abaixo não
            # pode empurrar o modelo a "continuar" por conta própria.
            #
            # Só no modo Plan (`planejar`): no Auto/Livre/Padrão/Manual o portão não
            # existe, e a rodada segue a régua normal — se sobrou item na lista, o
            # `retomar_tarefa` abaixo faz o modelo **executar** em vez de esperar.
            # Vale também quando a tarefa é grande e o modelo **não** chamou
            # `update_todos`: em Plan, a entrega é o cartão, e um plano em prosa deixa a
            # pessoa sem os botões. O cartão é o contrato do modo, não um extra de quem
            # lembrou de registrar a lista.
            if planejar and (grande or (todos and plano_feito)) and not aceito:
                if cartao_plano or BLOCO_PLANO.search(resultado.text):
                    texto_final = resultado.text
                    completou = False
                    motivo = PARADA_AGUARDANDO_ACEITE
                    break
                # O plano fechou em prosa: sem o bloco não há cartão, e sem cartão a
                # pessoa não tem como aprovar. Cobra o bloco antes de fechar — a mesma
                # cobrança do passo com ferramenta, agora no fechamento por texto.
                if cobrancas_plano < MAX_COBRANCAS:
                    cobrancas_plano += 1
                    historico.append({"role": "user", "content": EXIGIR_BLOCO_PLANO})
                    continue
                texto_final = resultado.text
                completou = False
                motivo = PARADA_AGUARDANDO_ACEITE
                break

            # **Uma** cobrança por resposta, na ordem do estado: o que o próprio modelo
            # registrou que faltava, o dado desenhável que precisa voltar em bloco, o
            # trabalho alterado sem conferência e, por último, a ação em que nenhuma
            # ferramenta funcionou. Cada uma escreve a sua mensagem interna e segue; a
            # régua do topo decide sozinha, no passo seguinte, se ainda há o que cutucar.
            if pendentes and retomadas < MAX_RETOMADAS:
                retomadas += 1
                historico.append({"role": "user", "content": retomar_tarefa(pendentes)})
                continue
            if bloco_que_falta and cobrancas_bloco < MAX_COBRANCAS:
                cobrancas_bloco += 1
                historico.append({"role": "user", "content": bloco_que_falta})
                continue
            if sem_entrega and not bloqueios and cobrancas < MAX_COBRANCAS:
                cobrancas += 1
                historico.append({"role": "user", "content": CONSERTAR_FERRAMENTA})
                continue

            # Nada mais a cobrar: a rodada fecha com **o que o modelo escreveu**. O loop
            # não inventa fechamento — o que faltou vira contrato estruturado (`motivo`
            # com um código + `pendentes`), e é a interface que monta o cartão de tarefa
            # não concluída. Era aqui que a resposta virava "me diga continue": instrução
            # de uso de produto no lugar da resposta do modelo.
            texto_final = resultado.text
            completou = True
            if sem_entrega:
                completou = False
                motivo = PARADA_CHAMADAS
            elif pendentes:
                completou = False
                motivo = PARADA_PENDENTES
            elif modo == MODO_CODIGO and anunciou(resultado.text):
                completou = False
                motivo = PARADA_ANUNCIO
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
                    # Metadados de reconstrução da chamada. O roteador os consome antes
                    # de enviar o evento à interface, para que um cancelamento do stream
                    # ainda possa salvar o passo completo sem expor estado opaco ao cliente.
                    "_raw_arguments": chamada.raw_arguments,
                    "_provider_extra": chamada.extra,
                },
            )

            if ((max_tool_calls and chamadas_feitas >= max_tool_calls)
                    or not current_budget.get().claim_tool()):
                chamadas_feitas = max_tool_calls or 1000
                saida = (
                    f"ERRO: o orçamento de {max_tool_calls} chamadas de ferramenta foi "
                    "atingido. Não tente outra ferramenta; finalize com o que já foi feito."
                )
                passos.append(
                    ToolStep(
                        name=chamada.name,
                        arguments=argumentos,
                        raw_arguments=chamada.raw_arguments,
                        output=saida,
                        duration_ms=0,
                        call_id=chamada.id,
                        extra=chamada.extra,
                        ok=False,
                    )
                )
                await emit(
                    "tool_result",
                    {
                        "id": chamada.id,
                        "name": chamada.name,
                        "output": saida,
                        "duration_ms": 0,
                        "ok": False,
                        "step": numero,
                    },
                )
                historico.append(
                    {"role": "tool", "tool_call_id": chamada.id, "content": saida}
                )
                continue

            chamadas_feitas += 1

            # Argumento que não é JSON válido **não** roda: o erro volta explícito para o
            # modelo reenviar, em vez de a ferramenta executar com `{}` e devolver um erro
            # de argumento vazio que não explica nada.
            problema_de_json = (_argumentos_invalidos(chamada)
                                or validacao_ferramentas.erro(chamada.name, argumentos, tools))
            if problema_de_json is not None:
                passos.append(
                    ToolStep(
                        name=chamada.name,
                        arguments=argumentos,
                        raw_arguments=chamada.raw_arguments,
                        output=problema_de_json,
                        duration_ms=0,
                        call_id=chamada.id,
                        extra=chamada.extra,
                        ok=False,
                    )
                )
                await emit(
                    "tool_result",
                    {
                        "id": chamada.id,
                        "name": chamada.name,
                        "output": problema_de_json,
                        "duration_ms": 0,
                        "ok": False,
                        "step": numero,
                    },
                )
                historico.append(
                    {"role": "tool", "tool_call_id": chamada.id, "content": problema_de_json}
                )
                continue

            # A porteira do despacho (porta do Koda — ver `guards.py`): o que a rodada
            # **não ofereceu**, não roda. Vem antes do cartão de permissão de propósito —
            # não faz sentido pedir autorização para uma ferramenta que a própria pessoa
            # proibiu. Fail-closed: sem nome, guarda quebrada ou comparação que estoure
            # terminam em recusa.
            recusa = guarda.nega(chamada.name)
            if recusa is not None:
                bloqueios += 1
                passos.append(
                    ToolStep(
                        name=chamada.name,
                        arguments=argumentos,
                        raw_arguments=chamada.raw_arguments,
                        output=recusa,
                        duration_ms=0,
                        call_id=chamada.id,
                        extra=chamada.extra,
                        ok=False,
                    )
                )
                await emit(
                    "tool_result",
                    {
                        "id": chamada.id,
                        "name": chamada.name,
                        "output": recusa,
                        "duration_ms": 0,
                        "ok": False,
                        "step": numero,
                        "negado": True,
                    },
                )
                historico.append(
                    {"role": "tool", "tool_call_id": chamada.id, "content": recusa}
                )
                continue

            continua_comando = chamada.name in ("shell", "terminal") and bool(
                argumentos.get("continuar")
            )
            chave_repeticao = _chave_de_repeticao(
                chamada.name, argumentos, pedido_original, todos
            )
            if continua_comando:
                repeticao_atual = 1
            else:
                repeticao_atual = repeticoes.get(chave_repeticao, 0) + 1
                repeticoes[chave_repeticao] = repeticao_atual

            if repeticao_atual >= 3:
                encerrada = repeticao_atual >= 4
                saida = (
                    "ERRO: esta mesma chamada já foi repetida no mesmo pedido e plano. "
                    "Não a execute de novo: use os resultados anteriores e mude a estratégia."
                    if not encerrada
                    else "ERRO: a chamada foi repetida novamente mesmo após o aviso. "
                    "Interrompi o ciclo para evitar repetir o mesmo trabalho."
                )
                passo = ToolStep(
                    name=chamada.name,
                    arguments=argumentos,
                    raw_arguments=chamada.raw_arguments,
                    output=saida,
                    duration_ms=0,
                    call_id=chamada.id,
                    extra=chamada.extra,
                    ok=False,
                )
                passos.append(passo)
                await emit(
                    "tool_result",
                    {
                        "id": chamada.id,
                        "name": chamada.name,
                        "output": saida,
                        "duration_ms": 0,
                        "ok": False,
                        "step": numero,
                    },
                )
                historico.append(
                    {"role": "tool", "tool_call_id": chamada.id, "content": saida}
                )
                if encerrada:
                    repeticao_terminal = True
                continue

            if repeticao_terminal:
                saida = (
                    "ERRO: o ciclo foi interrompido por repetição persistente; "
                    "esta chamada do lote não foi executada."
                )
                passos.append(
                    ToolStep(
                        name=chamada.name,
                        arguments=argumentos,
                        raw_arguments=chamada.raw_arguments,
                        output=saida,
                        duration_ms=0,
                        call_id=chamada.id,
                        extra=chamada.extra,
                        ok=False,
                    )
                )
                await emit(
                    "tool_result",
                    {
                        "id": chamada.id,
                        "name": chamada.name,
                        "output": saida,
                        "duration_ms": 0,
                        "ok": False,
                        "step": numero,
                    },
                )
                historico.append(
                    {"role": "tool", "tool_call_id": chamada.id, "content": saida}
                )
                continue

            # O plano é a única ferramenta cujo **conteúdo** a interface precisa ver: a
            # lista vai como evento próprio, em vez de ficar escondida num resultado de
            # ferramenta que a pessoa teria de abrir para ler.
            if chamada.name == ferramentas.FERRAMENTA_DO_PLANO:
                itens = ferramentas.todos_dos_argumentos(argumentos)
                if itens:
                    todos = itens
                    plano_feito = True
                    await emit("todos", {"todos": itens, "step": numero})

            # O cartão de plano é a interface inteligente do Koda: o modelo manda os dados
            # e a tela desenha. Vale em **todos** os provedores e em todos os modos — é o
            # caminho que não depende de o modelo acertar a cerca ```koda-plano```.
            if chamada.name == ferramentas.FERRAMENTA_DO_CARTAO:
                dados_do_cartao = ferramentas.dados_do_cartao(argumentos)
                if dados_do_cartao is not None:
                    cartao_plano = True
                    plano_feito = True
                    await emit("plano", {"dados": dados_do_cartao, "step": numero})

            # A interface inteligente (Koda UI): o modelo manda o documento, o servidor
            # valida e a tela desenha. A validação é a mesma que o handler faz; aqui ela
            # serve para **não** emitir documento inválido — o erro volta ao modelo como
            # resultado da ferramenta, e ele corrige na chamada seguinte.
            if chamada.name == ferramentas.FERRAMENTA_DA_INTERFACE:
                try:
                    documento_ui, _avisos_ui = ui_documento.validar(argumentos, run_id=dono)
                except ui_documento.DocumentoInvalido:
                    documento_ui = None
                if documento_ui is not None:
                    await emit("ui", {"documento": documento_ui, "step": numero})
                    entregou_visual = True

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
                decisao = await aprovar({**acao, "tool_call_id": chamada.id})
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
                        raw_arguments=chamada.raw_arguments,
                        output=saida,
                        duration_ms=0,
                        call_id=chamada.id,
                        extra=chamada.extra,
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
            prazo_tool = tool_call_timeout_s
            if chamada.name in ("shell", "terminal") and not argumentos.get("parar"):
                # O shell tem um ciclo próprio de acompanhamento: não devolva a palavra
                # antes da olhada configurada (240 s / 4 min por padrão), mesmo que o
                # timeout genérico das outras ferramentas seja menor.
                prazo_olhada = float(LIMITES.intervalo_olhada)
                prazo_tool = max(prazo_tool or 0.0, prazo_olhada)
            restante_tarefa = _faltando(limite)
            if restante_tarefa is not None:
                prazo_tool = (
                    restante_tarefa
                    if prazo_tool is None
                    else min(prazo_tool, restante_tarefa)
                )
            if negado_por_codigo and oportunidade is not None:
                saida = aviso_de_ferramenta(oportunidade)
            elif planejar and _muda_algo(chamada.name, argumentos, workspace):
                # Modo **Plan**: a ferramenta que MUDA algo não roda — só a de leitura
                # passa. É o que faz o modo ser "planeje e pare" de verdade, e não "planeje
                # e faça igual": o modelo lê o projeto à vontade, monta o plano e para.
                #
                # O critério é o mesmo do cartão de permissão (`ferramentas.classificar`
                # devolver algo = muda o disco ou roda comando). Reusar essa régua é o que
                # mantém as duas coisas de acordo — não há uma segunda lista para sair de
                # sincronia quando uma ferramenta nova entra.
                saida = (
                    "PLANO: você está no modo Plan, então esta ferramenta NÃO foi executada "
                    f"(`{chamada.name}`). Nada foi alterado. Registre o que pretendia fazer "
                    "com `update_todos`, explique o plano em poucas linhas e encerre — quem "
                    "decide seguir é a pessoa."
                )
            elif chamada.name == subagente.FERRAMENTA:
                # O sub-agente roda **aqui**, e não pelo despacho: quem sabe rodá-lo é o laço
                # (`agent`), e `tools` não pode importar `agent` — seria import para cima.
                # Daqui para baixo o caminho é o de sempre: a duração, o passo, o evento e o
                # histórico tratam esta saída como tratam a de qualquer ferramenta.
                if sub_agentes_lancados >= subagente.POR_RODADA:
                    saida = (
                        f"ERRO: o teto de {subagente.POR_RODADA} sub-agentes por rodada já foi "
                        "atingido. Faça o que falta você mesmo, ou finalize esta rodada e "
                        "lance os outros na próxima."
                    )
                else:
                    sub_agentes_lancados += 1
                    saida = await subagente.executar(
                        # `modelo` é o provedor **deste** laço. Chamá-lo de `engine` aqui
                        # era um nome que não existe nesta função — e o erro só aparece
                        # quando a linha roda, não ao compilar.
                        modelo,
                        settings or get_settings(),
                        nome=str(argumentos.get("agente", "")),
                        tarefa=str(argumentos.get("tarefa", "")),
                        workspace=workspace,
                        esforco=str(argumentos.get("esforco") or "") or None,
                        modelo=str(argumentos.get("modelo") or "") or None,
                        fora_da_pasta=bool(argumentos.get("fora_da_pasta")),
                        # O modo do app vale para o sub-agente também: ele pergunta o que o
                        # principal perguntaria — e nunca pede para apagar (ver o veto).
                        aprovar=aprovar,
                        # O que ele narra sai como evento `sub`, endereçado ao id desta
                        # chamada: é assim que a área Subs abre uma aba por sub-agente.
                        emit=emit_bruto,
                        chamada=chamada.id,
                        dono=dono,
                        cancelamento=cancelamento,
                    )
            else:
                try:
                    saida = await asyncio.to_thread(
                        ferramentas.executar,
                        chamada.name,
                        argumentos,
                        workspace,
                        negadas,
                        acesso_livre=liberado,
                        dono=dono,
                        anexos=anexos,
                        skills=skills,
                        timeout_s=prazo_tool,
                        cancelamento=cancelamento,
                        # O id da chamada vai junto para o registro de mudanças: é ele que
                        # deixa o cartão desta ferramenta mostrar, na conversa, o diff que
                        # **esta** chamada fez — e não o acumulado do arquivo.
                        chamada=chamada.id,
                    )
                except TimeoutError:
                    saida = (
                        "ERRO: a ferramenta excedeu o tempo limite de "
                        f"{prazo_tool:g}s. Escolha outra abordagem e continue."
                        if prazo_tool
                        else "ERRO: a ferramenta atingiu um timeout. Escolha outra abordagem e continue."
                    )
                except Exception as exc:  # noqa: BLE001 — falha da tool volta ao modelo
                    saida = (
                        f"ERRO: a ferramenta {chamada.name} falhou: "
                        f"{type(exc).__name__}: {exc}"
                    )
            # A transferência para o celular viaja num evento próprio: o id do arquivo
            # não entra no texto que a tela e o modelo veem.
            transferencia = None
            if chamada.name == "send_to_phone":
                saida, transferencia = ferramentas.separar_transferencia(saida)
            duracao = int((time.perf_counter() - inicio) * 1000)
            current_budget.get().record_output(saida)
            executada = not negado_por_codigo and not (
                planejar and _muda_algo(chamada.name, argumentos, workspace)
            )
            codigo_saida = EXIT_CODE.search(saida)
            tool_result = ToolResult(output=saida, executed=executada,
                status="blocked" if not executada else ("success" if saida_ok(saida, chamada.name) else "failed"),
                exit_code=int(codigo_saida[1]) if codigo_saida else None)
            ok = tool_result.ok
            if ok:
                if acao is not None:
                    efeitos_ok += 1
                if chamada.name != ferramentas.FERRAMENTA_DO_PLANO:
                    # Houve progresso real: a mesma frase pode voltar a ser relevante
                    # depois de lermos/editarmos algo novo.
                    anuncios_exibidos.clear()
                # O plano **não** conta como trabalho feito: quem só registrou a lista ainda
                # não mudou nada no disco, e é isso que as cobranças abaixo medem.
                if chamada.name != ferramentas.FERRAMENTA_DO_PLANO:
                    ferramentas_ok += 1
                if chamada.name in FERRAMENTAS_QUE_MEXEM:
                    caminhos = mudancas.caminhos_da_chamada(chamada.id) or [_caminho_da_chamada(argumentos)]
                    for caminho in caminhos:
                        if caminho and caminho not in mudados:
                            mudados.append(caminho)
                if chamada.name not in SO_LEITURA and not continua_comando:
                    # Outra ação bem-sucedida pode mudar o estado que uma leitura verá.
                    # Preserve o contador desta assinatura para ainda detectar a própria
                    # ação se o modelo tentar executá-la de novo.
                    repeticoes.clear()
                    repeticoes[chave_repeticao] = repeticao_atual
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
                raw_arguments=chamada.raw_arguments,
                output=saida,
                duration_ms=duracao,
                call_id=chamada.id,
                extra=chamada.extra,
                ok=ok,
                executed=tool_result.executed,
                status=tool_result.status,
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
                    "executed": tool_result.executed,
                    "status": tool_result.status,
                    "step": numero,
                },
            )
            if transferencia is not None:
                await emit("transfer", transferencia)
            # A tela recebe `saida` inteira; o **modelo** recebe o que a economia deixar.
            # A compressão acontece só aqui, no ponto em que o resultado entra no
            # histórico — o passo, o evento SSE e o que fica gravado continuam completos.
            saida_para_o_modelo = economia.comprimir_saida(
                saida, chamada.name, estado_economia, settings
            )
            historico.append(_resultado_de_ferramenta(chamada.id, saida_para_o_modelo))

        # PORTÃO DO PLANO (passo com ferramenta): o plano foi registrado e a pessoa ainda
        # não aceitou — nada mais roda nesta rodada. Se o texto do passo já trouxe o
        # bloco `koda-plano`, o cartão está na tela e basta parar; se não trouxe, o loop
        # cobra o bloco (EXIGIR_BLOCO_PLANO) uma vez antes de fechar, para a interface
        # interativa aparecer em vez de um plano em prosa.
        #
        # **Só no modo Plan.** Fora dele, registrar a lista não é pedido de licença: é o
        # agente organizando o próprio trabalho, e o turno continua até entregar.
        if planejar and (grande or (todos and plano_feito)) and not aceito:
            if cartao_plano or BLOCO_PLANO.search(resultado.text):
                texto_final = resultado.text
                completou = False
                motivo = PARADA_AGUARDANDO_ACEITE
                break
            if cobrancas_plano < MAX_COBRANCAS:
                cobrancas_plano += 1
                historico.append({"role": "user", "content": EXIGIR_BLOCO_PLANO})
                continue
            texto_final = resultado.text
            completou = False
            motivo = PARADA_AGUARDANDO_ACEITE
            break

        if limite and time.monotonic() > limite:
            motivo = PARADA_TEMPO
            completou = False
            break

        if repeticao_terminal:
            motivo = PARADA_REPETICAO
            completou = False
            break

        if finalizando_orcamento:
            motivo = PARADA_CHAMADAS
            texto_final = resultado.text.strip()
            completou = False
            break

        if resultado.truncado:
            # Executa apenas as chamadas completas recebidas e depois retoma do modelo.
            # Se algum JSON foi cortado, o erro da ferramenta já está no histórico para
            # que o modelo possa reenviar a chamada completa sem repetir o lote concluído.
            historico.append({"role": "user", "content": CONTINUAR_TRUNCADA})
            continue

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
        # continuar. Só enquanto o orçamento de cobranças durar — da segunda em diante,
        # insistir só toma o tempo.
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
        # A rodada acabou no meio (teto de passos, tempo esgotado, provedor mudo) e o
        # modelo não escreveu um fechamento. O que entra é o **aviso de falha** do projeto
        # de origem — nunca uma instrução de uso ("me diga continue"): o texto do loop
        # descrevia o produto para quem estava usando o produto.
        #
        # Esperar o aceite **não é falha**: o cartão do plano é a entrega, e o aviso de
        # «parte das ações pode ter sido executada» embaixo dele assusta sem motivo.
        if motivo != PARADA_AGUARDANDO_ACEITE:
            if not motivo:
                motivo = PARADA_PASSOS if teto is not None else PARADA_PROVEDOR
            texto_final = _aviso_de_fechamento(ferramentas_ok, "")

    # Última barreira antes de entregar: nenhuma resposta sai com o eco do modelo dentro. Vale
    # para qualquer caminho que tenha preenchido `texto_final` — o aviso é melhor do que
    # 30 mil caracteres repetidos na tela.
    if texto_final:
        # O eco de resposta (a mesma lista repetida com frases diferentes entre as cópias)
        # não é "descontrolada" pela régua antiga: ela exige uma corrida periódica
        # contígua. Aqui a primeira cópia fica e o resto sai.
        corte_eco = repeticao.eco_de_resposta(texto_final)
        if corte_eco is not None:
            texto_final = texto_final[:corte_eco].rstrip()
        elif repeticao.descontrolada(texto_final):
            texto_final = repeticao.AVISO_DE_REPETICAO
            motivo = motivo or PARADA_LOOP_DE_TEXTO

    # O que é de servidor MCP ganha o endereço de origem **aqui**, num lugar só: a interface
    # mostra o nome real do servidor e da ferramenta, e o que fica gravado na mensagem é o
    # mesmo que a tela viu — reabrir a conversa mostra o servidor, e não o nome normalizado
    # (`eco_server`) que não existe no `mcps.json`.
    for passo in passos:
        if passo.mcp is None:
            passo.mcp = mcp.detalhar(passo.name)

    verification = await asyncio.to_thread(verificar_arquivos, workspace, mudados, passos)
    if (verification["errors"] or verification["unverified"]) and completou:
        completou = False
        motivo = "verification_failed"
        warning = "\n\nA conferência local ficou incompleta: " + (
            "; ".join(verification["errors"]) or "há arquivos acima do limite de leitura")
        texto_final += warning
        await emit("delta", {"text": warning})
    return Resultado(
        texto=texto_final,
        passos=passos,
        completou=completou,
        uso=uso,
        contexto=contexto_usado,
        motivo=motivo,
        todos=todos,
        pendentes=_pendencias(todos) if not completou else [],
        executou=ferramentas_ok,
        verification=verification,
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
    if resultado.reasoning_content is not None:
        mensagem["reasoning_content"] = resultado.reasoning_content
    if resultado.calls:
        mensagem["tool_calls"] = [chamada.para_mensagem() for chamada in resultado.calls]
    return mensagem


def _muda_algo(nome: str, argumentos: dict[str, Any], workspace: Path) -> bool:
    """Esta chamada altera algo no disco ou roda comando?

    A régua é a do cartão de permissão: `ferramentas.classificar` devolve uma descrição
    quando a chamada **faz** algo, e `None` quando ela só lê (buscar arquivo, ler página,
    procurar no código). Reusar a mesma função é o que mantém o modo Plan e o cartão de
    acordo — uma lista própria aqui sairia de sincronia na primeira ferramenta nova.

    Na dúvida (falha ao classificar), responde `True`: no modo Plan o erro seguro é **não
    executar**.
    """
    if registry.canonico(nome) in {"shell", "terminal", "code_interpreter", "sub_agente"}:
        return True
    try:
        return ferramentas.classificar(nome, argumentos, workspace) is not None
    except Exception:  # noqa: BLE001 — classificar não deveria levantar; se levantar, não executa
        return True


def _resultado_de_ferramenta(call_id: str, saida: str) -> dict[str, Any]:
    """A mensagem `tool` do histórico — com as imagens que a ferramenta devolveu.

    Um MCP pode entregar imagem (o de vídeo entrega cada quadro do vídeo analisado). Ela
    chega marcada no texto, e aqui vira parte `image_url` de verdade: é o que faz o modelo
    **ver** o quadro, em vez de ler o caminho de um JPG que ele não consegue abrir.

    Sem imagem o resultado é exatamente o de antes — uma string. Com imagem, o `content`
    passa a ser a lista `[texto, image_url, …]`, que é o formato que o provedor já aceita
    para visão (o mesmo do turno do usuário com foto anexada).
    """
    texto, imagens = mcp.separar_imagens(saida)
    if not imagens:
        return {"role": "tool", "tool_call_id": call_id, "content": saida}
    conteudo: list[dict[str, Any]] = [{"type": "text", "text": texto}]
    conteudo.extend({"type": "image_url", "image_url": {"url": url}} for url in imagens)
    return {"role": "tool", "tool_call_id": call_id, "content": conteudo}


def _chave_de_anuncio(texto: str) -> str:
    """Normaliza espaço e caixa para reconhecer o mesmo anúncio em uma retomada."""
    return re.sub(r"\s+", " ", texto).strip().casefold()


def _mesmo_texto(a: str, b: str | None) -> bool:
    """Dois textos do modelo são a **mesma resposta**?

    Compara sem espaço, caixa nem pontuação de fim: o provedor reenviando a resposta
    depois de uma cobrança chega com pequenas diferenças de formatação, e o que importa
    é o conteúdo. `b` vazio nunca repete.
    """
    if not b:
        return False
    limpo = lambda t: re.sub(r"[\s\W_]+", "", t, flags=re.UNICODE).lower()  # noqa: E731
    fa, fb = limpo(a), limpo(b)
    if not fa or not fb:
        return False
    # Igual por inteiro, ou o novo texto começa com o anterior (modelo repetindo a
    # resposta com um acréscimo mínimo — o conteúdo já está na tela).
    return fa == fb or (len(fa) > len(fb) and fa.startswith(fb)) or (
        len(fb) > len(fa) and fb.startswith(fa)
    )


async def _emitir_texto_do_passo(
    resultado: StepResult,
    estado: dict[str, bool],
    emit: Emit,
    pular_texto: bool = False,
) -> None:
    """Publica o texto agregado só se ele ainda não saiu pelo stream.

    `pular_texto` suprime até o corpo: o passo repetiu uma resposta que já foi para a
    tela (ver `_mesmo_texto`) — só o separador entre passos interessa, se houver.
    """
    sufixo = "\n\n" if resultado.calls else ""
    if pular_texto:
        if sufixo:
            await emit("delta", {"text": sufixo})
        return
    if not resultado.text.strip():
        return
    if estado["mostrou"]:
        # O texto já saiu pedaço a pedaço durante o passo: repetir aqui duplicaria tudo.
        if sufixo:
            await emit("delta", {"text": sufixo})
    else:
        await emit("delta", {"text": resultado.text + sufixo})


async def _esperar(segundos: float, limite: float | None) -> bool:
    """Dorme respeitando o que resta do orçamento da tarefa; `False` se já acabou."""
    restante = _faltando(limite)
    if restante is not None and restante <= 0:
        return False
    await asyncio.sleep(segundos if restante is None else min(segundos, restante))
    return True


async def _avisar_espera(
    emit: Emit, texto: str, tentativa: int | None = None, total: int | None = None
) -> None:
    """Diz na tela que a rodada está **esperando** — a tela nunca fica muda.

    Vai como evento próprio (`aviso`), e **não** como `delta`: é estado da rodada, não fala
    do modelo. Um `delta` entraria no texto gravado da mensagem, e uma espera de doze minutos
    encheria a resposta de linhas de progresso. O `aviso` aparece enquanto dura e sai de cena
    quando a rodada segue.

    `tentativa`/`total` são o contador da insistência — qual das quantas. Quando vêm, o app
    acende a linha «Reconectando… NN/NN` com esses números (regra do dono: a linha vale para
    **qualquer** erro, inclusive a insistência daqui). O `texto` fica para quem lê o SSE cru.
    """
    dados: dict[str, Any] = {"text": texto}
    if tentativa is not None:
        dados["tentativa"] = tentativa
        dados["total"] = total if total is not None else tentativa
    await emit("aviso", dados)


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
) -> StepResult | None:
    """Roda um passo narrando o texto conforme ele é escrito.

    Quando o provedor sabe streamar com ferramentas (`step_streaming`), o texto do passo
    sai na tela enquanto o modelo escreve — antes isso só existia no `step()`, que é
    `stream: false` e devolvia o passo inteiro num delta só. Sem `step_streaming` cai no
    `step()` de sempre.

    `estado["mostrou"]` vira `True` na primeira vez que sai texto: quem chama usa isso para
    não repetir um passo que já apareceu na tela.

    O catálogo completo é passado ao modelo; a seleção fica por conta dele.
    """
    budget = current_budget.get()
    if budget is not None:
        budget.claim_model()
    historico = [mensagem for mensagem in historico if mensagem.get("role") not in ("system", "developer")]
    streamar = getattr(modelo, "step_streaming", None)
    if streamar is None:
        result = await modelo.step(historico, tools, model)
        if result is not None:
            limpo, chamadas = dsml.extrair(result.text)
            result.text = limpo
            if chamadas and not result.calls:
                result.calls = chamadas
            if budget is not None:
                budget.record_output(result.text)
            # Provedor sem stream: o texto inteiro chega de uma vez, e não há delta para
            # interromper depois. O eco é cortado **antes** de sair, senão a tela recebe
            # as três cópias e só o banco ficaria certo.
            corte_eco = repeticao.eco_de_resposta(result.text)
            if corte_eco is not None:
                result.text = result.text[:corte_eco].rstrip()
        return result

    resultado: StepResult | None = None
    texto: list[str] = []
    filtro = dsml.FiltroDsml()
    # O eco de resposta inteira é cortado **durante** o stream: quando a mesma lista
    # reaparece, a tela para na primeira cópia em vez de esperar o modelo terminar a
    # terceira. O `StepResult` do provedor não vem depois do `break`, então o passo
    # devolve o texto já cortado.
    vigia_eco = repeticao.VigiaDeEco()
    eco_cortado = False
    async for item in streamar(historico, tools, model, reasoning, effort):
        if isinstance(item, StepResult):
            resultado = item
            continue
        if budget is not None:
            budget.record_output(item.text)
        if item.reasoning:
            # Raciocínio não é resposta: vai para a tela, mas não conta como "mostrou".
            await emit("reasoning", {"text": item.text})
            continue
        if not item.text:
            continue
        # O filtro segura o pedaço que ainda pode ser um marcador DSML (a chamada que
        # alguns modelos devolvem como texto) e libera o resto na hora. Sem ele, o
        # `<｜DSML｜function_calls` aparecia na fala e ficava gravado na conversa.
        seguro = filtro.alimentar(item.text)
        if not seguro:
            continue
        acumulado = "".join(texto)
        corte = vigia_eco.alimentar(seguro)
        if corte is not None:
            # `corte` é o começo da segunda cópia. O que veio antes dele fica; o eco, não.
            if corte > len(acumulado):
                await emit("delta", {"text": (acumulado + seguro)[len(acumulado):corte]})
            texto = [(acumulado + seguro)[:corte]]
            estado["mostrou"] = True
            eco_cortado = True
            break
        # Cada pedaço sai na tela assim que chega. Se a rede cair no meio, o pedaço que já
        # apareceu **não** é repetido: `_com_tentativas` vê `mostrou` e avisa em vez de
        # reenviar o passo — a alternativa era segurar tudo e perder o streaming.
        texto.append(seguro)
        estado["mostrou"] = True
        await emit("delta", {"text": seguro})
    if eco_cortado:
        return StepResult(text="".join(texto))
    resto = filtro.finalizar()
    if resto:
        texto.append(resto)
        estado["mostrou"] = True
        await emit("delta", {"text": resto})
    if resultado is not None:
        limpo, chamadas = dsml.extrair(resultado.text)
        resultado.text = limpo
        if chamadas and not resultado.calls:
            resultado.calls = chamadas
    if resultado is not None and resultado.text:
        inteiro = "".join(texto)
        if not inteiro:
            # Provedor que só devolve o texto no `StepResult` (sem pedaços de texto).
            # O eco é cortado antes de sair: não há stream para interromper depois.
            corte_eco = repeticao.eco_de_resposta(resultado.text)
            if corte_eco is not None:
                resultado.text = resultado.text[:corte_eco].rstrip()
            estado["mostrou"] = True
            await emit("delta", {"text": resultado.text})
        elif resultado.text.startswith(inteiro) and len(resultado.text) > len(inteiro):
            # Fechamento que veio depois do último delta: completa sem repetir o já lido.
            await emit("delta", {"text": resultado.text[len(inteiro):]})
        elif inteiro.strip() == resultado.text.strip():
            # Só o espaçamento das pontas mudou na limpeza do DSML: o que já saiu é o
            # texto inteiro, e repetir o sufixo duplicaria a fala na tela.
            resultado.text = inteiro
    elif resultado is not None and texto and not resultado.text:
        resultado.text = "".join(texto)
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
) -> StepResult | None:
    """Reenvia o passo quando quem falhou foi o provedor — e não desiste na primeira.

    Três defesas, nesta ordem: erro de cota/indisponibilidade é repetido com backoff
    (sob 429, martelar piora); erro "de vez" (400/401/403) ganha **uma** segunda chance
    em outra conta, quando o provedor expõe `rotate()` — é assim que cota por conta falha
    no meio de uma conversa; e, se tudo cair, ainda espera a janela curta de cooldown e
    tenta uma última vez — um 429 em rajada passa em segundos.
    """
    from ..providers.base import ProviderError, TransientProviderError

    quantidade_contas = getattr(modelo, "tentativas_contas", lambda: 1)()
    tentativas = max(tentativas, quantidade_contas)
    restantes = max(1, tentativas)
    fatais = max(1, quantidade_contas - 1)
    ultima_cartada = espera_final > 0
    #: Total de tentativas desta insistência, contando a última cartada quando ela existe.
    #: É o denominador do contador que o app mostra («Reconectando… NN/NN»).
    total_de_tentativas = tentativas + (1 if ultima_cartada else 0)
    #: `estado["mostrou"]` vira `True` quando já saiu texto na tela: repetir o passo
    #: duplicaria o que o usuário já leu, então nesse caso é melhor parar e avisar.
    if estado is None:
        estado = {"mostrou": False}

    while True:
        try:
            return await _executar_passo(
                modelo, historico, tools, model, emit, estado, reasoning, effort,
            )
        except TransientProviderError as error:
            if estado["mostrou"]:
                await emit(
                    "delta",
                    {
                        "text": (
                            f"\n\n[o provedor caiu no meio do passo {numero}: "
                            f"{motivo_do_provedor(error)}]\n"
                        )
                    },
                )
                return None
            restantes -= 1
            if restantes > 0:
                usadas = max(1, tentativas - restantes)
                await _trocar_conta(modelo, emit, numero)
                # Cota do serviço: respeitar Retry-After quando vier; sem ele,
                # espaçar as chamadas progressivamente para não piorar a fila.
                espera = max(
                    min(ESPERA_BASE * (2 ** (usadas - 1)), 30.0),
                    min(error.retry_after_s or 0.0, 60.0),
                )
                # A espera do retry também é avisada: sem isto ela era um silêncio de até 10 s
                # por tentativa, com a tela girando sem dizer que o provedor tinha falhado.
                # O contador vai junto: o app mostra «Reconectando… NN/NN» com ele. O número
                # é o da tentativa que **vai rodar** (a primeira já rodou e falhou) — sem
                # isto a última cartada aparecia como 04 depois do 02, pulando o 03.
                await _avisar_espera(
                    emit,
                    f"O provedor falhou — tentando de novo em {espera:.0f} s "
                    f"(restam {restantes}).",
                    tentativa=usadas + 1,
                    total=total_de_tentativas,
                )
                reconectar = getattr(modelo, "reconectar", None)
                if callable(reconectar):
                    try:
                        await reconectar(error)
                    except Exception:  # noqa: BLE001 — a tentativa normal ainda pode resolver
                        pass
                if not await _esperar(espera, limite):
                    return None
                continue
            if ultima_cartada:
                ultima_cartada = False
                restantes = 1
                espera_ultima = max(espera_final, min(error.retry_after_s or 0.0, 60.0))
                await _avisar_espera(
                    emit,
                    f"O provedor caiu — última tentativa em {espera_ultima:.0f} s.",
                    tentativa=total_de_tentativas,
                    total=total_de_tentativas,
                )
                if not await _esperar(espera_ultima, limite):
                    return None
                continue
            await emit(
                "delta",
                {"text": f"\n\n[erro do provedor no passo {numero}] {motivo_do_provedor(error)}\n"},
            )
            return None
        except ProviderError as error:
            if estado["mostrou"]:
                await emit(
                    "delta",
                    {
                        "text": (
                            f"\n\n[o provedor caiu no meio do passo {numero}: "
                            f"{motivo_do_provedor(error)}]\n"
                        )
                    },
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
            await emit(
                "delta",
                {"text": f"[erro do provedor no passo {numero}] {motivo_do_provedor(error)}"},
            )
            return None
