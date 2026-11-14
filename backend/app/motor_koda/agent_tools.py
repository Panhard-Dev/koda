"""Local tools for model turns. Mutations request approval through RPC.

This is a small initial tool set; it is not a replacement for sandbox,
full exec policy, or the upstream tool inventory.
"""
import asyncio
import hashlib
import json
import re
from pathlib import Path
import shlex
import time

from .commands import CommandManager
from .patch_files import ApplyFailure, apply_patch
from .patch_parser import ParseError
from .rpc import RpcError


def _function(name, description, properties, required):
    return {"type": "function", "function": {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties,
                           "required": required, "additionalProperties": False}}}


TOOLS = [
    _function("read_file", "Read a UTF-8 file inside the working directory (up to 65536 bytes).",
              {"path": {"type": "string"}}, ["path"]),
    _function("list_directory", "List a directory inside the working directory.",
              {"path": {"type": "string"}}, ["path"]),
    _function("shell_command", "Run an argv command in the working directory, subject to user approval.",
              {"command": {"type": "array", "items": {"type": "string"}},
               "cwd": {"type": "string"}}, ["command"]),
    _function("apply_patch", "Apply an apply_patch formatted patch, subject to user approval.",
              {"patch": {"type": "string"}}, ["patch"]),
]


def _inside(root, value):
    if not isinstance(value, str) or not value:
        raise ValueError("path must be a non-empty string")
    resolved_root = root.resolve(strict=True)
    path = (resolved_root / value).resolve(strict=True)
    if not path.is_relative_to(resolved_root):
        raise ValueError("path is outside the working directory")
    return path


def _read(root, args):
    path = _inside(root, args.get("path"))
    if not path.is_file():
        raise ValueError("path is not a regular file")
    with path.open("rb") as stream:
        data = stream.read(65537)
    return {"path": str(path), "text": data[:65536].decode("utf-8", errors="replace"), "truncated": len(data) > 65536}


def _list(root, args):
    path = _inside(root, args.get("path", "."))
    entries = sorted(path.iterdir(), key=lambda entry: entry.name)
    return {"path": str(path), "entries": [{"name": item.name, "type": "directory" if item.is_dir() else "file"}
                                             for item in entries[:1000]], "truncated": len(entries) > 1000}


