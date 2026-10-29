"""Invariantes com SQLite/disco reais e providers offline, sem alterar a base do usuário."""
import asyncio
import contextvars
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from app import host_auth, provider_state
from app.agent import plans
from app.agent.loop import _aceitou_plano, executar, classificar_pedido, MODO_RESPOSTA
from app.anexos import AnexoStore, AnexoError
from app.config import Settings
from app.contracts.turn import StepResult, ToolCall
from app.db import Database, SCHEMA
from app.repository import (ensure_conversation, append_message, get_conversation,
    list_conversations, delete_conversation, mensagens_da_conversa, salvar_resumo)
from app.schemas import ChatRequest, Message
from app.policy import approvals
from app.execution.processo import _ambiente_do_comando
from app.nuvem import ClienteNuvem, LIMITE_CORPO
from fastapi.testclient import TestClient
from app.main import create_app
from app import mcp, seguranca, semente
from app.providers import HostProvider
from app.policy.capabilities import deny_for_read_only
from app.tools import registry
from app.agent.completion import verificar_arquivos
from app.contracts.turn import ToolStep
from app.contracts import mudancas
from app.anexos import reconciliar


@pytest.fixture
def environment(tmp_path):
    settings = Settings(_env_file=None, database_path=tmp_path / 'audit.db', workspace=tmp_path,
                        provider='local', cloud_url='')
    db = Database(settings.database_path)
    db.initialize()
    binding = host_auth.vincular(host_auth.RequestContext(window='test-a', email='a@example.test'))
    yield settings, db
    host_auth.desvincular(binding)


def test_account_cannot_read_append_delete_or_summarize_other_history(environment):
    _, db = environment
    with db.connect() as conn:
        cid = ensure_conversation(conn, None, 'private', 1)
        append_message(conn, cid, Message(id='m', role='user', text='private', at=1))
        approvals.lembrar(conn, 'comando', '*', 'sempre')
    binding = host_auth.vincular(host_auth.RequestContext(window='test-b', email='b@example.test'))
    try:
        with db.connect() as conn:
            assert list_conversations(conn) == []
            assert get_conversation(conn, cid) is None
            assert not delete_conversation(conn, cid)
            assert approvals.regra(conn, 'comando', '*') is None
            salvar_resumo(conn, cid, 'intrusion', 50)
            with pytest.raises(PermissionError):
                mensagens_da_conversa(conn, cid)
            with pytest.raises(PermissionError):
                append_message(conn, cid, Message(id='foreign', role='user', text='intrusion', at=2))
            with pytest.raises(PermissionError):
                ensure_conversation(conn, cid, 'intrusion', 2)
    finally:
        host_auth.desvincular(binding)
    with db.connect() as conn:
        assert get_conversation(conn, cid).messages[0].text == 'private'
        assert conn.execute('SELECT resumo FROM conversations WHERE id=?', (cid,)).fetchone()[0] is None


def test_attachment_owner_and_failed_delete_are_real_disk_state(environment):
    settings, db = environment
    store = AnexoStore(settings)
    item = store.guardar('report.txt', b'private data')
    binding = host_auth.vincular(host_auth.RequestContext(email='b@example.test'))
    try:
        other = AnexoStore(settings)
        assert other.buscar(item.id) is None
        assert other.buscar_varios([item.id]) == []
        assert not other.remover(item.id)
    finally:
        host_auth.desvincular(binding)
    with patch.object(Path, 'unlink', side_effect=PermissionError('locked')):
        with pytest.raises(AnexoError):
            store.remover(item.id)
    assert item.caminho.read_bytes() == b'private data'
    assert store.buscar(item.id) is None
    with db.connect() as conn:
        assert conn.execute('SELECT state FROM attachments WHERE id=?', (item.id,)).fetchone()[0] == 'deletion_pending'
    assert store.remover(item.id)
    assert not item.caminho.exists()


