"""Partial MCP client and manager for configured local stdio servers.

Implements the 2025-06-18 handshake, tool discovery/calls and resource reads.
HTTP, OAuth, sampling, elicitation and model exposure are not implemented.
"""
import asyncio
import math
import os
from pathlib import Path
import signal
import tomllib

from .commands import _nao_herdar
from .rpc import RpcError, RpcPeer

_DEFAULT_ENV = ("HOME", "LOGNAME", "PATH", "SHELL", "USER", "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ")
_CA_ENV = ("KODA_CA_CERTIFICATE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO", "CARGO_HTTP_CAINFO", "PIP_CERT", "BUNDLE_SSL_CA_CERT", "npm_config_cafile", "NPM_CONFIG_CAFILE")
_SUPPORTED_VERSIONS = {"2025-06-18", "2025-03-26", "2024-11-05"}
_ALLOWED_CONFIG = {"command", "args", "cwd", "env", "env_vars", "enabled", "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec", "enabled_tools", "disabled_tools"}


def _duration(value, name, default):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise RpcError(-32600, f"{name} must be a positive finite number")
    return float(value)


def _config(home):
    file = home / "config.toml"
    try:
        with file.open("rb") as stream:
            data = tomllib.load(stream)
    except FileNotFoundError:
        return {}
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise RpcError(-32600, f"invalid MCP config: {error}") from error
    servers = data.get("mcp_servers", {})
    if not isinstance(servers, dict):
        raise RpcError(-32600, "mcp_servers must be a table")
    result = {}
    for name, raw in servers.items():
        if not isinstance(name, str) or not name or not isinstance(raw, dict):
            raise RpcError(-32600, "invalid MCP server entry")
        unknown = set(raw) - _ALLOWED_CONFIG
        if unknown:
            raise RpcError(-32600, f"unsupported MCP settings for {name}: {', '.join(sorted(unknown))}")
        enabled = raw.get("enabled", True)
        if not isinstance(enabled, bool):
            raise RpcError(-32600, f"MCP server {name}: enabled must be boolean")
        command = raw.get("command")
        if enabled and (not isinstance(command, str) or not command):
            raise RpcError(-32600, f"MCP server {name}: command is required")
        args = raw.get("args", [])
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise RpcError(-32600, f"MCP server {name}: args must be an array of strings")
        cwd = raw.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            raise RpcError(-32600, f"MCP server {name}: cwd must be a string")
        extra_env = raw.get("env", {})
        if not isinstance(extra_env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in extra_env.items()):
            raise RpcError(-32600, f"MCP server {name}: env must contain strings")
        env_vars = raw.get("env_vars", [])
        if not isinstance(env_vars, list):
            raise RpcError(-32600, f"MCP server {name}: env_vars must be an array")
        inherited = []
        for entry in env_vars:
            if isinstance(entry, str):
                inherited.append(entry)
            elif isinstance(entry, dict) and set(entry) <= {"name", "source"} and isinstance(entry.get("name"), str) and entry.get("source", "local") == "local":
                inherited.append(entry["name"])
            else:
                raise RpcError(-32600, f"MCP server {name}: invalid local env_vars entry")
        allow, deny = raw.get("enabled_tools"), raw.get("disabled_tools", [])
        if allow is not None and (not isinstance(allow, list) or not all(isinstance(x, str) for x in allow)):
            raise RpcError(-32600, f"MCP server {name}: enabled_tools must be an array of strings")
        if not isinstance(deny, list) or not all(isinstance(x, str) for x in deny):
            raise RpcError(-32600, f"MCP server {name}: disabled_tools must be an array of strings")
        if raw.get("startup_timeout_ms") is not None and raw.get("startup_timeout_sec") is not None:
            raise RpcError(-32600, f"MCP server {name}: conflicting startup timeout settings")
        startup = _duration(raw.get("startup_timeout_sec"), "startup_timeout_sec", 10)
        if raw.get("startup_timeout_ms") is not None:
            startup = _duration(raw["startup_timeout_ms"], "startup_timeout_ms", 10000) / 1000
        result[name] = {"enabled": enabled, "command": command, "args": args, "cwd": cwd,
                        "env": extra_env, "env_vars": inherited, "allow": allow, "deny": deny,
                        "startup": startup, "timeout": _duration(raw.get("tool_timeout_sec"), "tool_timeout_sec", 60)}
    return result


