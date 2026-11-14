"""Partial native app-server command execution and session lifecycle.

Explicit dangerFullAccess is required; PTY and sandbox enforcement are not
implemented. Based on fontes originais/app-server/src/command_exec.rs and
request_processors/command_exec_processor.rs, Apache-2.0; see LICENCA-TERCEIROS.txt and AVISOS-TERCEIROS.txt.
"""
import asyncio
import base64
import binascii
import os
import signal
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .rpc import RpcError

_NON_INHERITABLE = {"KODA_EXEC_SERVER_NOISE_AUTH_TOKEN", "NODE_REPL_AUTH_TOKEN",
                    "KODA_GUARDIAN_DECISIONS_API_KEY", "OPENAI_FEDERATION_RULE_ID",
                    "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"}
Notify = Callable[[str, Any], Awaitable[None]]


def _nao_herdar(nome: str) -> bool:
    normalizado = nome.upper()
    return normalizado in _NON_INHERITABLE or normalizado.endswith((
        "_EXEC_SERVER_NOISE_AUTH_TOKEN", "_GUARDIAN_DECISIONS_API_KEY"
    ))


@dataclass
class _Session:
    process: asyncio.subprocess.Process
    stream_stdin: bool
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _boolean(params, name):
    value = params.get(name, False)
    if not isinstance(value, bool):
        raise RpcError(-32600, f"{name} must be boolean")
    return value


def _kill(process):
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif process.returncode is None:
        process.kill()


