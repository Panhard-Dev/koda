"""Orçamento de contexto: o que fazer quando a conversa (ou a tarefa) não cabe mais.

O agente reenvia o histórico inteiro ao provedor a cada passo. Num projeto grande isso
vira o problema principal: cada saída de ferramenta (até 12 mil caracteres) entra na
conta, e depois de dezenas de passos o pedido passa do que o provedor aceita — o modelo
começa a responder errado, a chamada volta com erro, e a tarefa morre no meio.

Três coisas acontecem aqui, todas **sem** pedir nada a nenhum provedor (uma compactação
que dependesse de uma chamada de modelo falharia justamente quando o contexto está cheio):

- `estimar_tokens`: conta aproximada, sem tokenizer;
- `compactar_turnos`: as conversas antigas viram um resumo no prompt de sistema, e só os
  turnos recentes vão inteiros;
- `compactar_historico`: **durante** a tarefa, as saídas de ferramenta antigas encolhem e
  os trechos já resolvidos saem do meio, mantendo intactas a tarefa original e a janela
  recente — que é o que o modelo precisa para continuar de onde parou.

A regra de ouro: nada aqui pode quebrar o casamento `tool_calls` ↔ `tool` que o host
exige. Por isso o corte é sempre em pares e a janela recente nunca começa com uma
mensagem `tool` órfã (ver `_limite_seguro`).
"""

from __future__ import annotations

import json
import re
from typing import Any

#: Orçamento padrão do contexto, em tokens, quando a configuração não diz nada.
#: É a janela dos modelos do serviço (1 milhão): compactar antes disso descartaria
#: contexto que ainda caberia.
ORCAMENTO_PADRAO = 1_000_000

#: Quantos turnos da conversa ficam inteiros ao compactar o histórico de fora da tarefa.
#: Doze é o suficiente para o modelo lembrar do que se estava falando antes.
TURNOS_INTEIROS = 12

#: Quantas mensagens do **meio da tarefa** ficam intactas na compactação do loop. É a
#: janela que o modelo usa para decidir o próximo passo: encolher demais faz ele repetir
#: ferramenta que já rodou.
JANELA_RECENTE = 10

#: Quanto do orçamento um único turno pode ocupar antes de ser cortado na entrada.
FRACAO_POR_TURNO = 0.35

#: Tetos do resumo: o que substitui as mensagens antigas tem que ser **curto**, senão não
#: compacta nada. Caracteres, não tokens — é texto para o modelo ler.
LIMITE_RESUMO = 4_000
LIMITE_TRECHO = 400

#: Média de caracteres por token. Inglês fica perto de 4, português perto de 3 — 3,5 é o
#: meio, e a estimativa arredonda para cima: compactar cedo custa menos que estourar.
CARACTERES_POR_TOKEN = 3.5


#: Erro de "não cabe" dos provedores OpenAI-compatíveis. Cada um escreve de um jeito
#: (`context_length_exceeded`, "maximum context length is 128000 tokens", "prompt is too
#: long"), e o que se procura aqui é a ideia, não a frase exata.
ESTOURO = re.compile(
    r"(context[_ ]length|context window|maximum context|too many tokens|"
    r"reduce the length|prompt is too long|input is too long|"
    r"exceeds? the maximum (?:allowed )?(?:tokens|context)|"
    r"tokens? (?:in the )?(?:messages? )?exceed|context_length_exceeded)",
    re.IGNORECASE,
)


def estouro_de_contexto(mensagem: str) -> bool:
    """O provedor recusou o pedido por tamanho?

    Isto é o que fecha o ciclo: o orçamento é uma **estimativa** (não há tokenizer aqui),
    e o limite real de cada provedor é outro. Quando o provedor responde "não cabe", o
    loop encolhe o contexto e manda de novo, em vez de mostrar o erro para a pessoa.
    """
    return bool(ESTOURO.search(mensagem or ""))


def estimar_tokens(texto: str) -> int:
    """Estimativa de tokens de um texto.

    Não há tokenizer aqui de propósito: cada provedor usa o seu, e baixar um só para
    contar caracteres custaria mais do que o erro da conta. Um 10% de folga é irrelevante
    para decidir se o contexto cabe no orçamento (1 milhão por padrão).
    """
    if not texto:
        return 0
    return int(len(texto) / CARACTERES_POR_TOKEN) + 1


