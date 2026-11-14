"""TOML layer merge logic adapted from fontes originais/config/src/merge.rs.

This is a data merge utility, not a policy enforcement or configuration loader.
Apache-2.0; copyright autores originais. See LICENCA-TERCEIROS.txt and AVISOS-TERCEIROS.txt.
"""
from copy import deepcopy
import os

_ALIASES = {
    ("tui",): ("whimsy", ("effects", "starfield")),
    ("memories",): ("no_memories_if_mcp_or_web_search", ("disable_on_external_context",)),
    ("agents",): ("max_threads", ("max_concurrent_threads_per_session",)),
}
_STRUCTURED = {"code_mode", "multi_agent_v2", "network_proxy", "sleep_tool", "runtime_agent_instances"}


def _aliases(table, path):
    alias = _ALIASES.get(path)
    if not alias or alias[0] not in table:
        return
    old, new = alias
    value = table.pop(old)
    destination = table
    for part in new[:-1]:
        child = destination.setdefault(part, {})
        if not isinstance(child, dict):
            return
        destination = child
    destination.setdefault(new[-1], value)


def _normalize_overlay(value, path=()):
    if isinstance(value, dict):
        result = {key: _normalize_overlay(child, path + (key,)) for key, child in value.items()}
        _aliases(result, path)
        return result
    if isinstance(value, list):
        return [_normalize_overlay(child, path) for child in value]
    return deepcopy(value)


def _normalize_base(base, overlay, path=()):
    if isinstance(base, dict) and isinstance(overlay, dict):
        _aliases(base, path)
        for key, value in overlay.items():
            if key in base:
                _normalize_base(base[key], value, path + (key,))


def _structured(path):
    return ((len(path) == 2 and path[0] == "features") or
            (len(path) == 4 and path[0] == "profiles" and path[2] == "features")) and path[-1] in _STRUCTURED


def _domain_path(path):
    return (len(path) == 4 and path[0] == "permissions" and path[2:] == ("network", "domains")) or path == ("application", "network", "domains")


def _host_key(host):
    host = host.strip()
    if host.startswith("[") and "]" in host:
        host = host[1:host.index("]")]
    elif host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")).rstrip(".")


def _merge(base, overlay, path):
    if path == ("shell_environment_policy",) and isinstance(base, dict) and isinstance(overlay, dict):
        if "filters" in overlay:
            base.pop("exclude", None)
            base.pop("include_only", None)
        elif "exclude" in overlay or "include_only" in overlay:
            base.pop("filters", None)
    if _structured(path):
        if isinstance(base, bool) and isinstance(overlay, dict):
            base = {"enabled": base}
        elif isinstance(base, dict) and isinstance(overlay, bool):
            base["enabled"] = overlay
            return base
    if not isinstance(base, dict) or not isinstance(overlay, dict):
        return deepcopy(overlay)
    if _domain_path(path):
        base = {_host_key(key): value for key, value in sorted(base.items())}
        overlay = {_host_key(key): value for key, value in sorted(overlay.items())}
    if path == ("shell_environment_policy", "filters"):
        base = {key.lower(): value for key, value in sorted(base.items())}
        overlay = {key.lower(): value for key, value in sorted(overlay.items())}
    if path and path[-1] == "credentials" and _structured(path[:-1]):
        for provider_id, provider in overlay.items():
            sources = provider.get("env") if isinstance(provider, dict) else None
            if not isinstance(sources, list):
                continue
            for old_id, existing in list(base.items()):
                if old_id == provider_id:
                    continue
                future = overlay.get(old_id, existing)
                existing_sources = future.get("env") if isinstance(future, dict) else None
                if not isinstance(existing_sources, list):
                    existing_sources = existing.get("env") if isinstance(existing, dict) else None
                if isinstance(existing_sources, list):
                    def key(value):
                        return value.lower() if os.name == "nt" else value
                    if any(key(a) == key(b) for a in sources if isinstance(a, str)
                           for b in existing_sources if isinstance(b, str)):
                        del base[old_id]
    for key, value in overlay.items():
        base[key] = _merge(base[key], value, path + (key,)) if key in base else deepcopy(value)
    return base


def merge_config(base, overlay):
    """Return merged TOML-compatible values without mutating either input."""
    base = deepcopy(base)
    overlay = _normalize_overlay(overlay)
    _normalize_base(base, overlay)
    return _merge(base, overlay, ())
