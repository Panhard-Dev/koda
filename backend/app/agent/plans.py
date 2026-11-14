"""Planos imutáveis e decisões explícitas; texto do modelo não concede permissão."""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass

from .. import host_auth
from ..db import Database
from ..schemas import ChatRequest

#: Um bloco de plano no texto. Sem diferenciar caixa: o modelo escreve `KODA-PLANO`
#: às vezes, e a cerca em maiúsculas não pode deixar o cartão sem `plan_id`.
BLOCK = re.compile(
    r"```(koda-plano|koda-visual)\s*\n(.*?)\n```", re.DOTALL | re.IGNORECASE
)

#: Um bloco de plano **já fechado** no texto (a cerca final chegou).
#:
#: É a checagem barata que o stream usa antes de tentar registrar: o JSON só é lido
#: quando existe um bloco completo para ler.
_BLOCO_FECHADO = re.compile(
    r"```\s*(koda-plano|koda-visual)\s*\n.*?```", re.DOTALL | re.IGNORECASE
)

#: Teto de itens que o `como` do plano pode virar na lista de To-dos.
MAXIMO_DE_TODOS = 50


@dataclass(frozen=True)
class Vinculo:
    """O resultado de registrar um plano num texto.

    `texto` é o texto inteiro com o `plan_id` injetado; `original` e `vinculado` são o
    bloco antes e depois da injeção. O stream já entregou o resto do texto à interface,
    então ela troca só o bloco — não precisa redesenhar a resposta inteira.

    Quando não havia plano no texto, `plan_id` é `None` e `texto` é o próprio texto.
    """

    texto: str
    original: str = ""
    vinculado: str = ""
    plan_id: str | None = None


def _e_plano(match: re.Match[str], data: object) -> bool:
    return isinstance(data, dict) and (
        match[1].lower() == "koda-plano" or data.get("tipo") == "plano"
    )


def tem_bloco_fechado(texto: str) -> bool:
    """Há no texto um bloco `koda-plano`/`koda-visual` completo?

    Não julga o conteúdo: só diz se já vale a pena ler o JSON. Um `koda-visual` que não
    seja plano também responde `True` — quem decide é `registrar`, que devolve
    `plan_id=None` sem tocar no banco.
    """
    return _BLOCO_FECHADO.search(texto) is not None