def tokens_de_mensagem(mensagem: dict[str, Any]) -> int:
    """Custo de uma mensagem do histórico do modelo, já com o overhead do envelope."""
    total = estimar_tokens(str(mensagem.get("content") or ""))
    for chamada in mensagem.get("tool_calls") or []:
        if not isinstance(chamada, dict):
            continue
        funcao = chamada.get("function") or {}
        total += estimar_tokens(str(funcao.get("name") or ""))
        total += estimar_tokens(str(funcao.get("arguments") or ""))
    return total + 8


def tokens_do_historico(mensagens: list[dict[str, Any]]) -> int:
    """Quanto o histórico inteiro ocupa, em tokens estimados."""
    return sum(tokens_de_mensagem(item) for item in mensagens)


def _cortar(texto: str, limite: int) -> str:
    if len(texto) <= limite:
        return texto
    return texto[:limite] + f"…[mais {len(texto) - limite} caracteres]"


def _aviso_das_ferramentas(historico: list[dict[str, Any]]) -> str:
    """O que já foi usado, em uma linha: `write_file×3, read_file×7, shell×2`.

    Sem isso o modelo esquece — junto com o resto — **que** já trabalhou, e recomeça o
    mesmo arquivo do zero.
    """
    contagem: dict[str, int] = {}
    for mensagem in historico:
        for chamada in mensagem.get("tool_calls") or []:
            if not isinstance(chamada, dict):
                continue
            nome = str((chamada.get("function") or {}).get("name") or "").strip()
            if nome:
                contagem[nome] = contagem.get(nome, 0) + 1
    if not contagem:
        return ""
    lista = ", ".join(f"{nome}×{vezes}" for nome, vezes in sorted(contagem.items()))
    return f"Ferramentas já usadas nesta tarefa: {lista}."


def _ultimo_texto(historico: list[dict[str, Any]], papel: str) -> str:
    for mensagem in reversed(historico):
        if mensagem.get("role") != papel:
            continue
        texto = str(mensagem.get("content") or "").strip()
        if texto:
            return _cortar(texto, LIMITE_TRECHO)
    return ""


def _limite_seguro(historico: list[dict[str, Any]], corte: int) -> int:
    """Move o corte para não deixar resultado de ferramenta sem a chamada dele.

    O host casa `tool_call_id` do resultado com o `tool_calls` da mensagem do assistente.
    Uma janela que **começa** num resultado (`role: tool`) perde a chamada correspondente e
    o provedor recusa o pedido inteiro — então o corte anda para frente até achar uma
    mensagem que possa abrir a janela.
    """
    posicao = max(1, corte)
    while posicao < len(historico) and historico[posicao].get("role") == "tool":
        posicao += 1
    return posicao


#: Quantas mensagens do fim ficam inteiras no primeiro estágio. São as que o modelo
#: acabou de produzir e receber: é delas que sai o próximo passo.
INTOCAVEIS = 3


def indice_do_pedido(historico: list[dict[str, Any]]) -> int:
    """Índice da **última** mensagem do usuário — o pedido atual.

    É a mensagem que **nunca** pode ser cortada. A compactação antiga tratava `historico[1]`
    como "a tarefa", e num histórico com vários turnos esse é o pedido mais **antigo** da
    conversa: o pedido atual podia cair no miolo compactado (ou ser cortado no estágio 4) e
    o agente perdia a instrução que estava executando.
    """
    for indice in range(len(historico) - 1, 0, -1):
        if historico[indice].get("role") == "user":
            return indice
    return -1


def _encolher(historico: list[dict[str, Any]], ate: int, limite: int = LIMITE_TRECHO) -> None:
    """Corta o **conteúdo** das mensagens de 1 até `ate`, sem mexer na estrutura.

    Só o `content` é tocado: `tool_calls` e `tool_call_id` continuam intactos, que é o que
    o host exige para casar chamada e resultado. O pedido atual fica de fora do corte.
    """
    protegido = indice_do_pedido(historico)
    for indice in range(1, min(ate, len(historico))):
        if indice == protegido:
            continue
        mensagem = historico[indice]
        papel = mensagem.get("role")
        atual = str(mensagem.get("content") or "")
        if len(atual) <= limite:
            continue
        if papel == "tool":
            mensagem["content"] = atual[:limite] + "\n...[saída antiga encurtada]"
        elif papel == "assistant":
            mensagem["content"] = _cortar(atual, limite)
        elif indice > 1 and not atual.startswith("[contexto compactado]"):
            mensagem["content"] = _cortar(atual, limite)
    return None


