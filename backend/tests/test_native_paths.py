"""Corridas de caminho no Windows: falhar antes de acessar um destino substituído."""
import os
from pathlib import Path
import subprocess

import pytest

from app.execution.paths import PathGuard
from app.tools import ferramentas


pytestmark = pytest.mark.skipif(os.name != 'nt', reason='contrato nativo do instalador Windows')


def test_write_holds_parent_until_atomic_replace(tmp_path, monkeypatch):
    parent = tmp_path / 'inside'
    parent.mkdir()
    displaced = tmp_path / 'displaced'
    assert displaced.is_relative_to(tmp_path)
    original = ferramentas._escrever_atomico
    attempts = []
    def race(path, text):
        try:
            parent.rename(displaced)
        except PermissionError:
            attempts.append('blocked')
        else:
            raise AssertionError('diretório validado foi substituído durante a escrita')
        return original(path, text)
    monkeypatch.setattr(ferramentas, '_escrever_atomico', race)
    result = ferramentas.executar('write_file', {'caminho':'inside/result.txt','conteudo':'delivery'}, tmp_path)
    assert result.startswith('ok'), result
    assert attempts == ['blocked']
    assert (parent/'result.txt').read_text() == 'delivery'
    assert not displaced.exists()


def test_junction_substituted_after_validation_is_rejected(tmp_path, monkeypatch):
    workspace = tmp_path/'workspace'
    workspace.mkdir()
    parent = workspace/'inside'
    parent.mkdir()
    outside = tmp_path/'outside'
    outside.mkdir()
    (outside/'private.txt').write_text('OUTSIDE-PRIVATE-CONTENT')
    displaced = workspace/'displaced'
    assert displaced.is_relative_to(tmp_path)
    original = PathGuard.directory
    replaced = []
    def race(self, directory, **kwargs):
        if directory.absolute() == parent.absolute() and not replaced:
            replaced.append(True)
            parent.rename(displaced)
            command = subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(parent),str(outside)],
                capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            assert command.returncode == 0, command.stderr.decode(errors='replace')
        return original(self, directory, **kwargs)
    monkeypatch.setattr(PathGuard, 'directory', race)
    try:
        result = ferramentas.executar('read_file', {'caminho':'inside/private.txt'}, workspace)
        assert replaced == [True]
        assert result.startswith('ERRO'), result
        assert 'OUTSIDE-PRIVATE-CONTENT' not in result
        assert (outside/'private.txt').read_text() == 'OUTSIDE-PRIVATE-CONTENT'
    finally:
        if parent.exists() and parent.is_junction():
            parent.rmdir()  # somente a entrada da junção, nunca a árvore apontada


def test_recursive_delete_removes_junction_entry_without_traversing_target(tmp_path):
    inside = tmp_path/'inside'
    outside = tmp_path/'outside'
    inside.mkdir()
    outside.mkdir()
    (outside/'private.txt').write_text('preserve')
    link = inside/'link'
    command = subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(link),str(outside)],
        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    assert command.returncode == 0
    result = ferramentas.executar('delete_directory', {'caminho':'inside'}, tmp_path)
    assert result.startswith('ok'), result
    assert not inside.exists()
    assert (outside/'private.txt').read_text() == 'preserve'


def test_copy_tree_and_edit_preserve_regular_files(tmp_path):
    source=tmp_path/'source'
    source.mkdir()
    (source/'nested').mkdir()
    (source/'nested'/'file.txt').write_text('before')
    copied=ferramentas.executar('copy_file',{'origem':'source','destino':'copy'},tmp_path)
    assert copied.startswith('ok'), copied
    assert (tmp_path/'copy'/'nested'/'file.txt').read_text()=='before'
    edited=ferramentas.executar('edit_file',{'caminho':'copy/nested/file.txt','old_string':'before','new_string':'after'},tmp_path)
    assert edited.startswith('ok'), edited
    assert (tmp_path/'copy'/'nested'/'file.txt').read_text()=='after'
    assert (source/'nested'/'file.txt').read_text()=='before'
