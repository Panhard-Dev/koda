"""Ensaia a migração em cópia consistente; nunca altera o banco informado."""
from __future__ import annotations
import argparse
import json
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.db import Database


def counts(connection):
    tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {table: connection.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0]
            for table in ('conversations', 'messages', 'attachments') if table in tables}


def verify(source: Path) -> dict:
    if not source.is_file():
        raise FileNotFoundError(source)
    with tempfile.TemporaryDirectory(prefix='koda-migration-rehearsal-') as directory:
        copy = Path(directory) / 'rehearsal.db'
        with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as original:
            before = counts(original)
            with closing(sqlite3.connect(copy)) as destination:
                original.backup(destination)
        database = Database(copy)
        database.initialize()
        database.initialize()  # Idempotência, sem nova cópia nem perda de registros.
        with database.connect() as connection:
            after = counts(connection)
            integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
            foreign_keys = list(connection.execute('PRAGMA foreign_key_check'))
            version = connection.execute('PRAGMA user_version').fetchone()[0]
        if before != after or integrity != 'ok' or foreign_keys:
            raise RuntimeError('migração não preservou contagens ou integridade')
        backups = list(Path(directory).glob('*.bak'))
        restored = Path(directory) / 'restored.db'
        if backups:
            with closing(sqlite3.connect(backups[0])) as saved, closing(sqlite3.connect(restored)) as target:
                saved.backup(target)
                if counts(target) != before or target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('restauração não preservou o banco original')
        return {'counts_preserved': after, 'integrity': integrity, 'foreign_key_errors': 0,
                'schema_version': version, 'backup_restore_checked': bool(backups),
                'environment': 'isolated_copy_of_local_database', 'source_modified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.source), ensure_ascii=False))
