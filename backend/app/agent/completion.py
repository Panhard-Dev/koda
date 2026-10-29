"""Conferência local somente leitura, sem pedir novas edições ao modelo."""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any
from ..tools import registry
from ..contracts import mudancas


_CHANGE_REQUEST = re.compile(
    r'\b(cri[ae]|criar|adicion[ae]|adicionar|implement[ae]|implementar|'
    r'corrig[ae]|corrija|corrigir|arrum[ae]|arrumar|consert[ae]|consertar|'
    r'edit[ae]|editar|alter[ae]|alterar|apag[ae]|apague|apagar|'
    r'remov[ae]|remover|renomei[ae]|renomear|grav[ae]|gravar|'
    r'instal[ae]|instalar|desinstal[ae]|desinstalar)\b', re.IGNORECASE)


def requires_effect(text: str) -> bool:
    """Só restringe conclusão; esta classificação nunca concede ferramentas/permissões."""
    return bool(_CHANGE_REQUEST.search(text))


def verificar_arquivos(workspace: Path, caminhos: list[str], passos: list[Any] | None = None) -> dict[str, Any]:
    evidence: list[dict[str, str]] = []
    errors: list[str] = []
    def normalized(value: str) -> str:
        path = Path(value)
        return os.path.normcase(str((path if path.is_absolute() else workspace / path).resolve()))
    expected: dict[str, str] = {normalized(name): "exists" for name in caminhos}
    contents: dict[str, str] = {}
    for step in passos or []:
        if not step.ok or not step.executed:
            continue
        name = registry.canonico(step.name)
        args = registry._sinonimos(step.arguments)
        path = normalized(str(args['caminho'])) if args.get('caminho') else ''
        if path:
            contents.pop(path, None)
        if name in {'delete_file', 'delete_directory'} and path:
            expected[path] = 'absent'
            if name == 'delete_directory':
                for existing in list(expected):
                    if Path(existing).is_relative_to(path):
                        expected[existing] = 'absent'
                        contents.pop(existing, None)
        elif name == 'create_directory' and path:
            expected[path] = 'directory'
        elif name in {'write_file', 'edit_file', 'str_replace_editor'} and path:
            expected[path] = 'file'
            if name == 'write_file':
                contents[path] = str(args.get('conteudo', ''))
        elif name in {'move_file', 'copy_file', 'rename_file'}:
            source = normalized(str(args['origem'])) if args.get('origem') else path
            destination = (str(Path(source).with_name(str(args['novo_nome']))) if name == 'rename_file'
                           else normalized(str(args['destino'])) if args.get('destino') else '')
            if source and destination:
                for existing in list(expected):
                    if Path(existing).is_relative_to(source):
                        relocated = normalized(str(Path(destination) / Path(existing).relative_to(source)))
                        expected[relocated] = expected[existing]
                        if existing in contents:
                            contents[relocated] = contents[existing]
                        if name != 'copy_file':
                            expected[existing] = 'absent'
                            contents.pop(existing, None)
            if source and name != 'copy_file':
                expected[source] = 'absent'
            if destination:
                expected[destination] = 'exists'
        elif name == 'apply_patch':
            for modified in mudancas.caminhos_da_chamada(step.call_id):
                modified = normalized(modified)
                expected[modified] = 'file'
                contents.pop(modified, None)
    for name, state in expected.items():
        path = Path(name)
        path = path if path.is_absolute() else workspace / path
        try:
            if state == 'absent':
                if path.exists() or path.is_symlink():
                    raise ValueError('expected_absent')
                evidence.append({'path': name, 'status': 'absence_checked'})
                continue
            if not path.exists():
                raise FileNotFoundError(name)
            if state == 'directory' and not path.is_dir():
                raise ValueError('expected_directory')
            if state == 'file' and not path.is_file():
                raise ValueError('expected_file')
            if not path.is_file():
                evidence.append({'path': name, 'status': 'directory_exists'})
                continue
            if path.stat().st_size > 4 * 1024 * 1024:
                evidence.append({"path": name, "status": "unverified", "reason": "size_limit"})
                continue
            # O arquivo pode crescer entre stat e open; limitar também a leitura real.
            with path.open('rb') as source:
                data = source.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                evidence.append({'path':name,'status':'unverified','reason':'size_limit'})
                continue
            if name in contents and data.decode('utf-8').replace('\r\n', '\n') != contents[name].replace('\r\n', '\n'):
                raise ValueError('content_mismatch')
            if path.suffix.lower() == ".py":
                ast.parse(data, filename=str(path))
            elif path.suffix.lower() == ".json":
                json.loads(data)
            evidence.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(),
                             "status": "syntax_checked" if path.suffix.lower() in {".py", ".json"} else "exists"})
        except (OSError, SyntaxError, ValueError) as exc:
            errors.append(f"{name}: {type(exc).__name__}")
    return {"files": evidence, "errors": errors, "scope": "local_read_only",
            "unverified": any(item['status'] == 'unverified' for item in evidence)}
