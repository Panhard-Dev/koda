"""Bidirectional JSON-lines RPC transport, modeled after Koda app-server.

This module provides transport only; methods, storage, policy and sandbox enforcement must be supplied separately.
"""
import asyncio
from collections.abc import Awaitable, Callable
import itertools
import json
from typing import Any


Handler = Callable[[Any], Awaitable[Any]]


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        self.code, self.message, self.data = code, message, data
        super().__init__(message)

    def as_dict(self) -> dict[str, Any]:
        result = {"code": self.code, "message": self.message}
        if self.data is not None:
            result["data"] = self.data
        return result


class RpcPeer:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                 handlers: dict[str, Handler] | None = None, *, jsonrpc2: bool = False):
        self.reader, self.writer = reader, writer
        self.jsonrpc2 = jsonrpc2
        self.handlers = dict(handlers or {})
        self._pending: dict[int | str, asyncio.Future[Any]] = {}
        self._next_id = itertools.count(1)
        self._write_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        self._closed = False

    async def _send(self, message: dict[str, Any]) -> None:
        if self._closed:
            raise ConnectionError("RPC transport closed")
        if self.jsonrpc2:
            message = {"jsonrpc": "2.0", **message}
        encoded = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        async with self._write_lock:
            self.writer.write(encoded)
            await self.writer.drain()

    async def request(self, method: str, params: Any = None, *, timeout: float | None = 30,
                      notify_cancel: bool = False) -> Any:
        request_id = next(self._next_id)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        message: dict[str, Any] = {"id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        try:
            await self._send(message)
            try:
                return await asyncio.wait_for(future, timeout)
            except (asyncio.CancelledError, TimeoutError):
                if notify_cancel and self.jsonrpc2 and not self._closed:
                    try:
                        await asyncio.shield(self.notify("notifications/cancelled", {"requestId": request_id, "reason": "cancelled"}))
                    except (ConnectionError, OSError):
                        pass
                raise
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()

    async def notify(self, method: str, params: Any = None) -> None:
        message: dict[str, Any] = {"method": method}
        if params is not None:
            message["params"] = params
        await self._send(message)

    async def _handle(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        is_request = "id" in message
        handler = self.handlers.get(message["method"])
        if handler is None:
            if is_request:
                await self._send({"id": request_id, "error": RpcError(-32601, "Method not found").as_dict()})
            return
        try:
            result = await handler(message.get("params"))
            if is_request:
                await self._send({"id": request_id, "result": result})
        except RpcError as error:
            if is_request:
                await self._send({"id": request_id, "error": error.as_dict()})
        except Exception:
            if is_request:
                await self._send({"id": request_id, "error": RpcError(-32603, "Internal error").as_dict()})

    async def serve(self) -> None:
        try:
            while line := await self.reader.readline():
                try:
                    message = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    await self._send({"id": None, "error": RpcError(-32700, "Parse error").as_dict()})
                    continue
                if not isinstance(message, dict):
                    await self._send({"id": None, "error": RpcError(-32600, "Invalid request").as_dict()})
                    continue
                if self.jsonrpc2 and message.get("jsonrpc") != "2.0":
                    raise ValueError("invalid JSON-RPC version from peer")
                if "method" in message:
                    request_id = message.get("id")
                    if not isinstance(message["method"], str) or ("id" in message and
                       (isinstance(request_id, bool) or not isinstance(request_id, (str, int)))):
                        await self._send({"id": None, "error": RpcError(-32600, "Invalid request").as_dict()})
                        continue
                    task = asyncio.create_task(self._handle(message))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
                elif "id" in message:
                    request_id = message["id"]
                    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
                        continue
                    future = self._pending.get(request_id)
                    if future is None or future.done():
                        continue
                    if "error" in message and isinstance(message["error"], dict):
                        error = message["error"]
                        future.set_exception(RpcError(error.get("code", -32603), error.get("message", "RPC error"), error.get("data")))
                    elif "result" in message:
                        future.set_result(message["result"])
                    else:
                        future.set_exception(RpcError(-32600, "Invalid response"))
                else:
                    await self._send({"id": None, "error": RpcError(-32600, "Invalid request").as_dict()})
        finally:
            self._closed = True
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("RPC transport closed"))
            for task in self._tasks:
                task.cancel()
            if self._tasks:
                await asyncio.gather(*self._tasks, return_exceptions=True)

    async def close(self) -> None:
        self.writer.close()
        await self.writer.wait_closed()
