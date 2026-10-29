"""Smoke test HTTP do runtime distribuído em diretório isolado, sem iniciar o host de modelos."""
from pathlib import Path
import hashlib
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/'src-tauri/runtime/backend'


def smoke():
    for source in (ROOT/'backend/app').rglob('*.py'):
        target=RUNTIME/'app'/source.relative_to(ROOT/'backend/app')
        if not target.is_file() or hashlib.sha256(source.read_bytes()).digest()!=hashlib.sha256(target.read_bytes()).digest():
            raise RuntimeError('runtime desatualizado: '+str(source.relative_to(ROOT)))
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0))
        port=reservation.getsockname()[1]
    token=secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory(prefix='.tmp-portable-smoke-',dir=ROOT) as directory:
        directory=Path(directory)
        workspace=directory/'workspace'
        workspace.mkdir()
        (directory/'mcps.json').write_text('[]')
        env={key:value for key,value in os.environ.items()
             if not key.upper().startswith(('KODA_','HOST_','SERVE_LIZ_','PYTHONPATH','PYTHONHOME'))}
        env.update({'KODA_PROVIDER':'local','KODA_CLOUD_URL':'','KODA_DATABASE_PATH':str(directory/'test.db'),
                    'KODA_WORKSPACE':str(workspace),'KODA_BACKEND_PACKAGED':'1',
                    'TEMP':str(directory),'TMP':str(directory)})
        code='import sys;print("phase: interpreter",flush=True);sys.path.insert(0,'+repr(str(RUNTIME))+');import uvicorn;print("phase: uvicorn imported",flush=True);uvicorn.run("app.main:app",host="127.0.0.1",port='+str(port)+',log_level="info")'
        with (directory/'runtime.log').open('w+',encoding='utf-8') as log:
            process=subprocess.Popen([str(RUNTIME/'python/python.exe'),'-X','importtime','-c',code],cwd=directory,
                env=env,stdin=subprocess.PIPE,stdout=log,stderr=log,text=True,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            try:
                process.stdin.write(token+'\n')
                process.stdin.flush()
                process.stdin.close()
                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                def request(path,method='GET',body=None,content_type='application/json'):
                    data=json.dumps(body).encode() if isinstance(body,dict) else body
                    req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,method=method,data=data,
                        headers={'authorization':'Bearer '+token,'x-koda-window':'portable-audit',
                                 'Content-Type':content_type})
                    try:
                        with opener.open(req,timeout=30) as response:
                            return response.read()
                    except urllib.error.HTTPError as error:
                        if error.code==404 and method=='GET':
                            raise
                        raise RuntimeError(f'{method} {path}: HTTP {error.code}: '+error.read().decode(errors='replace')) from None
                deadline=time.monotonic()+60
                while True:
                    if process.poll() is not None:
                        raise RuntimeError('runtime encerrou antes do health check')
                    try:
                        request('/api/health')
                        break
                    except (urllib.error.URLError,TimeoutError):
                        if time.monotonic()>deadline: raise
                        time.sleep(.25)
                for mode in ('plan','default','auto'):
                    result=json.loads(request('/api/permissions','PUT',{'modo':mode}))
                    assert result['modo']==mode
                boundary='audit-'+secrets.token_hex(8)
                multipart=(f'--{boundary}\r\nContent-Disposition: form-data; name="arquivo"; filename="report.txt"\r\n'
                           f'Content-Type: text/plain\r\n\r\nportable delivery\r\n--{boundary}--\r\n').encode()
                attachment=json.loads(request('/api/attachments','POST',multipart,'multipart/form-data; boundary='+boundary))
                attachment_path=directory/'anexos'/attachment['id']/'report.txt'
                assert attachment_path.read_bytes()==b'portable delivery'
                conversation=json.loads(request('/api/conversations','POST'))
                stream=request('/api/chat','POST',{'text':'Oi','tools':False,
                    'conversation_id':conversation['id'],'attachments':[attachment['id']]}).decode()
                assert 'event: done' in stream
                stored=json.loads(request('/api/conversations/'+conversation['id']))
                assert len(stored['messages'])>=2
                request('/api/conversations/'+conversation['id'],'DELETE')
                assert not attachment_path.exists()
                try:
                    request('/api/attachments/'+attachment['id'])
                    raise AssertionError('anexo excluído ainda visível')
                except urllib.error.HTTPError as error:
                    assert error.code==404
                return {'packaged_python':'passed','http_stream_persistence':'passed',
                        'permissions':'passed','attachment_delete_disk_and_index':'passed',
                        'production_profile_used':False}
            except Exception:
                log.flush()
                print((directory/'runtime.log').read_text(encoding='utf-8',errors='replace')[-4000:])
                raise
            finally:
                process.terminate()
                process.wait(timeout=20)


if __name__=='__main__':
    print(json.dumps(smoke()))
