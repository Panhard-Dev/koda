import bootstrap
import copy
import json
import sqlite3
import tempfile
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock
import httpx
from app.config import Settings
from app.db import Database, SCHEMA
from app.schemas import Message, ToolStepOut
from app.repository import append_message, ensure_conversation, mensagens_da_conversa
from app.providers.base import ChatTurn, ChatOptions
from app.providers.openai_compat import HostProvider, OpenAICompatibleProvider, conteudo_do_turno
from app.agent.contexto import compactar_turnos
from app.routers.chat import _turns, _store
from app.contracts.turn import ToolStep, ToolCall, StepResult
from app.routers import chat
from app.schemas import ChatRequest
from app.providers.base import Piece, ProviderError

REASON = 'synthetic provider text â€” not a real conversation'
TOOLS = [{'type':'function','function':{'name':'read_test','parameters':{'type':'object'}}}]

class HistoryTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup)
        self.db=Database(Path(t.name)/'test.db');self.db.initialize()
        with self.db.connect() as c:
            self.cid=ensure_conversation(c,None,'synthetic',1)

    def test_store_reload_replay_preserves_reasoning_privately(self):
        opaque={'extra_content':{'synthetic_signature':'synthetic-private-state'}}
        step=ToolStepOut(name='read_test',arguments={},output='synthetic output',duration_ms=1,call_id='call_a',ok=True,raw_arguments='{}',extra=opaque)
        with patch('app.host_auth.email_da_conta',return_value=None):
            saved=_store(self.db,self.cid,'done','liz-4-5-super',3,[step],reasoning_content=REASON)
        with self.db.connect() as c: messages=mensagens_da_conversa(c,self.cid)
        self.assertEqual(messages[0].reasoning_content,REASON)
        self.assertNotIn('reasoning_content',saved.model_dump())
        self.assertNotIn(REASON,saved.model_dump_json())
        self.assertNotIn(REASON,repr(saved))
        self.assertNotIn('synthetic-private-state',saved.model_dump_json())
        self.assertEqual(messages[0].steps[0].extra,opaque)
        turns,_=_turns(messages,None,False)
        wire=[conteudo_do_turno(t,incluir_raciocinio=True) for t in turns]
        self.assertEqual(wire[0]['reasoning_content'],REASON)
        self.assertEqual(wire[0]['tool_calls'][0]['id'],wire[1]['tool_call_id'])
        self.assertEqual(wire[0]['tool_calls'][0]['extra_content'],opaque['extra_content'])

    def test_opaque_metadata_cannot_override_structural_tool_fields(self):
        step=ToolStepOut(name='read_test',call_id='original',raw_arguments='{}',extra={'id':'injected','function':{'name':'injected'},'index':99,'extra_content':{'signature':'synthetic'}})
        turns,_=_turns([Message(id='a',role='assistant',text='done',at=1,steps=[step])],None,False)
        call=conteudo_do_turno(turns[0])['tool_calls'][0]
        self.assertEqual(call['id'],'original');self.assertEqual(call['function']['name'],'read_test')
        self.assertNotIn('index',call)

    def test_plain_assistant_reload_preserves_reasoning(self):
        with self.db.connect() as c:
            append_message(c,self.cid,Message(id='a',role='assistant',text='done',at=2,reasoning_content=REASON))
        with self.db.connect() as c:messages=mensagens_da_conversa(c,self.cid)
        turns,_=_turns(messages,None,False)
        self.assertEqual(conteudo_do_turno(turns[0],incluir_raciocinio=True)['reasoning_content'],REASON)

    def test_legacy_migration_is_additive_and_repeatable(self):
        old=Path(self.db.path).with_name('legacy.db')
        c=sqlite3.connect(old);c.executescript(SCHEMA.replace(',\n  reasoning_content TEXT',''))
        c.execute("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('old','keep',1,1)")
        c.execute("INSERT INTO messages(id,conversation_id,role,text,at) VALUES('a','old','assistant','preserve',1)")
        c.commit();c.close()
        db=Database(old);db.initialize();db.initialize()
        with db.connect() as c:
            row=c.execute("SELECT text,reasoning_content FROM messages WHERE id='a'").fetchone()
            self.assertEqual(tuple(row),('preserve',None))

    def test_context_budget_counts_persisted_reasoning(self):
        turns=[ChatTurn('assistant','small',reasoning_content='x'*40000),ChatTurn('user','current task')]
        summary,kept,_=compactar_turnos(turns,5000)
        self.assertEqual(kept[-1].text,'current task')
        self.assertFalse(any(t.reasoning_content for t in kept))

    def test_current_request_over_budget_is_not_removed_or_truncated(self):
        current='synthetic user requirement ' * 1000
        _,kept,_=compactar_turnos([ChatTurn('assistant','old'),ChatTurn('user',current)],100)
        self.assertEqual(len(kept),1)
        self.assertEqual(kept[0].text,current)

    def test_all_app_modules_loaded_from_versioned_candidate_tree(self):
        import sys
        for name,module in list(sys.modules.items()):
            if name=='app' or name.startswith('app.'):
                path=getattr(module,'__file__',None)
                if path:self.assertTrue(Path(path).resolve().is_relative_to(bootstrap.ROOT/'backend'),(name,path))

