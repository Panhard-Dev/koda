"""Text-only model turn lifecycle for the partial Python app-server."""
import asyncio
import time
import json

from .agent_tools import AgentTools, TOOLS

from .model_client import ModelError, model_settings, stream_text
from .instructions import discover_instructions
from .rpc import RpcError
from .threads import _id


def _now_ms():
    return time.time_ns() // 1_000_000


class TurnManager:
    def __init__(self, store, peer, mcp):
        self.store = store
        self.peer = peer
        self.notify = peer.notify
        self.tools = AgentTools(peer, mcp)
        self.running = {}

    async def start(self, params):
        if not isinstance(params, dict):
            raise RpcError(-32600, "turn/start params must be an object")
        allowed = {"threadId", "input", "model", "clientUserMessageId"}
        unsupported = set(params) - allowed
        if unsupported:
            raise RpcError(-32600, f"turn/start options not yet supported: {', '.join(sorted(unsupported))}")
        thread_id = params.get("threadId")
        self.store.require_unarchived(thread_id)
        thread = self.store.read(thread_id)
        if thread_id in self.running:
            raise RpcError(-32600, "thread already has an active turn")
        entries = params.get("input")
        if not isinstance(entries, list) or not entries:
            raise RpcError(-32600, "input must contain text")
        if any(not isinstance(item, dict) or item.get("type") != "text" or not isinstance(item.get("text"), str) or
               set(item) - {"type", "text", "text_elements"} for item in entries):
            raise RpcError(-32600, "only text input is implemented")
        if not any(item["text"].strip() for item in entries):
            raise RpcError(-32600, "input must contain non-empty text")
        client_id = params.get("clientUserMessageId")
        if client_id is not None and not isinstance(client_id, str):
            raise RpcError(-32600, "clientUserMessageId must be a string")
        try:
            _, model, _ = model_settings(params.get("model") or thread["model"])
        except ModelError as error:
            raise RpcError(-32600, str(error)) from error
        if params.get("model") is not None:
            self.store.set_model(thread_id, model)
        try:
            instructions = discover_instructions(thread["cwd"])
        except OSError as error:
            raise RpcError(-32603, f"failed to load project instructions: {error}") from error
        history = []
        if instructions.text:
            history.append({"role": "system", "content": "Project instructions:\n" + instructions.text})
        for prior in self.store.read_turns(thread_id):
            if prior["status"] != "completed":
                continue
            items = prior["items"]
            index = 0
            while index < len(items):
                item = items[index]
                if item.get("type") == "userMessage":
                    text = "\n".join(part.get("text", "") for part in item.get("content", []) if part.get("type") == "text")
                    history.append({"role": "user", "content": text})
                elif item.get("type") == "agentMessage":
                    history.append({"role": "assistant", "content": item.get("text", "")})
                elif item.get("type") == "dynamicToolCall":
                    group = []
                    while index < len(items) and items[index].get("type") == "dynamicToolCall":
                        group.append(items[index])
                        index += 1
                    history.append({"role": "assistant", "content": None, "tool_calls": [
                        {"id": call["id"], "type": "function", "function": {"name": call["tool"],
                         "arguments": json.dumps(call["arguments"], ensure_ascii=False)}} for call in group]})
                    for call in group:
                        output = (call.get("contentItems") or [{"text": ""}])[0].get("text", "")
                        history.append({"role": "tool", "tool_call_id": call["id"], "content": output})
                    continue
                index += 1
        text = "\n".join(item["text"] for item in entries)
        history.append({"role": "user", "content": text})
        stamp = _now_ms()
        user_item = {"type": "userMessage", "id": _id(), "clientId": client_id,
                     "content": [{"type": "text", "text": entry["text"],
                                  "text_elements": entry.get("text_elements", [])} for entry in entries],
                     "startedAtMs": stamp, "completedAtMs": stamp}
        turn = {"id": _id(), "rootTurnId": None, "items": [user_item], "itemsView": "full",
                "status": "inProgress", "error": None, "startedAt": stamp // 1000,
                "completedAt": None, "durationMs": None}
        self.store.loaded.add(thread_id)
        self.store.active.add(thread_id)
        # Register before awaiting notifications to prevent overlapping turns.
        self.running[thread_id] = (turn["id"], None)
        try:
            self.store.save_turn(thread_id, turn)
            await self.notify("thread/status/changed", {"threadId": thread_id, "status": {"type": "active", "activeFlags": []}})
            await self.notify("turn/started", {"threadId": thread_id, "turn": turn})
            await self.notify("item/started", {"threadId": thread_id, "turnId": turn["id"], "item": user_item, "startedAtMs": stamp})
            await self.notify("item/completed", {"threadId": thread_id, "turnId": turn["id"], "item": user_item, "completedAtMs": stamp})
            task = asyncio.create_task(self._run(thread_id, turn, history, model, stamp))
            self.running[thread_id] = (turn["id"], task)
        except BaseException:
            self.running.pop(thread_id, None)
            self.store.active.discard(thread_id)
            turn["status"] = "interrupted"
            turn["completedAt"] = _now_ms() // 1000
            self.store.save_turn(thread_id, turn)
            raise
        return {"turn": turn}

    async def _run(self, thread_id, turn, history, model, started_ms):
        agent = None
        current_tool = None
        text_parts = []
        total_bytes = 0

        async def delta(text):
            nonlocal agent, total_bytes
            total_bytes += len(text.encode("utf-8"))
            if total_bytes > 8 * 1024 * 1024:
                raise ModelError("resposta excedeu o limite de texto")
            if agent is None:
                agent = {"type": "agentMessage", "id": _id(), "text": "", "phase": None,
                         "memoryCitation": None, "delivery": None, "questions": None,
                         "startedAtMs": _now_ms()}
                turn["items"].append(agent)
                await self.notify("item/started", {"threadId": thread_id, "turnId": turn["id"],
                                                   "item": agent, "startedAtMs": agent["startedAtMs"]})
            text_parts.append(text)
            await self.notify("item/agentMessage/delta", {"threadId": thread_id, "turnId": turn["id"],
                                                          "itemId": agent["id"], "delta": text})

        async def complete_agent():
            nonlocal agent, text_parts
            if agent is not None:
                agent["text"] = "".join(text_parts)
                agent["completedAtMs"] = _now_ms()
                await self.notify("item/completed", {"threadId": thread_id, "turnId": turn["id"],
                                                     "item": agent, "completedAtMs": agent["completedAtMs"]})
                agent = None
                text_parts = []

        try:
            _, _, api = model_settings(model)
            definitions, mcp_mapping, mcp_generation = ([], {}, None)
            if api == "chat":
                try:
                    definitions, mcp_mapping, mcp_generation = await self.tools.definitions()
                except RpcError as error:
                    raise ModelError(f"falha ao descobrir ferramentas MCP: {error}") from error
            for _ in range(32):
                response = await stream_text(history, model, delta, TOOLS + definitions if api == "chat" else None)
                await complete_agent()
                if not response.tool_calls:
                    turn["status"] = "completed"
                    break
                history.append({"role": "assistant", "content": response.text or None,
                                "tool_calls": response.tool_calls})
                for call in response.tool_calls:
                    function = call["function"]
                    try:
                        arguments = json.loads(function["arguments"])
                        valid = isinstance(arguments, dict)
                    except (ValueError, TypeError):
                        arguments, valid = {"_invalid": function["arguments"]}, False
                    current_tool = {"type": "dynamicToolCall", "id": call["id"], "namespace": None,
                                    "tool": function["name"], "arguments": arguments,
                                    "status": "inProgress", "contentItems": None, "success": None,
                                    "startedAtMs": _now_ms()}
                    turn["items"].append(current_tool)
                    self.store.save_turn(thread_id, turn)
                    await self.notify("item/started", {"threadId": thread_id, "turnId": turn["id"],
                        "item": current_tool, "startedAtMs": current_tool["startedAtMs"]})
                    if valid:
                        output, success = await self.tools.invoke(function["name"], arguments,
                            cwd=self.store.read(thread_id)["cwd"], thread_id=thread_id,
                            turn_id=turn["id"], item_id=current_tool["id"],
                            mcp_mapping=mcp_mapping, mcp_generation=mcp_generation)
                    else:
                        output, success = json.dumps({"error": "invalid JSON object arguments"}), False
                    current_tool["status"] = "completed" if success else "failed"
                    current_tool["success"] = success
                    current_tool["contentItems"] = [{"type": "inputText", "text": output}]
                    current_tool["completedAtMs"] = _now_ms()
                    self.store.save_turn(thread_id, turn)
                    await self.notify("item/completed", {"threadId": thread_id, "turnId": turn["id"],
                        "item": current_tool, "completedAtMs": current_tool["completedAtMs"]})
                    history.append({"role": "tool", "tool_call_id": call["id"], "content": output})
                    current_tool = None
            else:
                raise ModelError("limite de 32 chamadas ao modelo por turno atingido")
        except asyncio.CancelledError:
            turn["status"] = "interrupted"
        except Exception as error:
            turn["status"] = "failed"
            message = str(error) if isinstance(error, ModelError) else "falha interna na execução do turno"
            turn["error"] = {"message": message, "kodaErrorInfo": None, "additionalDetails": None, "misalignment": None}
        finally:
            ended_ms = _now_ms()
            turn["completedAt"] = ended_ms // 1000
            turn["durationMs"] = max(0, ended_ms - started_ms)
            if agent is not None:
                agent["text"] = "".join(text_parts)
                agent["completedAtMs"] = ended_ms
            if current_tool is not None and current_tool["status"] == "inProgress":
                current_tool["status"] = "failed"
                current_tool["success"] = False
                current_tool["contentItems"] = [{"type": "inputText", "text": '{"error":"turn interrupted"}'}]
                current_tool["completedAtMs"] = ended_ms
            self.store.active.discard(thread_id)
            try:
                self.store.save_turn(thread_id, turn)
            finally:
                self.running.pop(thread_id, None)
            try:
                if agent is not None:
                    await self.notify("item/completed", {"threadId": thread_id, "turnId": turn["id"],
                                                         "item": agent, "completedAtMs": ended_ms})
                if current_tool is not None:
                    await self.notify("item/completed", {"threadId": thread_id, "turnId": turn["id"],
                                                        "item": current_tool, "completedAtMs": ended_ms})
                await self.notify("turn/completed", {"threadId": thread_id, "turn": turn})
                await self.notify("thread/status/changed", {"threadId": thread_id, "status": {"type": "idle"}})
            except (ConnectionError, BrokenPipeError, RuntimeError):
                pass

    async def interrupt(self, params):
        if not isinstance(params, dict) or not isinstance(params.get("threadId"), str) or not isinstance(params.get("turnId"), str):
            raise RpcError(-32600, "threadId and turnId are required")
        entry = self.running.get(params["threadId"])
        if entry is None or entry[0] != params["turnId"] or entry[1] is None:
            raise RpcError(-32600, "turn is not active")
        entry[1].cancel()
        await entry[1]
        return {}

    async def close(self):
        tasks = [task for _, task in self.running.values() if task is not None]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