def test_failed_upload_is_unreadable_and_keeps_reconcilable_record(environment):
    settings, db = environment
    with patch('app.anexos.os.replace', side_effect=OSError('disk failed')):
        with pytest.raises(OSError):
            AnexoStore(settings).guardar('report.txt', b'data')
    with db.connect() as conn:
        row = conn.execute('SELECT * FROM attachments').fetchone()
        assert row['state'] == 'pending'
    assert AnexoStore(settings).buscar(row['id']) is None


@pytest.mark.parametrize('text', ['não pode começar', '"aprovado"', 'pode começar?', 'bora', 'Plano aceito, pode começar.'])
def test_free_text_never_approves(text):
    assert not _aceitou_plano([{'role': 'user', 'content': text}])


def test_plan_decision_has_owner_snapshot_and_single_atomic_consumption(environment):
    _, db = environment
    with db.connect() as conn:
        cid = ensure_conversation(conn, None, 'create a file', 1)
    source = ChatRequest(text='crie report.txt', conversation_id=cid, project_path='original-project', model='original-model')
    text = plans.registrar(db, cid, source, '```koda-plano\n{"titulo":"Plan","como":["create"]}\n```')
    plan_id = json.loads(text.split('\n')[1])['plan_id']
    binding = host_auth.vincular(host_auth.RequestContext(window='test-b', email='a@example.test'))
    try:
        with pytest.raises(LookupError):
            plans.decidir(db, plan_id, 'approve')
    finally:
        host_auth.desvincular(binding)
    approved = plans.decidir(db, plan_id, 'approve')
    approved.model = 'tampered-model'
    approved.project_path = 'tampered-project'
    contexts = [contextvars.copy_context() for _ in range(8)]
    def consume(ctx):
        try:
            return ctx.run(plans.consumir, db, approved)
        except LookupError:
            return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(consume, contexts))
    winners = [result for result in results if result is not None]
    assert len(winners) == 1
    assert winners[0].model == 'original-model'
    assert winners[0].project_path == 'original-project'


def test_legacy_migration_preserves_ambiguous_data_and_repairs_index(tmp_path):
    path = tmp_path / 'legacy.db'
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        conn.execute("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('c','legacy',1,1)")
        conn.execute("INSERT INTO messages(id,conversation_id,role,text,at,conta) VALUES('m','c','user','keep',1,NULL)")
    db = Database(path)
    db.initialize()
    db.initialize()
    with db.connect() as conn:
        assert conn.execute("SELECT owner_account_id FROM conversations WHERE id='c'").fetchone()[0] is None
        assert conn.execute("SELECT text FROM messages WHERE id='m'").fetchone()[0] == 'keep'
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='idx_messages_conta'").fetchone()
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert len(list(tmp_path.glob('*.bak'))) == 1


class ScriptedModel:
    def __init__(self, responses):
        self.responses = iter(responses)

    async def step(self, *args, **kwargs):
        return next(self.responses, StepResult(text='Sem execução disponível.'))


def test_plan_block_never_writes_or_counts_success(environment):
    settings, _ = environment
    events = []
    async def emit(event, data):
        events.append((event, data))
    call = ToolCall('write', 'write_file', {'caminho': 'forbidden.txt', 'conteudo': 'oops'},
                    raw_arguments='{"caminho":"forbidden.txt","conteudo":"oops"}')
    result = asyncio.run(executar(ScriptedModel([StepResult(calls=[call]), StepResult(text='Plano proposto.')]),
        [{'role': 'user', 'content': 'crie o arquivo forbidden.txt'}], workspace=settings.workspace_path,
        max_steps=3, emit=emit, planejar=True))
    assert not (settings.workspace_path / 'forbidden.txt').exists()
    assert result.executou == 0
    assert not result.passos[0].ok
    assert not result.passos[0].executed
    assert result.passos[0].status == 'blocked'


def test_fake_completion_cannot_finish_action_without_execution(environment):
    settings, _ = environment
    async def emit(*args):
        pass
    result = asyncio.run(executar(ScriptedModel([StepResult(text='Criei o arquivo solicitado.')]),
        [{'role': 'user', 'content': 'crie o arquivo delivered.txt'}], workspace=settings.workspace_path,
        max_steps=4, emit=emit))
    assert not result.completou
    assert not (settings.workspace_path / 'delivered.txt').exists()