def registrar(
    db: Database, conversation_id: str, payload: ChatRequest, text: str
) -> Vinculo:
    """Injeta um `plan_id` no primeiro bloco de plano do texto e o registra.

    **Em todos os modos.** Antes, só o modo Plan chamava isto; fora dele o bloco chegava
    à interface sem id, e o cartão mostrava «Plano antigo: peça um plano atualizado.» com
    os botões Desistir/Fazer desligados — foi o defeito visto em 05/11/2026.
    """
    plan_id = str(uuid.uuid4())
    found = False
    original = ""
    vinculado = ""

    def bind(match: re.Match[str]) -> str:
        nonlocal found, original, vinculado
        try:
            data = json.loads(match[2])
        except ValueError:
            return match[0]
        if not _e_plano(match, data):
            return match[0]
        if data.get("plan_id"):
            return match[0]  # já vinculado: registrar de novo trocaria o id à toa
        if found:
            return match[0]  # um plano acionável por rodada
        found = True
        original = match[0]
        data["plan_id"] = plan_id
        vinculado = f"```{match[1]}\n{json.dumps(data, ensure_ascii=False)}\n```"
        return vinculado

    bound = BLOCK.sub(bind, text)
    if not found:
        return Vinculo(texto=text)
    with db.connect() as conn:
        conn.execute("UPDATE task_plans SET status='superseded' WHERE conversation_id=? AND status IN ('pending','approved')",
                     (conversation_id,))
        conn.execute("""INSERT INTO task_plans
            (id, conversation_id, owner_account_id, window_id, snapshot, content_hash, content, status, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (plan_id, conversation_id, host_auth.proprietario(), host_auth.contexto_atual().window,
             payload.model_copy(update={"conversation_id": conversation_id}).model_dump_json(),
             hashlib.sha256(bound.encode()).hexdigest(), bound, int(time.time()) + 86400))
    return Vinculo(texto=bound, original=original, vinculado=vinculado, plan_id=plan_id)


def texto_do_bloco(dados: dict[str, object]) -> str:
    """O bloco `koda-plano` a partir dos dados que a ferramenta `mostrar_plano` recebeu.

    A ferramenta existe para o modelo **não depender de escrever cerca no texto**: ele
    preenche os argumentos, e o cartão nasce do mesmo jeito em qualquer provedor. O texto
    continua sendo gerado porque é ele que fica gravado — reabrir a conversa desenha o
    cartão de novo.
    """
    return "```koda-plano\n" + json.dumps(dados, ensure_ascii=False) + "\n```"


def registrar_dados(
    db: Database, conversation_id: str, payload: ChatRequest, dados: dict[str, object]
) -> Vinculo:
    """Registra o plano que veio da ferramenta, injetando o `plan_id` no bloco."""
    return registrar(db, conversation_id, payload, texto_do_bloco(dados))


def todos_do_plano(texto: str) -> list[dict[str, object]]:
    """Os To-dos que o próprio plano já declara, quando o modelo não chamou `update_todos`.

    O cartão do plano e a lista de To-dos são a mesma promessa em duas formas: o `como` é
    o passo a passo que a pessoa lê, e o To-dos é o mesmo passo a passo que o agente vai
    marcando. Quando o modelo apresenta o plano e esquece de registrar a lista, o painel
    ficava vazio — a pessoa via o plano na tela sem nenhum acompanhamento. Aqui o `como`
    vira a lista inicial: nada feito e nada em andamento, porque o trabalho ainda não
    começou.
    """
    for match in BLOCK.finditer(texto):
        try:
            dados = json.loads(match[2])
        except ValueError:
            continue
        if not _e_plano(match, dados):
            continue
        passos = dados.get("como") or dados.get("passos") or dados.get("etapas")
        if not isinstance(passos, list):
            return []
        itens: list[dict[str, object]] = []
        for passo in passos:
            if isinstance(passo, str):
                titulo, detalhe = passo, ""
            elif isinstance(passo, dict):
                titulo = str(passo.get("titulo") or passo.get("texto") or "").strip()
                detalhe = str(passo.get("texto") or passo.get("detalhe") or "").strip()
            else:
                continue
            titulo = " ".join(titulo.split())
            if not titulo:
                continue
            # O To-dos é uma linha; o detalhe do passo já está no cartão. Ele só entra
            # quando o título sozinho não diz o que fazer.
            item = titulo if len(titulo) >= 24 or not detalhe else f"{titulo} — {detalhe}"
            itens.append({"texto": item[:400], "feito": False, "atual": False})
            if len(itens) >= MAXIMO_DE_TODOS:
                break
        return itens
    return []


def decidir(db: Database, plan_id: str, decision: str) -> ChatRequest:
    if decision not in {"approve", "reject"}:
        raise ValueError("decisão inválida")
    target = "approved" if decision == "approve" else "rejected"
    with db.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("""UPDATE task_plans SET status=? WHERE id=? AND owner_account_id=?
            AND window_id=? AND status IN ('pending', ?) AND expires_at>? RETURNING snapshot""",
            (target, plan_id,
             host_auth.proprietario(), host_auth.contexto_atual().window, target, int(time.time()))).fetchone()
        if row is None:
            raise LookupError("plano expirado, substituído ou já decidido")
        if decision == "approve":
            # Aceitar o plano é sair do modo Plan: a pessoa já autorizou a execução, e
            # continuar em «só planeja» deixava o chip em Plan e a próxima mensagem
            # parada de novo (visto em 05/11/2026). Auto executa o plano aprovado sem
            # pedir outra confirmação a cada passo; Desistir mantém o modo como está.
            from ..policy import approvals

            approvals.definir_modo(conn, "auto")
        payload = ChatRequest.model_validate_json(row["snapshot"])
        return payload.model_copy(update={"resume": True, "approved_plan_id": plan_id,
                                          "text": "", "attachments": []})


def consumir(db: Database, payload: ChatRequest) -> ChatRequest:
    with db.connect() as conn:
        row = conn.execute("""UPDATE task_plans SET status='running' WHERE id=? AND conversation_id=?
            AND owner_account_id=? AND window_id=? AND status='approved' AND expires_at>?
            RETURNING snapshot""", (payload.approved_plan_id, payload.conversation_id,
            host_auth.proprietario(), host_auth.contexto_atual().window, int(time.time()))).fetchone()
        if row is None:
            raise LookupError("aprovação inválida ou já consumida")
        original = ChatRequest.model_validate_json(row["snapshot"])
        return original.model_copy(update={"resume": True, "approved_plan_id": payload.approved_plan_id,
                                            "text": "", "attachments": []})


def em_execucao(db: Database, conversation_id: str) -> bool:
    with db.connect() as conn:
        return conn.execute("""SELECT 1 FROM task_plans WHERE conversation_id=? AND owner_account_id=?
            AND window_id=? AND status IN ('running','interrupted') AND expires_at>?""",
            (conversation_id, host_auth.proprietario(), host_auth.contexto_atual().window,
             int(time.time()))).fetchone() is not None


def finalizar(db: Database, conversation_id: str, completed: bool) -> None:
    """Concluir revoga a execução; interrupção preserva somente a retomada explícita."""
    with db.connect() as conn:
        conn.execute("""UPDATE task_plans SET status=? WHERE conversation_id=?
            AND owner_account_id=? AND window_id=? AND status IN ('running','interrupted')""",
            ('completed' if completed else 'interrupted', conversation_id,
             host_auth.proprietario(), host_auth.contexto_atual().window))


def retomar(db: Database, payload: ChatRequest) -> ChatRequest:
    """Retomar um plano não autoriza trocar projeto, modelo ou capacidades salvas."""
    with db.connect() as conn:
        row = conn.execute("""UPDATE task_plans SET status='running' WHERE conversation_id=?
            AND owner_account_id=? AND window_id=? AND status IN ('running','interrupted')
            AND expires_at>? RETURNING snapshot""", (payload.conversation_id,
            host_auth.proprietario(), host_auth.contexto_atual().window, int(time.time()))).fetchone()
        if row is None:
            return payload
        original = ChatRequest.model_validate_json(row['snapshot'])
        return original.model_copy(update={'resume': True, 'text': '', 'attachments': [],
                                           'approved_plan_id': None})
