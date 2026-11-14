"""Partial native Koda-compatible app-server over stdin/stdout.

Partial filesystem, command and thread metadata methods are implemented.
This server operates with the invoking user's filesystem permissions, without
user authentication; model turns and tool approvals are partially implemented.
The Koda sandbox is not implemented.
"""
import asyncio
import base64
import binascii
import os
from pathlib import Path
import shutil
import stat
import sys

from .commands import CommandManager
from .instructions import discover_instructions
from .mcp_stdio import McpManager
from .rpc import RpcError, RpcPeer
from .threads import ThreadStore
from .turns import TurnManager


def _path(params, key="path"):
    if not isinstance(params, dict) or not isinstance(params.get(key), str):
        raise RpcError(-32600, f"{key} must be an absolute path")
    path = Path(params[key])
    if not path.is_absolute():
        raise RpcError(-32600, f"{key} must be an absolute path")
    return path


def _option(params, key, default):
    value = params.get(key)
    if value is None:
        return default
    if not isinstance(value, bool):
        raise RpcError(-32600, f"{key} must be boolean")
    return value


def _filesystem(method, params):
    path = _path(params, "sourcePath" if method == "fs/copy" else "path")
    try:
        if method == "fs/copy":
            destination = _path(params, "destinationPath")
            recursive = _option(params, "recursive", False)
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                if not recursive:
                    raise RpcError(-32600, "fs/copy requires recursive: true when sourcePath is a directory")
                source_real = path.resolve(strict=True)
                destination_real = destination.resolve(strict=False)
                if destination_real == source_real or source_real in destination_real.parents:
                    raise RpcError(-32600, "fs/copy cannot copy a directory to itself or one of its descendants")
                shutil.copytree(path, destination, symlinks=True, dirs_exist_ok=True)
            elif stat.S_ISLNK(mode):
                os.symlink(os.readlink(path), destination, target_is_directory=path.is_dir())
            elif stat.S_ISREG(mode):
                shutil.copyfile(path, destination)
                shutil.copymode(path, destination)
            else:
                raise RpcError(-32600, "fs/copy only supports regular files, directories, and symlinks")
            return {}
        if method == "fs/readFile":
            return {"dataBase64": base64.b64encode(path.read_bytes()).decode("ascii")}
        if method == "fs/writeFile":
            data = params.get("dataBase64")
            if not isinstance(data, str):
                raise RpcError(-32600, "dataBase64 must be a base64 string")
            try:
                decoded = base64.b64decode(data, validate=True)
            except (ValueError, binascii.Error) as error:
                raise RpcError(-32600, "fs/writeFile requires valid base64 dataBase64") from error
            path.write_bytes(decoded)
            return {}
        if method == "fs/createDirectory":
            recursive = _option(params, "recursive", True)
            path.mkdir(parents=recursive, exist_ok=recursive)
            return {}
        if method == "fs/getMetadata":
            info = path.stat()
            return {"isDirectory": stat.S_ISDIR(info.st_mode), "isFile": stat.S_ISREG(info.st_mode),
                    "isSymlink": path.is_symlink(), "createdAtMs": int(getattr(info, "st_birthtime", 0) * 1000),
                    "modifiedAtMs": int(info.st_mtime * 1000)}
        if method == "fs/readDirectory":
            entries = []
            for entry in path.iterdir():
                try:
                    info = entry.stat()
                except OSError:
                    continue
                entries.append({"fileName": entry.name, "isDirectory": stat.S_ISDIR(info.st_mode),
                                "isFile": stat.S_ISREG(info.st_mode)})
            return {"entries": entries}
        if method == "fs/remove":
            recursive = _option(params, "recursive", True)
            force = _option(params, "force", True)
            try:
                info = path.lstat()
            except FileNotFoundError:
                if force:
                    return {}
                raise
            if stat.S_ISDIR(info.st_mode):
                if recursive:
                    shutil.rmtree(path)
                else:
                    path.rmdir()
            else:
                path.unlink()
            return {}
    except OSError as error:
        raise RpcError(-32603, str(error)) from error
    raise RpcError(-32601, "Method not found")