def test_long_conversation_does_not_grant_tools():
    assert classificar_pedido([{'role':'user','content':'oi'}, {'role':'assistant','content':'olá'},
                              {'role':'user','content':'qual é a capital do Brasil?'}]) == MODO_RESPOSTA


def test_child_environment_does_not_receive_koda_secrets(monkeypatch):
    monkeypatch.setenv('KODA_API_TOKEN', 'private')
    monkeypatch.setenv('SERVE_LIZ_BLOB_KEY', 'private')
    monkeypatch.setenv('HOST_KEY', 'private-host-alias')
    monkeypatch.setenv('USER_PROJECT_FLAG', 'keep')
    result = _ambiente_do_comando()
    assert 'KODA_API_TOKEN' not in result
    assert 'SERVE_LIZ_BLOB_KEY' not in result
    assert 'HOST_KEY' not in result
    assert 'KODA_API_TOKEN' not in _ambiente_do_comando({'KODA_API_TOKEN':'injected'})
    assert result['USER_PROJECT_FLAG'] == 'keep'


def test_provider_state_is_not_plaintext_in_sqlite(environment):
    _, db = environment
    private = 'synthetic-private-provider-state'
    with db.connect() as conn:
        cid = ensure_conversation(conn, None, 'test', 1)
        append_message(conn, cid, Message(id='private', role='assistant', text='visible',
                       reasoning_content=private, at=1))
        stored = conn.execute("SELECT reasoning_content FROM messages WHERE id='private'").fetchone()[0]
        assert stored != private
        if stored is not None:
            assert provider_state.abrir(stored) == private
        assert 'reasoning_content' not in get_conversation(conn, cid).model_dump()['messages'][0]


@pytest.fixture
def api(environment, monkeypatch):
    settings, _ = environment
    monkeypatch.setenv('KODA_API_TOKEN', 'test-execution-token')
    monkeypatch.setattr(host_auth, '_sessions', {})
    monkeypatch.setattr(semente, 'semear', lambda *args: None)
    monkeypatch.setattr(mcp, 'configurar', lambda *args: None)
    monkeypatch.setattr(mcp, 'preparar', lambda *args: None)
    monkeypatch.setattr(mcp, 'encerrar', lambda *args: None)
    with TestClient(create_app(settings)) as client:
        client.headers['authorization'] = 'Bearer test-execution-token'
        yield client


@pytest.mark.parametrize('authority,expected', [('[::1]:8787', 200), ('localhost:8787', 200),
    ('evil.test:8787', 403), ('localhost:99999', 403), ('user@localhost', 403), ('', 403)])
def test_host_authority_accepts_only_valid_loopback(api, authority, expected):
    assert api.get('/api/health', headers={'host': authority}).status_code == expected


def test_plan_http_approval_executes_only_saved_task_and_actual_file(api, environment):
    settings, _ = environment
    class Model(ScriptedModel):
        name = 'offline-test'
        ready = True
        def resolve_model(self, name):
            return name
    model = Model([
        StepResult(calls=[ToolCall('blocked', 'write_file', {'caminho':'output.txt','conteudo':'bad'},
            raw_arguments='{"caminho":"output.txt","conteudo":"bad"}')]),
        StepResult(text='```koda-plano\n{"titulo":"Criar arquivo","como":["Criar output.txt"]}\n```'),
        StepResult(calls=[ToolCall('actual', 'write_file', {'caminho':'output.txt','conteudo':'real delivery'},
            raw_arguments='{"caminho":"output.txt","conteudo":"real delivery"}')]),
        StepResult(text='Arquivo criado e conferido.'),
    ])
    api.app.state.provider = model
    assert api.put('/api/permissions', json={'modo':'plan'}).status_code == 200
    response = api.post('/api/chat', json={'text':'crie o arquivo output.txt', 'tools':True})
    assert response.status_code == 200, response.text
    assert not (settings.workspace_path / 'output.txt').exists()
    with api.app.state.db.connect() as conn:
        plan = conn.execute('SELECT * FROM task_plans').fetchone()
        assert plan is not None, response.text
        assert plan['id'] in response.text
        assert plan['status'] == 'pending'
    decision = api.post('/api/chat/plan/decision', json={'id':plan['id'], 'decision':'approve'})
    assert decision.status_code == 200, decision.text
    payload = decision.json()['execution']
    payload['project_path'] = str(settings.workspace_path / 'foreign')
    execution = api.post('/api/chat', json=payload)
    assert execution.status_code == 200, execution.text
    assert (settings.workspace_path / 'output.txt').read_text() == 'real delivery', execution.text
    assert not (settings.workspace_path / 'foreign').exists()
    replay = api.post('/api/chat', json=payload)
    assert replay.status_code == 409


