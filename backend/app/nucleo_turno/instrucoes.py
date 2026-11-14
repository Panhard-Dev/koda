"""Local project instruction discovery, adapted from core/src/agents_md.rs.

Apache-2.0; copyright autores originais. Consulte LICENCA e AVISOS.
"""
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


@dataclass(frozen=True)
class InstructionEntry:
    path: Path
    contents: str


@dataclass(frozen=True)
class InstructionLoad:
    entries: tuple[InstructionEntry, ...]
    warnings: tuple[str, ...]

    @property
    def text(self) -> str:
        return "\n\n".join(entry.contents for entry in self.entries)


def discover_instructions(cwd: str | Path, *, max_bytes: int = 32768,
                          root_markers: Sequence[str] = (".git",),
                          fallbacks: Sequence[str] = (), trusted: bool = True) -> InstructionLoad:
    """Find one instruction file per directory and load with a total byte budget."""
    if max_bytes < 0:
        raise ValueError("max_bytes must not be negative")
    if not trusted or not max_bytes:
        return InstructionLoad((), ())
    directory = Path(cwd).absolute()
    if not directory.is_dir():
        raise NotADirectoryError(directory)
    names = ["AGENTS.override.md", "AGENTS.md"]
    for name in fallbacks:
        if not name or name in (".", "..") or "/" in name or "\x00" in name:
            continue
        if os.name == "nt" and ("\\" in name or ":" in name):
            continue
        if name not in names:
            names.append(name)
    ancestors = (directory, *directory.parents)
    root = next((ancestor for ancestor in ancestors
                 if any((ancestor / marker).exists() for marker in root_markers)), None)
    directories = [directory]
    if root is not None:
        while directories[-1] != root:
            directories.append(directories[-1].parent)
        directories.reverse()
    entries, warnings = [], []
    remaining = max_bytes
    for directory in directories:
        candidate = next((directory / name for name in names if (directory / name).is_file()), None)
        if candidate is None:
            continue
        if remaining == 0:
            warnings.append(f"Skipped project instructions at {candidate}: {max_bytes}-byte budget exhausted")
            break
        data = candidate.read_bytes()
        if len(data) > remaining:
            warnings.append(f"Loaded only {remaining} of {len(data)} bytes from {candidate}")
            data = data[:remaining]
        text = data.decode("utf-8", errors="replace")
        if text.strip():
            entries.append(InstructionEntry(candidate, text))
            remaining -= len(data)
    return InstructionLoad(tuple(entries), tuple(warnings))