class AgentTools:
    def __init__(self, peer, mcp):
        self.peer = peer
        self.mcp = mcp

    async def definitions(self):
        generation = self.mcp.generation
        status = await self.mcp.status({"detail": "toolsAndAuthOnly"})
        if generation != self.mcp.generation:
            raise RpcError(-32600, "MCP configuration changed during discovery")
        definitions, mapping = [], {}
        for server in status["data"]:
            if server["runtimeStatus"] != "connected":
                continue
            for tool_name, tool in sorted(server["tools"].items()):
                if len(definitions) >= 128:
                    return definitions, mapping, generation
                server_name = server["name"]
                raw = f"mcp__{server_name}__{tool_name}"
                candidate = re.sub(r"[^a-zA-Z0-9_-]", "_", raw)
                if len(candidate) > 64 or candidate in mapping:
                    suffix = hashlib.sha256((server_name + "\0" + tool_name).encode()).hexdigest()[:10]
                    candidate = candidate[:52] + "__" + suffix
                schema = tool["inputSchema"]
                if len(json.dumps(schema, ensure_ascii=False).encode()) > 32768:
                    continue
                description = tool.get("description")
                if not isinstance(description, str):
                    description = ""
                definitions.append({"type": "function", "function": {"name": candidate,
                    "description": f"MCP {server_name}: {description}"[:2048], "parameters": schema}})
                mapping[candidate] = (server_name, tool_name)
        if generation != self.mcp.generation:
            raise RpcError(-32600, "MCP configuration changed during discovery")
        return definitions, mapping, generation

    async def invoke(self, name, args, *, cwd, thread_id, turn_id, item_id,
                     mcp_mapping=None, mcp_generation=None):
        root = Path(cwd)
        if not isinstance(args, dict):
            return json.dumps({"error": "arguments must be a JSON object"}), False
        try:
            if mcp_mapping and name in mcp_mapping:
                if mcp_generation != self.mcp.generation:
                    raise RpcError(-32600, "MCP configuration changed since tool discovery")
                server, tool = mcp_mapping[name]
                arguments = json.dumps(args, ensure_ascii=False, sort_keys=True)
                approval = await self.peer.request("item/tool/requestUserInput", {
                    "threadId": thread_id, "turnId": turn_id, "itemId": item_id, "isBlocking": True,
                    "autoResolutionMs": None, "questions": [{"id": "mcp_approval", "header": "MCP",
                    "question": f"Executar ferramenta MCP {server}/{tool} com argumentos:\n{arguments}",
                    "isOther": False, "isSecret": False, "options": [
                        {"label": "Aprovar", "description": "Executar a chamada exibida."},
                        {"label": "Negar", "description": "Não executar a chamada."}]}]}, timeout=None)
                answer = ((approval.get("answers") or {}).get("mcp_approval") or {}).get("answers", []) if isinstance(approval, dict) else []
                if answer != ["Aprovar"]:
                    return json.dumps({"error": "MCP tool was not approved"}), False
                if mcp_generation != self.mcp.generation:
                    raise RpcError(-32600, "MCP configuration changed while awaiting approval")
                conn = await self.mcp.connection(server)
                result = await conn.call_tool(tool, args)
                serialized = json.dumps(result, ensure_ascii=False)
                if len(serialized.encode("utf-8")) > 1024 * 1024:
                    return json.dumps({"error": "MCP result exceeded 1 MiB"}), False
                return serialized, result.get("isError") is not True
            if name == "read_file":
                result = await asyncio.to_thread(_read, root, args)
            elif name == "list_directory":
                result = await asyncio.to_thread(_list, root, args)
            elif name == "shell_command":
                command = args.get("command")
                if not isinstance(command, list) or not command or not all(isinstance(part, str) for part in command):
                    raise ValueError("command must be a non-empty array of strings")
                working = _inside(root, args.get("cwd", "."))
                approval = await self.peer.request("item/commandExecution/requestApproval", {
                    "kind": "command", "threadId": thread_id, "turnId": turn_id, "itemId": item_id,
                    "startedAtMs": time.time_ns() // 1_000_000, "environmentId": None,
                    "command": shlex.join(command), "cwd": str(working), "reason": "Executar comando solicitado pelo modelo",
                    "commandActions": None}, timeout=None)
                if not isinstance(approval, dict) or approval.get("decision") not in ("accept", "acceptForSession"):
                    return json.dumps({"error": "command was not approved"}), False
                result = await CommandManager().run({"command": command, "cwd": str(working),
                    "timeoutMs": 10000, "outputBytesCap": 262144,
                    "sandboxPolicy": {"type": "dangerFullAccess"}})
            elif name == "apply_patch":
                patch = args.get("patch")
                if not isinstance(patch, str) or len(patch.encode("utf-8")) > 1024 * 1024:
                    raise ValueError("patch must be a UTF-8 string of at most 1 MiB")
                approval = await self.peer.request("item/fileChange/requestApproval", {
                    "threadId": thread_id, "turnId": turn_id, "itemId": item_id,
                    "startedAtMs": time.time_ns() // 1_000_000,
                    "reason": "Aplicar patch solicitado pelo modelo:\n" + patch}, timeout=None)
                if not isinstance(approval, dict) or approval.get("decision") not in ("accept", "acceptForSession"):
                    return json.dumps({"error": "patch was not approved"}), False
                result = {"summary": (await asyncio.to_thread(apply_patch, patch, root)).summary()}
            else:
                raise ValueError(f"unknown tool: {name}")
            return json.dumps(result, ensure_ascii=False), not (name == "shell_command" and result.get("exitCode") != 0)
        except ApplyFailure as error:
            return json.dumps({"error": str(error), "partialChanges": error.affected.summary()}, ensure_ascii=False), False
        except (OSError, ValueError, ParseError, RpcError) as error:
            return json.dumps({"error": str(error)}, ensure_ascii=False), False