def test_permission_modes_and_denials_are_account_scoped(environment):
    _, db = environment
    action = {'kinds':['comando'], 'escopos':{'comando':'*'}}
    with db.connect() as conn:
        approvals.definir_modo(conn, 'auto')
        approvals.lembrar(conn, 'comando', '*', 'nunca')
        for mode in ('manual', 'default', 'auto', 'livre'):
            assert approvals.resolver(conn, action, mode) == 'nunca'
    binding = host_auth.vincular(host_auth.RequestContext(account_id='other'))
    try:
        with db.connect() as conn:
            assert approvals.modo(conn) == 'default'
            assert approvals.resolver(conn, action, 'default') == 'perguntar'
    finally:
        host_auth.desvincular(binding)
    with db.connect() as conn:
        assert approvals.modo(conn) == 'auto'


def test_plan_completion_revokes_continuation_and_expiration_denies_it(environment):
    _, db = environment
    with db.connect() as conn:
        cid = ensure_conversation(conn, None, 'create', 1)
    text = plans.registrar(db, cid, ChatRequest(text='create', conversation_id=cid),
                          '```koda-plano\n{"titulo":"Plan"}\n```')
    pid = json.loads(text.split('\n')[1])['plan_id']
    payload = plans.decidir(db, pid, 'approve')
    plans.consumir(db, payload)
    plans.finalizar(db, cid, False)
    assert plans.em_execucao(db, cid)
    with db.connect() as conn:
        conn.execute("UPDATE task_plans SET expires_at=0 WHERE id=?", (pid,))
    assert not plans.em_execucao(db, cid)
    with db.connect() as conn:
        conn.execute("UPDATE task_plans SET status='running', expires_at=9999999999 WHERE id=?", (pid,))
    plans.finalizar(db, cid, True)
    assert not plans.em_execucao(db, cid)


def test_internal_control_preserves_user_and_tool_pairing():
    from app.contracts.control import ControlHistory
    user = {'role':'user', 'content':'pedido real'}
    tool = {'role':'tool', 'tool_call_id':'call-1', 'content':'delivery'}
    history = ControlHistory([user])
    history.append({'role':'user', 'content':'controle'})
    history.extend([tool, {'role':'user', 'content':'controle 2'}])
    history += [{'role':'user', 'content':'controle 3'}]
    history.insert(1, {'role':'user', 'content':'controle 4'})
    assert [item for item in history if item['role']=='user'] == [user]
    assert tool in history


def test_approval_emission_failure_leaves_no_live_permission(environment):
    from types import SimpleNamespace
    from app.routers.chat import _pedir_permissao
    _, db = environment
    state = SimpleNamespace(aprovacoes={}, aprovacao_contextos={})
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    async def emit(*args):
        raise ConnectionError('stream closed')
    async def scenario():
        with pytest.raises(ConnectionError):
            await _pedir_permissao(request, db, 'default', emit,
                                  {'kinds':['comando'], 'escopos':{'comando':'build'}})
        assert not state.aprovacoes
        assert not state.aprovacao_contextos
    asyncio.run(scenario())