class CommandManager:
    def __init__(self, notify: Notify | None = None):
        self.notify = notify
        self.sessions: dict[str, _Session | None] = {}

    async def run(self, params):
        if not isinstance(params, dict):
            raise RpcError(-32600, "command parameters must be an object")
        command = params.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(item, str) for item in command):
            raise RpcError(-32600, "command must be a non-empty array of strings")
        if params.get("sandboxPolicy") != {"type": "dangerFullAccess"} or params.get("permissionProfile") is not None:
            raise RpcError(-32600, "only explicit dangerFullAccess is implemented; sandbox policies are unavailable")
        tty = _boolean(params, "tty")
        stream_stdin = _boolean(params, "streamStdin")
        stream_output = _boolean(params, "streamStdoutStderr")
        disable_timeout = _boolean(params, "disableTimeout")
        disable_cap = _boolean(params, "disableOutputCap")
        if tty or params.get("size") is not None:
            raise RpcError(-32600, "PTY is not implemented")
        process_id = params.get("processId")
        if process_id is not None and not isinstance(process_id, str):
            raise RpcError(-32600, "processId must be a string")
        if (stream_stdin or stream_output) and process_id is None:
            raise RpcError(-32600, "streaming requires a client-supplied processId")
        if stream_output and self.notify is None:
            raise RpcError(-32600, "output streaming requires a notification transport")
        if disable_timeout and params.get("timeoutMs") is not None:
            raise RpcError(-32600, "cannot set both timeoutMs and disableTimeout")
        if disable_cap and params.get("outputBytesCap") is not None:
            raise RpcError(-32600, "cannot set both outputBytesCap and disableOutputCap")
        timeout = params.get("timeoutMs") if params.get("timeoutMs") is not None else 10000
        cap = params.get("outputBytesCap") if params.get("outputBytesCap") is not None else 1024 * 1024
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 0:
            raise RpcError(-32600, "timeoutMs must be a non-negative integer")
        if isinstance(cap, bool) or not isinstance(cap, int) or cap < 0:
            raise RpcError(-32600, "outputBytesCap must be a non-negative integer")
        environment = os.environ.copy()
        overrides = params.get("env") or {}
        if not isinstance(overrides, dict):
            raise RpcError(-32600, "env must be an object")
        for key, value in overrides.items():
            if not isinstance(key, str) or (value is not None and not isinstance(value, str)):
                raise RpcError(-32600, "environment variables must be strings or null")
            if value is None:
                environment.pop(key, None)
            else:
                environment[key] = value
        environment = {k: v for k, v in environment.items() if not _nao_herdar(k)}
        cwd = params.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            raise RpcError(-32600, "cwd must be a string")
        if process_id is not None:
            if process_id in self.sessions:
                raise RpcError(-32600, f"duplicate active command/exec process id: {process_id!r}")
            self.sessions[process_id] = None
        process = None
        output_tasks = []
        try:
            try:
                process = await asyncio.create_subprocess_exec(
                    *command, cwd=cwd, env=environment,
                    stdin=asyncio.subprocess.PIPE if stream_stdin else asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    start_new_session=(os.name == "posix"))
            except (OSError, ValueError) as error:
                raise RpcError(-32603, str(error)) from error
            if process_id is not None:
                self.sessions[process_id] = _Session(process, stream_stdin)

            async def drain(stream, label):
                chunks = bytearray()
                captured = 0
                reached = False
                while data := await stream.read(8192):
                    allowed = data if disable_cap else data[:max(0, cap - captured)]
                    captured += len(allowed)
                    now_reached = not disable_cap and captured == cap
                    if stream_output:
                        if allowed or (now_reached and not reached):
                            await self.notify("command/exec/outputDelta", {
                                "processId": process_id, "stream": label,
                                "deltaBase64": base64.b64encode(allowed).decode("ascii"),
                                "capReached": now_reached,
                            })
                    else:
                        chunks.extend(allowed)
                    reached |= now_reached
                return bytes(chunks).decode("utf-8", errors="replace")

            output_tasks = [asyncio.create_task(drain(process.stdout, "stdout")),
                            asyncio.create_task(drain(process.stderr, "stderr"))]
            timed_out = False
            try:
                await asyncio.wait_for(process.wait(), None if disable_timeout else timeout / 1000)
            except TimeoutError:
                timed_out = True
                _kill(process)
                await process.wait()
            out, err = await asyncio.gather(*output_tasks)
            return {"exitCode": 124 if timed_out else process.returncode, "stdout": out, "stderr": err}
        except BaseException:
            if process is not None:
                _kill(process)
                await process.wait()
            for task in output_tasks:
                task.cancel()
            if output_tasks:
                await asyncio.gather(*output_tasks, return_exceptions=True)
            raise
        finally:
            if process_id is not None:
                self.sessions.pop(process_id, None)

    def _session(self, params):
        if not isinstance(params, dict) or not isinstance(params.get("processId"), str):
            raise RpcError(-32600, "processId must be a string")
        session = self.sessions.get(params["processId"])
        if session is None:
            raise RpcError(-32600, f"no active command/exec for process id {params['processId']!r}")
        return session

    async def write(self, params):
        session = self._session(params)
        if not session.stream_stdin or session.process.stdin is None:
            raise RpcError(-32600, "stdin streaming is not enabled")
        close_stdin = _boolean(params, "closeStdin")
        encoded = params.get("deltaBase64")
        if encoded is None and not close_stdin:
            raise RpcError(-32600, "command/exec/write requires deltaBase64 or closeStdin")
        if encoded is not None and not isinstance(encoded, str):
            raise RpcError(-32600, "deltaBase64 must be a base64 string")
        try:
            data = base64.b64decode(encoded, validate=True) if encoded is not None else b""
        except (ValueError, binascii.Error) as error:
            raise RpcError(-32600, "invalid deltaBase64") from error
        try:
            async with session.write_lock:
                if data:
                    session.process.stdin.write(data)
                    await session.process.stdin.drain()
                if close_stdin:
                    session.process.stdin.close()
        except (BrokenPipeError, ConnectionResetError, RuntimeError) as error:
            raise RpcError(-32603, "process stdin is closed") from error
        return {}

    async def terminate(self, params):
        session = self._session(params)
        _kill(session.process)
        return {}


async def run_command(params):
    return await CommandManager().run(params)
