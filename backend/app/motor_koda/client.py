"""Python client for this project's own local backend process."""
import asyncio
import os
from pathlib import Path
import sys

from .rpc import RpcPeer


class BackendClient:
    def __init__(self, process, *, approval_handler=None):
        self.process = process
        self.events = asyncio.Queue()
        self.approval_handler = approval_handler
        handlers = {}
        for method in ("thread/started", "thread/archived", "thread/unarchived", "thread/deleted", "thread/name/updated",
                       "thread/status/changed", "turn/started", "turn/completed", "item/started",
                       "item/completed", "item/agentMessage/delta", "command/exec/outputDelta"):
            handlers[method] = self._event_handler(method)
        for method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"):
            handlers[method] = self._approval_handler(method)
        self.peer = RpcPeer(process.stdout, process.stdin, handlers)
        self._service = asyncio.create_task(self.peer.serve())

    def _event_handler(self, method):
        async def handle(params):
            await self.events.put({"method": method, "params": params})
        return handle

    def _approval_handler(self, method):
        async def handle(params):
            if self.approval_handler is None:
                if method == "item/tool/requestUserInput":
                    return {"answers": {"mcp_approval": {"answers": ["Negar"]}}}
                return {"decision": "decline"}
            return await self.approval_handler(method, params)
        return handle

    @classmethod
    async def start(cls, *, cwd=None, home=None, model=None, base_url=None,
                    api=None, approval_handler=None):
        env = os.environ.copy()
        package_root = str(Path(__file__).resolve().parents[2])
        env["PYTHONPATH"] = package_root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        for key, value in (("KODA_MOTOR_HOME", home), ("KODA_MOTOR_MODEL", model),
                           ("KODA_MOTOR_MODEL_BASE_URL", base_url), ("KODA_MOTOR_MODEL_API", api)):
            if value is not None:
                env[key] = str(value)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "app.motor_koda.server", cwd=cwd, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        client = cls(process, approval_handler=approval_handler)
        try:
            await client.peer.request("initialize", {"clientInfo": {"name": "motor_koda_client", "version": "0.1.0"}})
            await client.peer.notify("initialized")
        except BaseException:
            await client.close()
            raise
        return client

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    async def request(self, method, params=None, *, timeout=30):
        return await self.peer.request(method, params, timeout=timeout)

    async def start_thread(self, **params):
        return await self.request("thread/start", params)

    async def start_turn(self, thread_id, text, **params):
        return await self.request("turn/start", {**params, "threadId": thread_id,
            "input": [{"type": "text", "text": text, "text_elements": []}]})

    async def close(self):
        await self.peer.close()
        try:
            await asyncio.wait_for(self.process.wait(), 5)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()
        await self._service