def test_task_budget_is_shared_by_children_and_resets_after_exit():
    from app.agent.budget import task_budget, current, BudgetExhausted
    seen = []
    @task_budget
    async def child(**kwargs):
        seen.append(current.get())
        current.get().claim_model()
        assert not current.get().claim_tool()
    @task_budget
    async def parent(**kwargs):
        budget = current.get()
        seen.append(budget)
        budget.claim_model()
        assert budget.claim_tool()
        await child(max_steps=100, max_tool_calls=100)
        with pytest.raises(BudgetExhausted):
            budget.claim_model()
    asyncio.run(parent(max_steps=2, max_tool_calls=1))
    assert seen[0] is seen[1]
    assert current.get() is None


def test_read_only_execution_cannot_spawn_through_a_lower_level_door(environment):
    import sys
    from app.execution.processo import _rodar_lista
    from app.execution.tempo import without_host_processes, HOST_EXECUTION_ALLOWED
    settings, _ = environment
    marker = settings.workspace_path / 'must-not-exist.txt'
    @without_host_processes
    async def scenario():
        return await asyncio.to_thread(_rodar_lista,
            [sys.executable, '-c', 'from pathlib import Path; Path("must-not-exist.txt").write_text("bad")'],
            settings.workspace_path)
    output = asyncio.run(scenario())
    assert output.startswith('ERRO')
    assert not marker.exists()
    assert HOST_EXECUTION_ALLOWED.get()


def test_verification_evidence_survives_reopening_history(environment):
    _, db = environment
    proof = {'scope':'local_read_only','files':[{'path':'report.txt','sha256':'test-digest'}], 'errors':[]}
    with db.connect() as conn:
        cid = ensure_conversation(conn,None,'delivery',1)
        append_message(conn,cid,Message(id='verified',role='assistant',text='delivery',at=1,verification=proof))
    with db.connect() as conn:
        assert get_conversation(conn,cid).messages[0].verification == proof


def test_old_plan_schema_migrates_preserving_pending_approval(tmp_path):
    path = tmp_path/'v2.db'
    from contextlib import closing
    with closing(sqlite3.connect(path)) as conn:
        old = SCHEMA.replace(
            "'running','completed','interrupted'", "'running'")
        conn.executescript(old)
        conn.execute("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('c','keep',1,1)")
        conn.execute("""INSERT INTO task_plans VALUES
            ('plan','c','account:a','window','{}','digest','content','pending',9999999999)""")
        conn.execute('PRAGMA user_version=2')
        conn.commit()
    Database(path).initialize()
    with Database(path).connect() as conn:
        assert conn.execute("SELECT content,status FROM task_plans WHERE id='plan'").fetchone()['status']=='pending'
        conn.execute("UPDATE task_plans SET status='completed' WHERE id='plan'")
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'


def test_resumed_plan_cannot_expand_original_permissions(environment):
    _, db = environment
    with db.connect() as conn:
        cid = ensure_conversation(conn,None,'create',1)
    payload = ChatRequest(text='create',conversation_id=cid,project_path='approved-project',livre=False)
    text = plans.registrar(db,cid,payload,'```koda-plano\n{"titulo":"Plan"}\n```')
    pid=json.loads(text.split('\n')[1])['plan_id']
    plans.consumir(db,plans.decidir(db,pid,'approve'))
    plans.finalizar(db,cid,False)
    restored=plans.retomar(db,ChatRequest(text='',resume=True,conversation_id=cid,
                                        project_path='foreign',livre=True))
    assert restored.project_path=='approved-project'
    assert restored.livre is False


def test_new_empty_conversation_accepts_first_message_but_cannot_resume(api):
    created=api.post('/api/conversations')
    assert created.status_code==201
    cid=created.json()['id']
    refused=api.post('/api/chat',json={'conversation_id':cid,'resume':True,'text':'','tools':False})
    assert refused.status_code==400
    sent=api.post('/api/chat',json={'conversation_id':cid,'text':'Oi','tools':False})
    assert sent.status_code==200, sent.text
    assert 'event: done' in sent.text
    assert len(api.get('/api/conversations/'+cid).json()['messages'])==2