class RequestTests(unittest.IsolatedAsyncioTestCase):
    async def make_provider(self,handler,official=True):
        settings=Settings(_env_file=None)
        p=HostProvider(settings) if official else OpenAICompatibleProvider(settings,base_url='http://offline.invalid/v1',model='test')
        p.base_url='http://offline.invalid/v1'
        p.headers=lambda:{'Content-Type':'application/json'}
        p.esforco=AsyncMock(return_value='max')
        p._cliente_http=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(p._cliente_http.aclose)
        return p

    def long_history(self):
        h=[{'role':'user','content':'synthetic original task'}]
        for i in range(45):
            m={'role':'assistant','content':'synthetic','tool_calls':[{'id':f'call_{i}','type':'function','function':{'name':'read_test','arguments':'{}'}}]}
            if i%3: m['reasoning_content']=REASON+str(i)
            elif i%2: m['reasoning_content']=None
            h += [m,{'role':'tool','tool_call_id':f'call_{i}','content':'already executed synthetic result'}]
        h += [{'role':'assistant','content':'older plain answer'},{'role':'user','content':'continue'}]
        return h

    async def test_baseline_strict_error_reproduced(self):
        def strict(request):
            body=json.loads(request.content)
            missing=any(m.get('role')=='assistant' and not isinstance(m.get('reasoning_content'),str) for m in body['messages'])
            return httpx.Response(400 if missing else 200,json={'error':{'message':'The `reasoning_content` in the thinking mode must be passed back to the API.'}})
        p=await self.make_provider(strict,False)
        with self.assertRaises(ProviderError) as e:await p.step(self.long_history(),TOOLS)
        self.assertIn('400',str(e.exception))

    async def test_streaming_45_tool_history_legacy_and_full_reasoning(self):
        history=self.long_history();before=copy.deepcopy(history);requests=[]
        def strict(request):
            body=json.loads(request.content);requests.append(body)
            for old,new in zip(history,body['messages']):
                if old['role']=='assistant':self.assertEqual(new['reasoning_content'],old.get('reasoning_content') or '')
                if 'tool_calls' in old:self.assertEqual(old['tool_calls'],new['tool_calls'])
                if old['role']=='tool':self.assertEqual(old,new)
            return httpx.Response(200,text='data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        p=await self.make_provider(strict)
        results=[x async for x in p.step_streaming(history,TOOLS)]
        self.assertEqual(results[-1].text,'ok');self.assertEqual(len(requests),1)
        self.assertEqual(history,before)

    async def test_nonstreaming_legacy_without_calls_also_gets_field(self):
        requests=[]
        def strict(request):
            body=json.loads(request.content);requests.append(body)
            self.assertEqual(body['messages'][0]['reasoning_content'],'')
            return httpx.Response(200,json={'choices':[{'message':{'content':'ok','reasoning_content':REASON}}]})
        p=await self.make_provider(strict)
        result=await p.step([{'role':'assistant','content':'old plain text'}],TOOLS)
        self.assertEqual(result.reasoning_content,REASON);self.assertEqual(len(requests),1)

    async def test_nonhost_and_no_tools_unchanged(self):
        p=await self.make_provider(lambda request:httpx.Response(500),False)
        h=[{'role':'assistant','content':'old'}]
        self.assertIs(p._historico_para_pedido(h,TOOLS),h)
        host=await self.make_provider(lambda request:httpx.Response(500))
        self.assertIs(host._historico_para_pedido(h,[]),h)

    async def test_no_tools_request_does_not_add_persisted_reasoning(self):
        for official in (False,True):
            requests=[]
            def handler(request):
                body=json.loads(request.content);requests.append(body)
                self.assertFalse(any('reasoning_content' in m for m in body['messages']))
                return httpx.Response(200,text='data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            p=await self.make_provider(handler,official)
            turns=[ChatTurn('assistant','old',reasoning_content=REASON),ChatTurn('user','synthetic')]
            pieces=[x async for x in p.stream(turns,ChatOptions(model='synthetic'))]
            self.assertEqual(len(requests),1)

    def test_user_and_tool_do_not_receive_reasoning(self):
        for role in ('user','tool'):
            wire=conteudo_do_turno(ChatTurn(role,'synthetic',reasoning_content=REASON))
            self.assertNotIn('reasoning_content',wire)

class StreamStorageTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_loop_carries_opaque_metadata_without_tool_replay(self):
        from app.agent import loop
        opaque={'extra_content':{'signature':'synthetic-private-state'}}
        class Model:
            async def step(self,*args):
                return StepResult(text='Reading synthetic file',calls=[ToolCall('call_a','read_file',{'path':'test.txt'},'{"path":"test.txt"}',extra=opaque)],reasoning_content=REASON)
        async def emit(*args):pass
        with tempfile.TemporaryDirectory() as tmp, patch.object(loop.mcp,'catalogo',return_value=[]), patch.object(loop.ferramentas,'executar',return_value='synthetic output') as execute:
            result=await loop.executar(Model(),[{'role':'system','content':'synthetic'},{'role':'user','content':'Read test.txt once'}],workspace=Path(tmp),max_steps=1,emit=emit)
        self.assertEqual(execute.call_count,1)
        self.assertEqual(result.passos[0].extra,opaque)
        self.assertNotIn('synthetic-private-state',json.dumps(result.passos[0].to_dict()))

    async def test_real_stream_handlers_store_reasoning_on_success_and_failure(self):
        for mode in ('text','text_failure','text_reasoning_failure','agent','agent_failure'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
                db=Database(Path(tmp)/'test.db');db.initialize()
                with db.connect() as c:cid=ensure_conversation(c,None,'synthetic',1)
                settings=Settings(_env_file=None,workspace_path=Path(tmp))
                async def stream(turns,options):
                    yield Piece(REASON[:10],reasoning=True)
                    yield Piece(REASON[10:],reasoning=True)
                    if mode=='text_reasoning_failure':raise ProviderError('synthetic interruption')
                    yield Piece('synthetic response')
                    if mode=='text_failure':raise ProviderError('synthetic interruption')
                engine=SimpleNamespace(name='host',resolve_model=lambda model:model,stream=stream)
                request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=db,provider=engine,settings=settings)))
                store=SimpleNamespace(buscar_varios=lambda ids:[])
                for name,value in {'_store_de_anexos':store,'_visao_ativa':False,
                                  '_prepare':(cid,[ChatTurn('user','synthetic')],[0],'',0),
                                  '_compactar_e_guardar':('',[ChatTurn('user','synthetic')],0),
                                  '_workspace':Path(tmp),'indice_para_agente':'',
                                  '_modo_de_permissao':'auto','_usage':{}}.items():
                    stack.enter_context(patch.object(chat,name,return_value=value))
                stack.enter_context(patch.object(chat,'SkillStore',return_value=None))
                stack.enter_context(patch.object(chat.ferramentas,'encerrar_do_dono'))
                stack.enter_context(patch('app.host_auth.email_da_conta',return_value=None))
                async def run(*args,emit,**kwargs):
                    await emit('reasoning',{'text':REASON[:10]})
                    await emit('reasoning',{'text':REASON[10:]})
                    await emit('delta',{'text':'synthetic response'})
                    if mode=='agent_failure':raise ProviderError('synthetic interruption')
                    return chat.Resultado(texto='synthetic response',passos=[ToolStep('read_test',{},'synthetic output',1,call_id='call_a',extra={'extra_content':{'signature':'synthetic-private-state'}})],completou=True,uso={})
                stack.enter_context(patch.object(chat,'rodar_ferramentas',side_effect=run))
                payload=ChatRequest(text='synthetic',model='liz-4-5-super')
                generator=chat._texto(request,payload) if mode.startswith('text') else chat._agente(request,settings,payload)
                events=[event async for event in generator]
                self.assertTrue(any('done' in event for event in events))
                with db.connect() as c:messages=mensagens_da_conversa(c,cid)
                self.assertEqual(messages[-1].reasoning_content,REASON)
                self.assertNotIn('reasoning_content',messages[-1].model_dump())
                if 'failure' in mode:
                    self.assertTrue(messages[-1].incompleto)
                    self.assertEqual(messages[-1].motivo,'provider_error')
                if mode=='agent':
                    self.assertEqual(messages[-1].steps[0].extra,{'extra_content':{'signature':'synthetic-private-state'}})
                    self.assertFalse(any('synthetic-private-state' in event for event in events))

if __name__=='__main__':unittest.main(verbosity=2)
