"""Recuperação após morte real do processo, com SQLite e bytes persistidos."""
import os
import subprocess
import sys
import time

import pytest

from app.config import Settings
from app.db import Database
from app.anexos import AnexoStore, reconciliar


@pytest.mark.parametrize('after_replace', [False, True])
def test_process_death_during_upload_never_exposes_partial_content(tmp_path, after_replace):
    database=tmp_path/'crash.db'
    Database(database).initialize()
    script='''
import os,sys
from pathlib import Path
sys.path.insert(0, 'backend')
from app.config import Settings
from app.anexos import AnexoStore
import app.anexos as attachments
settings=Settings(_env_file=None,database_path=Path(sys.argv[1]),workspace=Path(sys.argv[2]),cloud_url='')
original=attachments.os.replace
def interrupted(source,target):
    if sys.argv[3]=='after': original(source,target)
    os._exit(23)
attachments.os.replace=interrupted
AnexoStore(settings).guardar('report.txt', b'complete content')
'''
    result=subprocess.run([sys.executable,'-',str(database),str(tmp_path),'after' if after_replace else 'before'],
        input=script,text=True,capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    assert result.returncode==23, result.stderr
    settings=Settings(_env_file=None,database_path=database,workspace=tmp_path,cloud_url='')
    with Database(database).connect() as conn:
        row=conn.execute('SELECT id,state,caminho FROM attachments').fetchone()
        assert row['state']=='pending'
        conn.execute('UPDATE attachments SET criado_em=?',(int(time.time()*1000)-3_600_001,))
    assert AnexoStore(settings).buscar(row['id']) is None
    assert reconciliar(settings)==1
    assert AnexoStore(settings).buscar(row['id']) is None
    with Database(database).connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM attachments').fetchone()[0]==0
    assert list((tmp_path/'anexos').iterdir())==[]