def test_a_read_is_not_proof_of_an_edit(environment):
    settings, _ = environment
    path=settings.workspace_path/'existing.txt'
    path.write_text('original',encoding='utf-8')
    async def emit(*args):
        pass
    model=ScriptedModel([
        StepResult(calls=[ToolCall('read-only','read_file',{'caminho':'existing.txt'},
                                  raw_arguments='{"caminho":"existing.txt"}')]),
        StepResult(text='Editei o arquivo solicitado.'),
    ])
    result=asyncio.run(executar(model,[{'role':'user','content':'edite o arquivo existing.txt'}],
        workspace=settings.workspace_path,max_steps=4,emit=emit))
    assert result.executou==1
    assert not result.completou
    assert path.read_text(encoding='utf-8')=='original'


def test_unexpected_stream_failure_emits_terminal_error_without_private_details(api):
    class Broken:
        name='broken-offline'
        ready=True
        def resolve_model(self,name):
            return name
        async def step(self,*args,**kwargs):
            raise RuntimeError('private-internal-value')
    api.app.state.provider=Broken()
    response=api.post('/api/chat',json={'text':'crie arquivo failure.txt','tools':True})
    assert response.status_code==200
    # `error` aciona reenvio automático em clientes existentes. Uma falha interna
    # após trabalho parcial precisa encerrar com done incompleto, sem repetir ações.
    assert 'event: error' not in response.text
    assert 'event: done' in response.text
    assert 'internal_error' in response.text
    assert '"completed": false' in response.text
    assert 'private-internal-value' not in response.text
    assert not api.app.state.active_conversations


def test_footer_failure_does_not_turn_saved_delivery_into_retry(api,environment,monkeypatch):
    class Model(ScriptedModel):
        name='offline-footer-test'
        ready=True
        def resolve_model(self,name):
            return name
    settings,_=environment
    api.app.state.provider=Model([
        StepResult(calls=[ToolCall('deliver','write_file',{'caminho':'delivery.txt','conteudo':'real'},
            raw_arguments='{"caminho":"delivery.txt","conteudo":"real"}')]),
        StepResult(text='Arquivo salvo.'),
    ])
    def fail_usage(*args):
        raise RuntimeError('private-footer-failure')
    monkeypatch.setattr('app.routers.chat._usage',fail_usage)
    response=api.post('/api/chat',json={'text':'crie o arquivo delivery.txt','tools':True})
    assert response.status_code==200
    assert (settings.workspace_path/'delivery.txt').read_text()=='real'
    assert 'event: error' not in response.text
    assert '"completed": true' in response.text
    assert '"resumable": false' in response.text
    assert 'private-footer-failure' not in response.text


def test_read_only_capability_does_not_expose_alternative_execution_doors():
    denied = deny_for_read_only(registry.DEFINICOES)
    for definition in registry.DEFINICOES:
        name = definition['function']['name']
        if registry.canonico(name) in {'shell','terminal','code_interpreter','write_file','delete_file','install_package','sub_agente'}:
            assert name in denied


def test_cloud_response_stops_consuming_at_limit():
    class Body(httpx.AsyncByteStream):
        chunks = 0
        async def __aiter__(self):
            for _ in range(10000):
                self.chunks += 1
                yield b'x' * 16384
    body = Body()
    transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=body))
    client = ClienteNuvem('https://offline.test', transport=transport)
    assert asyncio.run(client._get('/test', {})) is None
    assert body.chunks <= LIMITE_CORPO // 16384 + 1