def compactar_historico(
    historico: list[dict[str, Any]],
    orcamento: int = ORCAMENTO_PADRAO,
    *,
    janela: int = JANELA_RECENTE,
) -> tuple[int, int]:
    """Encolhe o histórico do loop **no lugar**. Devolve (tokens antes, tokens depois).

    Quatro estágios, do mais barato para o mais agressivo — a tarefa termina quando o
    pedido couber, e não quando o modelo começar a responder errado:

    1. as saídas de ferramenta antigas viram um aviso de uma linha;
    2. o miolo já resolvido sai inteiro e dá lugar a um resumo com o que foi feito;
    3. a própria janela recente encolhe, da mais antiga para a mais nova;
    4. nem a ponta cabe: ela é cortada no que resta do orçamento.

    - `orcamento <= 0` desliga tudo (o histórico passa a ser enviado inteiro, como antes);
    - a primeira mensagem (o prompt de sistema) e a segunda (a tarefa) nunca são tocadas:
      sem elas o modelo perde a missão.
    """
    if orcamento <= 0 or not historico:
        return (0, 0)
    antes = tokens_do_historico(historico)
    if antes <= orcamento:
        return (antes, antes)

    # --- 1: encolher o conteúdo antigo, mantendo a estrutura ---------------------
    _encolher(historico, len(historico) - INTOCAVEIS)
    depois = tokens_do_historico(historico)
    if depois <= orcamento:
        return (antes, depois)

    # --- 2: o miolo sai e dá lugar ao resumo do que já foi feito -----------------
    corte = _limite_seguro(historico, len(historico) - max(2, janela))
    if corte > 2:
        removidas = historico[1:corte]
        tarefa = historico[1]
        # O **pedido atual** nunca se perde. `historico[1]` é o turno mais **antigo** da
        # conversa, e tratá-lo como "a tarefa" apagava a instrução em execução quando a
        # conversa tem vários turnos. Se o pedido caiu no miolo que sai, ele volta logo
        # depois da tarefa — preservado inteiro.
        pedido = indice_do_pedido(historico)
        lembrado: list[dict[str, Any]] = (
            [historico[pedido]] if 1 < pedido < corte else []
        )
        resumo: list[str] = [
            "[contexto compactado] As mensagens do meio da tarefa saíram para o pedido "
            f"caber no contexto ({len(removidas)} mensagens). Não repita o que já foi feito."
        ]
        aviso = _aviso_das_ferramentas(removidas)
        if aviso:
            resumo.append(aviso)
        ultimo = _ultimo_texto(removidas, "assistant")
        if ultimo:
            resumo.append(f"Última coisa que você escreveu antes do corte: {ultimo}")
        saida = _ultimo_texto(removidas, "tool")
        if saida:
            resumo.append(f"Último resultado de ferramenta antes do corte: {saida}")
        texto = _cortar("\n".join(resumo), LIMITE_RESUMO)
        historico[:] = [
            historico[0],
            tarefa,
            *lembrado,
            {"role": "user", "content": texto},
            *historico[corte:],
        ]
        depois = tokens_do_historico(historico)
        if depois <= orcamento:
            return (antes, depois)

    # --- 3: a janela recente também encolhe; só a última mensagem fica inteira ---
    _encolher(historico, len(historico) - 1)
    depois = tokens_do_historico(historico)
    if depois <= orcamento:
        return (antes, depois)

    # --- 4: nem a ponta cabe: corta no que resta do orçamento --------------------
    fatia = max(1_000, int(orcamento / 3 * CARACTERES_POR_TOKEN))
    protegido = indice_do_pedido(historico)
    for indice, mensagem in enumerate(historico[1:], 1):
        if indice == protegido:
            # O pedido atual fica **inteiro**: cortá-lo aqui era o que fazia o agente
            # perder a especificação no meio da tarefa.
            continue
        atual = str(mensagem.get("content") or "")
        if len(atual) > fatia:
            mensagem["content"] = _cortar(atual, fatia)
    return (antes, tokens_do_historico(historico))