def _environment(config):
    names = (*_DEFAULT_ENV, *_CA_ENV, *config["env_vars"])
    env = {name: os.environ[name] for name in names if name in os.environ and not _nao_herdar(name)}
    env.update({name: value for name, value in config["env"].items() if not _nao_herdar(name)})
    return env


class McpConnection:
    def __init__(self, process, config):
        self.process = process
        self.config = config
        async def ping(params):
            return {}
        self.peer = RpcPeer(process.stdout, process.stdin, {"ping": ping}, jsonrpc2=True)
        self.service = asyncio.create_task(self.peer.serve())
        self.server_info = None
        self.capabilities = {}
        self.protocol_version = None
        self.list_meta = None

    @classmethod
    async def start(cls, config):
        try:
            process = await asyncio.create_subprocess_exec(config["command"], *config["args"], cwd=config["cwd"],
                env=_environment(config), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                start_new_session=(os.name == "posix"), limit=16 * 1024 * 1024)
        except (OSError, ValueError) as error:
            raise RpcError(-32603, f"failed to start MCP process: {error}") from error
        connection = cls(process, config)
        try:
            result = await connection.peer.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "koda-motor", "version": "0.1.0"}}, timeout=config["startup"])
            if not isinstance(result, dict) or result.get("protocolVersion") not in _SUPPORTED_VERSIONS or not isinstance(result.get("capabilities"), dict) or not isinstance(result.get("serverInfo"), dict):
                raise RpcError(-32603, "MCP initialize returned unsupported or invalid response")
            connection.protocol_version = result["protocolVersion"]
            connection.server_info = result["serverInfo"]
            connection.capabilities = result["capabilities"]
            await connection.peer.notify("notifications/initialized")
            return connection
        except BaseException:
            await connection.close()
            raise

    async def _pages(self, method, field):
        items, cursor, seen = [], None, set()
        for _ in range(100):
            result = await self.peer.request(method, {"cursor": cursor} if cursor else {}, timeout=self.config["timeout"], notify_cancel=True)
            if not isinstance(result, dict) or not isinstance(result.get(field), list):
                raise RpcError(-32603, f"MCP {method} returned invalid result")
            if method == "tools/list" and cursor is None:
                self.list_meta = result.get("_meta")
            items.extend(result[field])
            if len(items) > 10000:
                raise RpcError(-32603, f"MCP {method} exceeded item limit")
            cursor = result.get("nextCursor")
            if cursor is None:
                return items
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise RpcError(-32603, f"MCP {method} returned invalid cursor")
            seen.add(cursor)
        raise RpcError(-32603, f"MCP {method} exceeded page limit")

    async def tools(self):
        if "tools" not in self.capabilities:
            return {}
        entries = await self._pages("tools/list", "tools")
        output = {}
        for tool in entries:
            if not isinstance(tool, dict) or not isinstance(tool.get("name"), str) or not tool["name"] or not isinstance(tool.get("inputSchema"), dict):
                raise RpcError(-32603, "MCP tools/list returned invalid tool")
            name = tool["name"]
            if (self.config["allow"] is None or name in self.config["allow"]) and name not in self.config["deny"]:
                if name in output:
                    raise RpcError(-32603, "MCP tools/list returned duplicate names")
                output[name] = tool
        return output

    async def resources(self):
        if "resources" not in self.capabilities:
            return [], []
        resources = await self._pages("resources/list", "resources")
        templates = await self._pages("resources/templates/list", "resourceTemplates")
        return resources, templates

    async def call_tool(self, tool, arguments, meta=None):
        if tool not in await self.tools():
            raise RpcError(-32600, f"MCP tool is unavailable: {tool}")
        params = {"name": tool, "arguments": arguments}
        if meta is not None:
            params["_meta"] = meta
        result = await self.peer.request("tools/call", params, timeout=self.config["timeout"], notify_cancel=True)
        if not isinstance(result, dict) or not isinstance(result.get("content"), list):
            raise RpcError(-32603, "MCP tools/call returned invalid result")
        return result

    async def read_resource(self, uri, meta=None):
        if "resources" not in self.capabilities:
            raise RpcError(-32600, "MCP server does not advertise resources")
        params = {"uri": uri}
        if meta is not None:
            params["_meta"] = meta
        result = await self.peer.request("resources/read", params, timeout=self.config["timeout"], notify_cancel=True)
        if not isinstance(result, dict) or not isinstance(result.get("contents"), list):
            raise RpcError(-32603, "MCP resources/read returned invalid result")
        return {"contents": result["contents"], "originCallId": None}

    async def close(self):
        await self.peer.close()
        if self.process.returncode is None:
            try:
                await asyncio.wait_for(self.process.wait(), 2)
            except TimeoutError:
                if os.name == "posix":
                    try:
                        os.killpg(self.process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                else:
                    self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), 2)
                except TimeoutError:
                    if os.name == "posix":
                        try:
                            os.killpg(self.process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    else:
                        self.process.kill()
                    await self.process.wait()
        await asyncio.gather(self.service, return_exceptions=True)


class McpManager:
    def __init__(self, home: Path):
        self.home = home
        self.config = None
        self.connections = {}
        self.locks = {}
        self.generation = 0

    async def reload(self):
        config = _config(self.home)
        self.generation += 1
        connections, self.connections = list(self.connections.values()), {}
        self.config = config
        if connections:
            await asyncio.gather(*(connection.close() for connection in connections), return_exceptions=True)
        return {}

    async def _ensure_config(self):
        if self.config is None:
            self.config = _config(self.home)

    async def connection(self, name):
        await self._ensure_config()
        if not isinstance(name, str) or name not in self.config:
            raise RpcError(-32600, f"unknown MCP server: {name}")
        if not self.config[name]["enabled"]:
            raise RpcError(-32600, f"MCP server is disabled: {name}")
        lock = self.locks.setdefault(name, asyncio.Lock())
        async with lock:
            if name not in self.config or not self.config[name]["enabled"]:
                raise RpcError(-32600, "MCP configuration changed")
            generation = self.generation
            existing = self.connections.get(name)
            if existing and (existing.process.returncode is not None or existing.peer._closed):
                await existing.close()
                self.connections.pop(name, None)
                existing = None
            if existing is None:
                existing = await McpConnection.start(self.config[name])
                if generation != self.generation:
                    await existing.close()
                    raise RpcError(-32600, "MCP configuration changed during startup")
                self.connections[name] = existing
            return existing

    async def status(self, params):
        await self._ensure_config()
        if not isinstance(params, dict):
            raise RpcError(-32600, "MCP status params must be an object")
        if set(params) - {"serverName", "detail", "limit", "cursor"}:
            raise RpcError(-32600, "unsupported MCP status option")
        detail = params.get("detail") or "full"
        if detail not in ("full", "toolsAndAuthOnly"):
            raise RpcError(-32600, "invalid MCP detail")
        name = params.get("serverName")
        if name is not None and (not isinstance(name, str) or name not in self.config):
            raise RpcError(-32600, "unknown MCP server")
        names = sorted([name] if name is not None else self.config)
        cursor = params.get("cursor")
        if cursor is not None:
            if not isinstance(cursor, str) or cursor not in names:
                raise RpcError(-32600, "invalid MCP status cursor")
            names = names[names.index(cursor)+1:]
        limit = params.get("limit") if params.get("limit") is not None else 100
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise RpcError(-32600, "limit must be an integer from 1 to 100")
        has_more = len(names) > limit
        names = names[:limit]
        statuses = []
        for server_name in names:
            status = {"name": server_name, "runtimeStatus": "notStarted", "pluginId": None, "httpOrigin": None,
                      "serverInfo": None, "serverCapabilities": None, "toolListMeta": None, "tools": {},
                      "toolsError": None, "resources": [], "resourceTemplates": [], "authStatus": "unsupported"}
            if not self.config[server_name]["enabled"]:
                status["runtimeStatus"] = "disabled"
            else:
                try:
                    conn = await self.connection(server_name)
                    status.update({"runtimeStatus": "connected", "serverInfo": conn.server_info,
                                   "serverCapabilities": conn.capabilities, "tools": await conn.tools(), "toolListMeta": conn.list_meta})
                    if detail == "full":
                        status["resources"], status["resourceTemplates"] = await conn.resources()
                except (RpcError, ConnectionError, TimeoutError, OSError, ValueError) as error:
                    status["runtimeStatus"] = "failed"
                    status["toolsError"] = str(error)
            statuses.append(status)
        return {"data": statuses, "nextCursor": names[-1] if has_more else None}

    async def close(self):
        self.generation += 1
        connections, self.connections = list(self.connections.values()), {}
        if connections:
            await asyncio.gather(*(connection.close() for connection in connections), return_exceptions=True)