def test_verified_identity_is_window_scoped_and_logout_preserves_data(api, environment, monkeypatch):
    settings, _ = environment
    api.app.state.settings = settings.model_copy(update={'cloud_url':'https://identity.test'})
    original_client = httpx.AsyncClient
    def identity(request):
        token = request.headers['authorization'].split()[-1]
        return httpx.Response(200, json={'conta':{'id':token, 'email':token+'@example.test',
            'nome':token, 'criada_em':'2020-01-01T00:00:00.000Z'}})
    monkeypatch.setattr(httpx, 'AsyncClient', lambda *args, **kwargs:
        original_client(*args, **kwargs, transport=httpx.MockTransport(identity)))
    headers_a = {'x-koda-window':'window-a'}
    headers_b = {'x-koda-window':'window-b'}
    for token, headers in [('account-a',headers_a), ('account-b',headers_b)]:
        response = api.post('/api/host/sessao', headers=headers,
            json={'token':token,'email':'forged@example.test','nome':'forged'})
        assert response.status_code == 200, response.text
        assert token in response.json()['conta']
        assert 'forged' not in response.json()['conta']
        headers['x-koda-session'] = token
    assert api.get('/api/conversations', headers={'x-koda-window':'window-a'}).status_code == 401
    assert api.get('/api/conversations', headers={'x-koda-window':'window-a','x-koda-session':'account-b'}).status_code == 401
    cid = api.post('/api/conversations', headers=headers_a).json()['id']
    upload = api.post('/api/attachments', headers=headers_a, files={'arquivo':('data.txt', b'private')})
    assert upload.status_code == 200, upload.text
    aid = upload.json()['id']
    assert api.get('/api/conversations', headers=headers_b).json() == []
    assert api.get('/api/conversations/'+cid, headers=headers_b).status_code == 404
    assert api.delete('/api/conversations/'+cid, headers=headers_b).status_code == 404
    assert api.get('/api/attachments/'+aid, headers=headers_b).status_code == 404
    assert api.delete('/api/attachments/'+aid, headers=headers_b).status_code == 404
    assert api.post('/api/account/sign-out', headers=headers_a).status_code == 200
    assert api.post('/api/host/sessao', headers=headers_a, json={'token':'account-a'}).status_code == 200
    assert api.get('/api/conversations/'+cid, headers=headers_a).status_code == 200
    assert api.get('/api/attachments/'+aid, headers=headers_a).status_code == 200
    assert api.get('/api/conversations', headers=headers_b).json() == []


def test_request_snapshot_survives_another_login_and_threads():
    async def scenario():
        binding = host_auth.vincular(host_auth.RequestContext(window='snapshot', token='old', email='a@test'))
        try:
            ready = asyncio.Event()
            async def running():
                await ready.wait()
                return await asyncio.to_thread(lambda: (host_auth.atual(), host_auth.email_da_conta()))
            task = asyncio.create_task(running())
            host_auth.definir('new', email='b@test')
            ready.set()
            assert await task == ('old', 'a@test')
            assert host_auth.atual() == 'new'
        finally:
            host_auth.desvincular(binding)
    asyncio.run(scenario())


def test_read_only_verification_reports_invalid_syntax_and_never_edits(environment):
    settings, _ = environment
    path = settings.workspace_path / 'invalid.py'
    content = 'def broken(:\n'
    path.write_text(content)
    result = verificar_arquivos(settings.workspace_path, ['invalid.py'], [ToolStep(name='write_file',
        arguments={'caminho':'invalid.py','conteudo':content},output='ok',duration_ms=0,ok=True,executed=True,status='success')])
    assert result['errors']
    assert path.read_text() == content
    assert not (settings.workspace_path / '__pycache__').exists()


def test_verification_tracks_final_state_after_move_and_delete(environment):
    settings, _ = environment
    (settings.workspace_path/'moved.txt').write_text('delivery')
    steps = [ToolStep(name='write_file',arguments={'caminho':'source.txt','conteudo':'delivery'},
                     output='ok',duration_ms=0,executed=True,status='success'),
             ToolStep(name='move_file',arguments={'origem':'source.txt','destino':'moved.txt'},
                     output='ok',duration_ms=0,executed=True,status='success')]
    result = verificar_arquivos(settings.workspace_path,['source.txt','moved.txt'],steps)
    assert not result['errors']
    assert any(item['status']=='absence_checked' for item in result['files'])


