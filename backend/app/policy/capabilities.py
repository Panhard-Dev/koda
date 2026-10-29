"""Capacidades concedidas pelo executor, independentemente do texto do agente."""
READ_ONLY_TOOLS = frozenset({
    "read_file", "read_attachment", "list_dir", "search_files", "search_codebase",
    "grep", "regex_search", "web_search", "url_reader", "use_skill", "update_todos",
})


def deny_for_read_only(definitions: list[dict]) -> set[str]:
    return {item["function"]["name"] for item in definitions
            if item["function"]["name"] not in READ_ONLY_TOOLS}
