"""Local thread metadata persistence for the partial Python app-server.

Inspired by fontes originais/state's thread metadata and app-server protocol; this
isolated SQLite database is not the upstream state database or rollout format.
No model, turn execution, authentication, or sandbox is implemented here.
Apache-2.0; see LICENCA-TERCEIROS.txt and AVISOS-TERCEIROS.txt.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
import uuid

from .rpc import RpcError
from .model_client import DEFAULT_MODEL


def _id():
    # RFC 9562 UUIDv7: Unix milliseconds, version, random data and RFC variant.
    milliseconds = time.time_ns() // 1_000_000
    random = secrets.randbits(74)
    value = (milliseconds << 80) | (7 << 76) | ((random >> 62) << 64) | (2 << 62) | (random & ((1 << 62) - 1))
    return str(uuid.UUID(int=value))


def _encode_cursor(timestamp, thread_id):
    return base64.urlsafe_b64encode(json.dumps([timestamp, thread_id], separators=(",", ":")).encode()).decode()


def _decode_cursor(cursor):
    try:
        decoded = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if not isinstance(decoded, list) or len(decoded) != 2 or not isinstance(decoded[0], int) or not isinstance(decoded[1], str):
            raise ValueError
        return decoded
    except (ValueError, TypeError, UnicodeError) as error:
        raise RpcError(-32600, "invalid thread list cursor") from error


class ThreadStore:
    def __init__(self, home: Path):
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(home / "threads.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0, cwd TEXT NOT NULL, name TEXT, data TEXT NOT NULL
        )""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS turns (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(thread_id, turn_id)
        )""")
        self.db.commit()
        schema = self.db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'").fetchone()[0]
        if "turn_id TEXT NOT NULL UNIQUE" in schema:
            try:
                self.db.execute("BEGIN IMMEDIATE")
                self.db.execute("CREATE TABLE turns_new (sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(thread_id, turn_id))")
                self.db.execute("INSERT INTO turns_new(sequence,thread_id,turn_id,data) SELECT sequence,thread_id,turn_id,data FROM turns")
                self.db.execute("DROP TABLE turns")
                self.db.execute("ALTER TABLE turns_new RENAME TO turns")
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
        self.ephemeral = {}
        self.ephemeral_turns = {}
        self.active = set()
        self.loaded = set()

    def close(self):
        self.db.close()

    def create(self, params):
        if not isinstance(params, dict):
            raise RpcError(-32600, "thread/start params must be an object")
        allowed = {"cwd", "model", "modelProvider", "ephemeral", "sandbox"}
        unsupported = set(params) - allowed
        if unsupported:
            raise RpcError(-32600, f"thread/start options not yet supported: {', '.join(sorted(unsupported))}")
        cwd = params.get("cwd")
        if cwd is None:
            cwd = str(Path.cwd())
        if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
            raise RpcError(-32600, "cwd must be an existing absolute directory")
        ephemeral = params.get("ephemeral")
        if ephemeral is None:
            ephemeral = False
        if not isinstance(ephemeral, bool):
            raise RpcError(-32600, "ephemeral must be boolean")
        for field in ("model", "modelProvider"):
            if params.get(field) is not None and not isinstance(params[field], str):
                raise RpcError(-32600, f"{field} must be a string or null")
        if params.get("sandbox") not in (None, "danger-full-access"):
            raise RpcError(-32600, "only danger-full-access metadata is supported; sandbox is unavailable")
        now_ms = time.time_ns() // 1_000_000
        thread_id = _id()
        thread = {"id": thread_id, "sessionId": thread_id, "forkedFromId": None,
                  "parentThreadId": None, "preview": "", "ephemeral": ephemeral,
                  "section": None, "sectionEnteredAt": None, "projectId": None,
                  "historyMode": "legacy", "modelProvider": params.get("modelProvider") or "magpie",
                  "model": params.get("model") or os.environ.get("KODA_MOTOR_MODEL", DEFAULT_MODEL), "reasoningEffort": None,
                  "createdAt": now_ms // 1000, "updatedAt": now_ms // 1000,
                  "recencyAt": now_ms // 1000, "status": {"type": "idle"},
                  "path": None, "cwd": cwd, "cliVersion": "koda-motor/0.1.0",
                  "originator": "koda-motor", "source": "appServer", "threadSource": None,
                  "agentNickname": None, "agentRole": None, "gitInfo": None, "name": None, "turns": []}
        if ephemeral:
            self.ephemeral[thread_id] = thread
        else:
            with self.db:
                self.db.execute("INSERT INTO threads(id,created_ms,updated_ms,cwd,data) VALUES(?,?,?,?,?)",
                                (thread_id, now_ms, now_ms, cwd, json.dumps(thread, ensure_ascii=False)))
        self.loaded.add(thread_id)
        return thread

    def read(self, thread_id):
        if not isinstance(thread_id, str):
            raise RpcError(-32600, "threadId must be a string")
        if thread_id in self.ephemeral:
            thread = dict(self.ephemeral[thread_id])
            thread["status"] = {"type": "active", "activeFlags": []} if thread_id in self.active else {"type": "idle"}
            return thread
        row = self.db.execute("SELECT data FROM threads WHERE id=?", (thread_id,)).fetchone()
        if row is None:
            raise RpcError(-32600, f"thread not found: {thread_id}")
        thread = json.loads(row["data"])
        thread["status"] = ({"type": "active", "activeFlags": []} if thread_id in self.active else
                            {"type": "idle" if thread_id in self.loaded else "notLoaded"})
        return thread

    def require_unarchived(self, thread_id):
        self.read(thread_id)
        if thread_id not in self.ephemeral:
            row = self.db.execute("SELECT archived FROM threads WHERE id=?", (thread_id,)).fetchone()
            if row is not None and row["archived"]:
                raise RpcError(-32600, f"thread {thread_id} is archived; unarchive it first")

    def resume(self, thread_id):
        self.require_unarchived(thread_id)
        thread = self.read(thread_id)
        self.loaded.add(thread_id)
        if thread_id not in self.active:
            thread["status"] = {"type": "idle"}
        return thread

    def set_model(self, thread_id, model):
        thread = self.read(thread_id)
        thread["model"] = model
        if thread_id in self.ephemeral:
            self.ephemeral[thread_id] = thread
        else:
            with self.db:
                self.db.execute("UPDATE threads SET data=? WHERE id=?",
                                (json.dumps(thread, ensure_ascii=False), thread_id))

    def save_turn(self, thread_id, turn):
        thread = self.read(thread_id)
        if thread_id in self.ephemeral:
            turns = self.ephemeral_turns.setdefault(thread_id, [])
            for index, existing in enumerate(turns):
                if existing["id"] == turn["id"]:
                    turns[index] = json.loads(json.dumps(turn, ensure_ascii=False))
                    break
            else:
                turns.append(json.loads(json.dumps(turn, ensure_ascii=False)))
        now = time.time_ns() // 1_000_000
        thread["updatedAt"] = now // 1000
        thread["recencyAt"] = now // 1000
        if not thread["preview"]:
            for item in turn["items"]:
                if item.get("type") == "userMessage":
                    thread["preview"] = " ".join(part.get("text", "") for part in item.get("content", []) if part.get("type") == "text")[:256]
                    break
        thread["turns"] = []
        if thread_id in self.ephemeral:
            self.ephemeral[thread_id] = thread
        else:
            with self.db:
                result = self.db.execute("INSERT INTO turns(thread_id,turn_id,data) VALUES(?,?,?) ON CONFLICT(thread_id,turn_id) DO UPDATE SET data=excluded.data",
                                         (thread_id, turn["id"], json.dumps(turn, ensure_ascii=False)))
                if result.rowcount != 1:
                    raise ValueError("turn ID belongs to another thread")
                self.db.execute("UPDATE threads SET updated_ms=?,data=? WHERE id=?",
                                (now, json.dumps(thread, ensure_ascii=False), thread_id))

    def read_turns(self, thread_id):
        self.read(thread_id)
        if thread_id in self.ephemeral:
            return json.loads(json.dumps(self.ephemeral_turns.get(thread_id, []), ensure_ascii=False))
        rows = self.db.execute("SELECT data FROM turns WHERE thread_id=? ORDER BY sequence", (thread_id,)).fetchall()
        return [json.loads(row["data"]) for row in rows]

    def fork(self, params):
        if not isinstance(params, dict):
            raise RpcError(-32600, "thread/fork params must be an object")
        allowed = {"threadId", "lastTurnId", "model", "modelProvider", "cwd", "sandbox", "ephemeral", "excludeTurns"}
        if set(params) - allowed:
            raise RpcError(-32600, "unsupported thread/fork option")
        if params.get("excludeTurns") is not None and not isinstance(params["excludeTurns"], bool):
            raise RpcError(-32600, "excludeTurns must be boolean")
        source_id = params.get("threadId")
        self.require_unarchived(source_id)
        if source_id in self.active:
            raise RpcError(-32600, "cannot fork a thread with an active turn")
        source = self.read(source_id)
        turns = self.read_turns(source_id)
        last_turn = params.get("lastTurnId")
        if last_turn is not None:
            if not isinstance(last_turn, str):
                raise RpcError(-32600, "lastTurnId must be a string")
            try:
                last_index = next(index for index, turn in enumerate(turns) if turn["id"] == last_turn)
            except StopIteration as error:
                raise RpcError(-32600, "lastTurnId not found") from error
            turns = turns[:last_index + 1]
        new_params = {"cwd": params.get("cwd") or source["cwd"],
                      "model": params.get("model") or source["model"],
                      "modelProvider": params.get("modelProvider") or source["modelProvider"],
                      "ephemeral": params.get("ephemeral", False), "sandbox": params.get("sandbox")}
        fork = self.create(new_params)
        fork["forkedFromId"] = source_id
        fork["preview"] = source["preview"]
        if fork["id"] in self.ephemeral:
            self.ephemeral[fork["id"]] = fork
        else:
            with self.db:
                self.db.execute("UPDATE threads SET data=? WHERE id=?", (json.dumps(fork, ensure_ascii=False), fork["id"]))
        try:
            for turn in turns:
                self.save_turn(fork["id"], turn)
        except BaseException:
            self.delete(fork["id"], allow_ephemeral=True)
            raise
        fork = self.read(fork["id"])
        if not params.get("excludeTurns", False):
            fork["turns"] = self.read_turns(fork["id"])
        return fork

    def delete(self, thread_id, *, allow_ephemeral=False):
        self.read(thread_id)
        if thread_id in self.active:
            raise RpcError(-32600, "cannot delete a thread with an active turn")
        if thread_id in self.ephemeral:
            if not allow_ephemeral:
                raise RpcError(-32600, "ephemeral threads are not persisted")
            self.ephemeral.pop(thread_id, None)
            self.ephemeral_turns.pop(thread_id, None)
        else:
            with self.db:
                self.db.execute("DELETE FROM turns WHERE thread_id=?", (thread_id,))
                self.db.execute("DELETE FROM threads WHERE id=?", (thread_id,))
        self.loaded.discard(thread_id)

    def list_turns(self, thread_id, params):
        if set(params) - {"threadId", "cursor", "limit", "sortDirection", "itemsView"}:
            raise RpcError(-32600, "unsupported thread/turns/list option")
        limit = params.get("limit") if params.get("limit") is not None else 25
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise RpcError(-32600, "limit must be an integer from 1 to 100")
        direction = params.get("sortDirection") or "desc"
        view = params.get("itemsView") or "summary"
        if direction not in ("asc", "desc") or view not in ("notLoaded", "summary", "full"):
            raise RpcError(-32600, "invalid turn list direction or itemsView")
        turns = self.read_turns(thread_id)
        if direction == "desc":
            turns.reverse()
        cursor = params.get("cursor")
        if cursor is not None:
            if not isinstance(cursor, str):
                raise RpcError(-32600, "invalid turn cursor")
            try:
                turn_id = base64.b64decode(cursor, altchars=b"-_", validate=True).decode("utf-8")
                start = next(index for index, turn in enumerate(turns) if turn["id"] == turn_id) + 1
            except (ValueError, UnicodeError, StopIteration) as error:
                raise RpcError(-32600, "invalid turn cursor") from error
            turns = turns[start:]
        has_more = len(turns) > limit
        turns = turns[:limit]
        def cursor_for(turn):
            return base64.urlsafe_b64encode(turn["id"].encode()).decode()
        for turn in turns:
            if view == "notLoaded":
                turn["items"] = []
            elif view == "summary":
                user = next((item for item in turn["items"] if item.get("type") == "userMessage"), None)
                agent = next((item for item in reversed(turn["items"]) if item.get("type") == "agentMessage"), None)
                turn["items"] = [item for item in (user, agent) if item is not None]
            turn["itemsView"] = view
        return {"data": turns, "nextCursor": cursor_for(turns[-1]) if has_more else None,
                "backwardsCursor": cursor_for(turns[0]) if turns else None}

    def rename(self, thread_id, name):
        if not isinstance(name, str) or not name.strip():
            raise RpcError(-32600, "name must not be empty")
        self.require_unarchived(thread_id)
        thread = self.read(thread_id)
        thread["name"] = name.strip()
        now = time.time_ns() // 1_000_000
        thread["updatedAt"] = now // 1000
        thread["recencyAt"] = now // 1000
        if thread_id in self.ephemeral:
            self.ephemeral[thread_id] = thread
        else:
            with self.db:
                self.db.execute("UPDATE threads SET name=?, updated_ms=?, data=? WHERE id=?",
                                (thread["name"], now, json.dumps(thread, ensure_ascii=False), thread_id))

    def archive(self, thread_id, value):
        self.read(thread_id)
        if value and thread_id in self.active:
            raise RpcError(-32600, "cannot archive a thread with an active turn")
        if thread_id in self.ephemeral:
            raise RpcError(-32600, "ephemeral threads cannot be archived")
        with self.db:
            self.db.execute("UPDATE threads SET archived=? WHERE id=?", (int(value), thread_id))
        if value:
            self.loaded.discard(thread_id)

    def list(self, params):
        if not isinstance(params, dict):
            raise RpcError(-32600, "thread/list params must be an object")
        allowed = {"cursor", "limit", "sortKey", "sortDirection", "archived", "cwd", "searchTerm", "excludedThreadIds"}
        unsupported = set(params) - allowed
        if unsupported:
            raise RpcError(-32600, f"thread/list options not yet supported: {', '.join(sorted(unsupported))}")
        limit = params.get("limit") if params.get("limit") is not None else 25
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise RpcError(-32600, "limit must be an integer from 1 to 100")
        sort = params.get("sortKey") or "created_at"
        if sort not in ("created_at", "updated_at", "recency_at"):
            raise RpcError(-32600, "unsupported sortKey")
        column = "created_ms" if sort == "created_at" else "updated_ms"
        direction = params.get("sortDirection") or "desc"
        if direction not in ("asc", "desc"):
            raise RpcError(-32600, "invalid sortDirection")
        archived = params.get("archived")
        if archived is not None and not isinstance(archived, bool):
            raise RpcError(-32600, "archived must be boolean")
        clauses, values = ["archived=?"], [int(bool(archived))]
        cwd = params.get("cwd")
        if cwd is not None:
            paths = [cwd] if isinstance(cwd, str) else cwd
            if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
                raise RpcError(-32600, "cwd must be a string or non-empty array of strings")
            clauses.append("cwd IN (" + ",".join("?" for _ in paths) + ")")
            values.extend(paths)
        search = params.get("searchTerm")
        if search is not None:
            if not isinstance(search, str):
                raise RpcError(-32600, "searchTerm must be a string")
            clauses.append("instr(lower(coalesce(name,'')), lower(?)) > 0")
            values.append(search)
        excluded = params.get("excludedThreadIds") or []
        if not isinstance(excluded, list) or len(excluded) > 100 or not all(isinstance(item, str) for item in excluded):
            raise RpcError(-32600, "excludedThreadIds must be an array of at most 100 strings")
        if excluded:
            clauses.append("id NOT IN (" + ",".join("?" for _ in excluded) + ")")
            values.extend(excluded)
        cursor = params.get("cursor")
        if cursor is not None:
            if not isinstance(cursor, str):
                raise RpcError(-32600, "cursor must be a string")
            timestamp, thread_id = _decode_cursor(cursor)
            comparison = "<" if direction == "desc" else ">"
            clauses.append(f"({column}, id) {comparison} (?, ?)")
            values.extend((timestamp, thread_id))
        sql = f"SELECT id,{column} AS stamp,data FROM threads WHERE {' AND '.join(clauses)} ORDER BY {column} {direction}, id {direction} LIMIT ?"
        rows = self.db.execute(sql, (*values, limit + 1)).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        items = []
        for row in rows:
            item = json.loads(row["data"])
            item["status"] = ({"type": "active", "activeFlags": []} if item["id"] in self.active else
                              {"type": "idle" if item["id"] in self.loaded else "notLoaded"})
            items.append(item)
        return {"data": items,
                "nextCursor": _encode_cursor(rows[-1]["stamp"], rows[-1]["id"]) if has_more else None,
                "backwardsCursor": _encode_cursor(rows[0]["stamp"], rows[0]["id"]) if rows else None}