def test_diff_artifacts_are_private_to_account(environment):
    settings, _ = environment
    path = str(settings.workspace_path/'private.txt')
    mudancas.anotar(path,None,'secret','write_file','same-call-id')
    binding=host_auth.vincular(host_auth.RequestContext(email='other@example.test'))
    try:
        assert mudancas.da_chamada('same-call-id') == []
        assert mudancas.de(path) is None
        assert mudancas.listar() == []
        assert mudancas.limpar() == 0
    finally:
        host_auth.desvincular(binding)
    assert mudancas.da_chamada('same-call-id')


def test_deleting_conversation_reconciles_only_its_unshared_attachment(environment):
    settings, db = environment
    store=AnexoStore(settings)
    item=store.guardar('private.txt',b'delivery')
    from app.schemas import AttachmentInfo
    with db.connect() as conn:
        cid=ensure_conversation(conn,None,'attachment',1)
        append_message(conn,cid,Message(id='attached',role='user',text='read',at=1,
            attachments=[AttachmentInfo(id=item.id,nome=item.nome,tipo=item.mime,tamanho=item.tamanho)]))
    with pytest.raises(AnexoError):
        store.remover(item.id)
    with db.connect() as conn:
        assert delete_conversation(conn,cid)
    assert reconciliar(settings)==1
    assert not item.caminho.exists()
    assert store.buscar(item.id) is None


def test_failed_migration_rolls_back_and_backup_can_restore_history(tmp_path, monkeypatch):
    path=tmp_path/'legacy.db'
    connection=sqlite3.connect(path)
    try:
        connection.executescript(SCHEMA)
        connection.execute("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('c','keep',1,1)")
        connection.commit()
    finally:
        connection.close()
    def fail(conn):
        conn.execute('ALTER TABLE conversations ADD COLUMN half_migrated TEXT')
        raise RuntimeError('migration interrupted')
    with monkeypatch.context() as patcher:
        patcher.setattr(Database,'_migrar',staticmethod(fail))
        with pytest.raises(RuntimeError):
            Database(path).initialize()
    with Database(path).connect() as conn:
        assert 'half_migrated' not in {row['name'] for row in conn.execute('PRAGMA table_info(conversations)')}
        assert conn.execute("SELECT title FROM conversations WHERE id='c'").fetchone()[0]=='keep'
        assert conn.execute('PRAGMA user_version').fetchone()[0]==0
    backups=list(tmp_path.glob('*.bak'))
    assert len(backups)==1
    source=sqlite3.connect(backups[0])
    restored=sqlite3.connect(tmp_path/'restored.db')
    try:
        source.backup(restored)
        assert restored.execute("SELECT title FROM conversations WHERE id='c'").fetchone()[0]=='keep'
        assert restored.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    finally:
        source.close()
        restored.close()
    Database(path).initialize()


def test_chat_stream_keeps_the_account_session_for_the_model(api, environment):
    """StreamingResponse resumes after request middleware; host auth must survive it."""
    settings, _ = environment
    window = 'model-stream-window'
    session = 'synthetic-account-session'
    host_auth._sessions[window] = host_auth.RequestContext(
        window=window, token=session, email='model@example.test', account_id='account-model'
    )
    api.app.state.settings = settings.model_copy(update={
        'host_url': 'https://models.example.test/v1', 'host_model': 'liz-4'
    })
    observed = {}

    def responder(request):
        observed['authorization'] = request.headers.get('authorization')
        if observed['authorization'] != f'Bearer {session}':
            return httpx.Response(401, text='account session required')
        body = ('data: {"choices":[{"delta":{"content":"modelo respondeu"},"finish_reason":null}]}\n\n'
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
                'data: [DONE]\n\n')
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=body.encode())

    model = HostProvider(api.app.state.settings)
    model._cliente_http = httpx.AsyncClient(transport=httpx.MockTransport(responder))
    api.app.state.providers = {window: model}
    response = api.post('/api/chat', headers={
        'x-koda-window': window, 'x-koda-session': session,
    }, json={'text': 'Responda apenas OK.', 'model': 'liz-4', 'tools': False})

    assert response.status_code == 200, response.text
    assert 'modelo respondeu' in response.text
    assert observed['authorization'] == f'Bearer {session}'