class AppServer:
    def __init__(self, peer: RpcPeer, koda_home: Path):
        self.peer, self.koda_home, self.initialized = peer, koda_home, False
        self._threads = None
        self._turns = None
        self._mcp = None
        peer.handlers["initialize"] = self.initialize
        peer.handlers["initialized"] = self.initialized_notification
        self.commands = CommandManager(peer.notify)
        peer.handlers["command/exec"] = self.command_exec
        peer.handlers["command/exec/write"] = self.command_write
        peer.handlers["command/exec/terminate"] = self.command_terminate
        peer.handlers["turn/start"] = self.turn_start
        peer.handlers["turn/interrupt"] = self.turn_interrupt
        for method in ("config/mcpServer/reload", "mcpServerStatus/list", "mcpServer/tool/call", "mcpServer/resource/read"):
            peer.handlers[method] = self._make_mcp_handler(method)
        for method in ("thread/start", "thread/read", "thread/resume", "thread/list",
                       "thread/name/set", "thread/archive", "thread/unarchive", "thread/turns/list", "thread/fork", "thread/delete"):
            peer.handlers[method] = self._make_thread_handler(method)
        for method in ("fs/readFile", "fs/writeFile", "fs/createDirectory", "fs/getMetadata",
                       "fs/readDirectory", "fs/remove", "fs/copy"):
            peer.handlers[method] = self._make_fs_handler(method)

    async def initialize(self, params):
        if self.initialized:
            raise RpcError(-32600, "Already initialized")
        if not isinstance(params, dict) or not isinstance(params.get("clientInfo"), dict):
            raise RpcError(-32600, "clientInfo is required")
        client = params["clientInfo"]
        if not all(isinstance(client.get(field), str) for field in ("name", "version")):
            raise RpcError(-32600, "clientInfo name and version are required")
        self.initialized = True
        return {"userAgent": "koda-motor/0.1.0", "kodaHome": str(self.koda_home),
                "platformFamily": "windows" if os.name == "nt" else "unix", "platformOs": sys.platform}

    async def initialized_notification(self, params):
        return None

    async def command_exec(self, params):
        if not self.initialized:
            raise RpcError(-32600, "Not initialized")
        return await self.commands.run(params)

    async def command_write(self, params):
        if not self.initialized:
            raise RpcError(-32600, "Not initialized")
        return await self.commands.write(params)

    async def command_terminate(self, params):
        if not self.initialized:
            raise RpcError(-32600, "Not initialized")
        return await self.commands.terminate(params)

    @property
    def threads(self):
        if self._threads is None:
            self._threads = ThreadStore(self.koda_home)
        return self._threads

    @property
    def turns(self):
        if self._turns is None:
            self._turns = TurnManager(self.threads, self.peer, self.mcp)
        return self._turns

    @property
    def mcp(self):
        if self._mcp is None:
            self._mcp = McpManager(self.koda_home)
        return self._mcp

    async def close(self):
        if self._turns is not None:
            await self._turns.close()
        if self._mcp is not None:
            await self._mcp.close()
        if self._threads is not None:
            self._threads.close()

    def _make_mcp_handler(self, method):
        async def handler(params):
            if not self.initialized:
                raise RpcError(-32600, "Not initialized")
            params = {} if params is None else params
            if not isinstance(params, dict):
                raise RpcError(-32600, "MCP params must be an object")
            if method == "config/mcpServer/reload":
                if params:
                    raise RpcError(-32600, "reload does not accept parameters")
                return await self.mcp.reload()
            if method == "mcpServerStatus/list":
                return await self.mcp.status(params)
            server = params.get("server")
            if not isinstance(server, str) or not server:
                raise RpcError(-32600, "server must be a string")
            if method == "mcpServer/tool/call":
                if set(params) - {"threadId", "server", "tool", "arguments", "_meta"}:
                    raise RpcError(-32600, "unsupported MCP tool call option")
                thread_id, tool = params.get("threadId"), params.get("tool")
                self.threads.require_unarchived(thread_id)
                if not isinstance(tool, str) or not tool:
                    raise RpcError(-32600, "tool must be a string")
                arguments = params.get("arguments")
                if arguments is None:
                    arguments = {}
                if not isinstance(arguments, dict):
                    raise RpcError(-32600, "arguments must be an object")
                meta = params.get("_meta")
                if meta is not None and not isinstance(meta, dict):
                    raise RpcError(-32600, "_meta must be an object")
                conn = await self.mcp.connection(server)
                return await conn.call_tool(tool, arguments, meta)
            if method == "mcpServer/resource/read":
                if set(params) - {"threadId", "server", "uri", "_meta"}:
                    raise RpcError(-32600, "unsupported MCP resource option")
                if params.get("threadId") is not None:
                    self.threads.require_unarchived(params["threadId"])
                uri, meta = params.get("uri"), params.get("_meta")
                if not isinstance(uri, str) or not uri:
                    raise RpcError(-32600, "uri must be a string")
                if meta is not None and not isinstance(meta, dict):
                    raise RpcError(-32600, "_meta must be an object")
                if isinstance(meta, dict) and any(key in meta for key in ("x-koda-turn-metadata", "x-koda-thread-id", "x-koda-connection-lease")):
                    raise RpcError(-32600, "reserved resource metadata key")
                conn = await self.mcp.connection(server)
                return await conn.read_resource(uri, meta)
            raise RpcError(-32601, "Method not found")
        return handler

    async def turn_start(self, params):
        if not self.initialized:
            raise RpcError(-32600, "Not initialized")
        return await self.turns.start(params)

    async def turn_interrupt(self, params):
        if not self.initialized:
            raise RpcError(-32600, "Not initialized")
        return await self.turns.interrupt(params)

    def _make_thread_handler(self, method):
        async def handler(params):
            if not self.initialized:
                raise RpcError(-32600, "Not initialized")
            params = {} if params is None else params
            if not isinstance(params, dict):
                raise RpcError(-32600, "thread params must be an object")
            if method == "thread/start":
                thread = self.threads.create(params)
                await self.peer.notify("thread/started", {"thread": thread})
                return self._thread_response(thread)
            if method == "thread/list":
                return self.threads.list(params)
            if method == "thread/fork":
                thread = self.threads.fork(params)
                started = {**thread, "turns": []}
                await self.peer.notify("thread/started", {"thread": started})
                return self._thread_response(thread)
            thread_id = params.get("threadId")
            if not isinstance(thread_id, str):
                raise RpcError(-32600, "threadId must be a string")
            if method == "thread/turns/list":
                return self.threads.list_turns(thread_id, params)
            if method == "thread/read":
                if set(params) - {"threadId", "includeTurns"}:
                    raise RpcError(-32600, "unsupported thread/read option")
                thread = self.threads.read(thread_id)
                if _option(params, "includeTurns", False):
                    thread["turns"] = self.threads.read_turns(thread_id)
                return {"thread": thread}
            if method == "thread/resume":
                if set(params) - {"threadId", "excludeTurns"}:
                    raise RpcError(-32600, "unsupported thread/resume option")
                thread = self.threads.resume(thread_id)
                if not _option(params, "excludeTurns", False):
                    thread["turns"] = self.threads.read_turns(thread_id)
                return {**self._thread_response(thread), "collaborationMode": None,
                        "turnsBackwardsCursor": None, "itemsBackwardsCursor": None}
            if method == "thread/name/set":
                self.threads.rename(thread_id, params.get("name"))
                name = self.threads.read(thread_id)["name"]
                await self.peer.notify("thread/name/updated", {"threadId": thread_id, "threadName": name})
                return {}
            if method == "thread/delete":
                self.threads.delete(thread_id)
                await self.peer.notify("thread/deleted", {"threadId": thread_id})
                return {}
            if method == "thread/archive":
                self.threads.archive(thread_id, True)
                await self.peer.notify("thread/archived", {"threadId": thread_id})
                return {}
            if method == "thread/unarchive":
                self.threads.archive(thread_id, False)
                await self.peer.notify("thread/unarchived", {"threadId": thread_id})
                return {"thread": self.threads.read(thread_id)}
            raise RpcError(-32601, "Method not found")
        return handler

    @staticmethod
    def _thread_response(thread):
        try:
            sources = [str(entry.path) for entry in discover_instructions(thread["cwd"]).entries]
        except OSError:
            sources = []
        return {"thread": thread, "model": thread["model"] or "", "modelProvider": thread["modelProvider"],
                "serviceTier": None, "disabledPluginIds": [], "cwd": thread["cwd"],
                "instructionSources": sources, "approvalPolicy": "on-request", "approvalsReviewer": "user",
                "sandbox": {"type": "dangerFullAccess"}, "reasoningEffort": None}

    def _make_fs_handler(self, method):
        async def handler(params):
            if not self.initialized:
                raise RpcError(-32600, "Not initialized")
            return await asyncio.to_thread(_filesystem, method, params)
        return handler


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=16 * 1024 * 1024)
    reader_protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin.buffer)
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
    writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    peer = RpcPeer(reader, writer)
    home = Path(os.environ.get("KODA_MOTOR_HOME", "~/.koda-motor")).expanduser().absolute()
    server = AppServer(peer, home)
    try:
        await peer.serve()
    finally:
        await server.close()


if __name__ == "__main__":
    asyncio.run(main())