def compactar_turnos(
    turnos: list[Any],
    orcamento: int = ORCAMENTO_PADRAO,
    *,
    inteiros: int = TURNOS_INTEIROS,
) -> tuple[str, list[Any], int]:
    """Prepara o histórico da conversa para o provedor, cabendo no orçamento.

    Devolve `(resumo, turnos_que_ficam, quantos_sairam)`. O resumo entra no prompt de
    sistema — vira contexto de fundo, e não uma mensagem que o modelo precisa responder.

    O que fica: os últimos `inteiros` turnos, com o texto cortado se um deles sozinho
    passar de `FRACAO_POR_TURNO` do orçamento (uma colagem gigante no meio da conversa não
    pode empurrar o resto para fora).
    """
    if orcamento <= 0 or not turnos:
        return ("", turnos, 0)

    teto_por_turno = max(2_000, int(orcamento * FRACAO_POR_TURNO * CARACTERES_POR_TOKEN))
    usados = 0
    mantidos: list[Any] = []
    for posicao, turno in enumerate(reversed(turnos)):
        texto = str(getattr(turno, "text", "") or "")
        # O **pedido atual** (último turno do usuário) não é cortado: ele é a instrução que
        # o agente está executando, e cortá-lo fazia a especificação sumir no meio da
        # tarefa. Histórico antigo é que encolhe.
        eh_o_pedido_atual = posicao == 0 and getattr(turno, "role", "") == "user"
        if len(texto) > teto_por_turno and not eh_o_pedido_atual:
            # Corta **antes** de medir: um turno gigante sozinho não pode custar todas as
            # mensagens que vêm depois dele (era assim que uma colagem enorme empurrava a
            # conversa inteira para fora do contexto).
            texto = _cortar(texto, teto_por_turno)
            turno = _com_texto(turno, texto)
        custo = estimar_tokens(texto)
        if len(mantidos) >= inteiros or usados + custo > orcamento:
            break
        usados += custo
        mantidos.append(turno)
    mantidos.reverse()

    saiu = len(turnos) - len(mantidos)
    if saiu <= 0:
        # Nada saiu do histórico — mas algum turno gigante pode ter sido cortado, e é
        # `mantidos` que tem essa versão cortada (devolver `turnos` a jogaria fora).
        return ("", mantidos, 0)

    antigos = turnos[:saiu]
    linhas = [
        f"[histórico compactado] As {saiu} mensagens mais antigas desta conversa saíram "
        "para o pedido caber no contexto. O que havia nelas:"
    ]
    for turno in antigos:
        papel = "Você" if getattr(turno, "role", "") == "user" else "Koda"
        texto = " ".join(str(getattr(turno, "text", "") or "").split())
        if not texto:
            continue
        linhas.append(f"- {papel}: {_cortar(texto, 160)}")
        if sum(len(item) for item in linhas) > LIMITE_RESUMO:
            linhas.append("- (o resto do histórico é mais do mesmo)")
            break
    return (_cortar("\n".join(linhas), LIMITE_RESUMO), mantidos, saiu)


def _com_texto(turno: Any, texto: str) -> Any:
    """Mesmo turno, com o texto cortado — sem depender do tipo concreto do provedor."""
    trocar = getattr(turno, "model_copy", None)
    if callable(trocar):
        try:
            return trocar(update={"text": texto})
        except Exception:  # noqa: BLE001 — cópia falhou: cai no replacement simples
            pass
    try:
        novo = type(turno)(role=getattr(turno, "role"), text=texto)
    except Exception:  # noqa: BLE001 — tipo exótico: devolve o original
        return turno
    return novo


def resumo_curto(antes: int, depois: int) -> str:
    """Frase de uma linha para a interface, quando houve compactação."""
    if antes <= 0 or depois <= 0 or depois >= antes:
        return ""
    return (
        f"Contexto compactado: ~{antes // 1000}k → ~{depois // 1000}k tokens "
        "(o que já foi feito foi resumido)"
    )


def dica_de_contexto(tokens: int, orcamento: int) -> dict[str, int]:
    """O estado do contexto, para o evento SSE e para o `/api/health`."""
    return {
        "tokens": tokens,
        "orcamento": orcamento,
        "restante": max(0, orcamento - tokens) if orcamento > 0 else 0,
    }


def json_seguro(valor: Any) -> str:
    """Serializa argumentos sem estourar — usado nos avisos de compactação."""
    try:
        return json.dumps(valor, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(valor)
