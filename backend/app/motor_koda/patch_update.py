"""Port of Koda apply-patch line matching and update calculation.

Based on fontes originais/apply-patch/src/{seek_sequence,file_update,text_file}.rs,
Apache-2.0, autores originais; see LICENCA-TERCEIROS.txt.
This module does not parse a patch or change files.
"""

from dataclasses import dataclass, field
import re
from typing import Sequence


class PatchError(ValueError):
    """A patch chunk could not be matched against its source."""


@dataclass
class PatchChunk:
    old_lines: list[str] = field(default_factory=list)
    new_lines: list[str] = field(default_factory=list)
    context_line_indices: list[tuple[int, int]] = field(default_factory=list)
    change_context: str | None = None
    is_end_of_file: bool = False

    def add_context(self, line: str) -> None:
        self.context_line_indices.append((len(self.old_lines), len(self.new_lines)))
        self.old_lines.append(line)
        self.new_lines.append(line)


# Rust char::is_whitespace / Unicode White_Space, excluding Python's extra C0 codes.
_WHITESPACE = "\t\n\v\f\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
_NORMALISE = str.maketrans({**dict.fromkeys(map(ord, "‐‑‒–—―−"), "-"),
                            **dict.fromkeys(map(ord, "‘’‚‛"), "'"),
                            **dict.fromkeys(map(ord, '“”„‟'), '"'),
                            **dict.fromkeys(map(ord, "\u00a0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000"), " ")})


def seek_sequence(lines: Sequence[str], pattern: Sequence[str], start: int = 0,
                  eof: bool = False) -> int | None:
    if start < 0:
        raise ValueError("start must be nonnegative")
    if not pattern:
        return start
    if len(pattern) > len(lines):
        return None
    search_start = max(len(lines) - len(pattern), start) if eof else start
    normalizers = (lambda s: s, lambda s: s.rstrip(_WHITESPACE),
                   lambda s: s.strip(_WHITESPACE),
                   lambda s: s.strip(_WHITESPACE).translate(_NORMALISE))
    for normalize in normalizers:
        target = [normalize(line) for line in pattern]
        for i in range(search_start, len(lines) - len(pattern) + 1):
            if all(normalize(line) == expected for line, expected in zip(lines[i:i + len(pattern)], target)):
                return i
    return None


def apply_update(contents: str, chunks: Sequence[PatchChunk], path: str = "<memory>") -> str:
    """Calculate updated text, retaining unchanged line endings like upstream."""
    source: list[tuple[str, str]] = []
    position = 0
    preferred = None
    for match in re.finditer(r"\r\n|\r|\n", contents):
        ending = match.group()
        if preferred is None:
            preferred = ending
        source.append((contents[position:match.start()], ending))
        position = match.end()
    if position < len(contents):
        source.append((contents[position:], ""))
    preferred = preferred or "\n"
    lines = [line for line, _ in source]
    replacements: list[tuple[int, int, list[str]]] = []
    index = 0
    for chunk in chunks:
        if chunk.change_context is not None:
            found = seek_sequence(lines, [chunk.change_context], index)
            if found is None:
                raise PatchError(f"Failed to find context '{chunk.change_context}' in {path}")
            index = found + 1
        if not chunk.old_lines:
            replacements.append((len(lines), 0, chunk.new_lines.copy()))
            continue
        pattern, new = chunk.old_lines, chunk.new_lines
        found = seek_sequence(lines, pattern, index, chunk.is_end_of_file)
        if found is None and pattern[-1] == "":
            pattern = pattern[:-1]
            if new and new[-1] == "":
                new = new[:-1]
            found = seek_sequence(lines, pattern, index, chunk.is_end_of_file)
        if found is None:
            raise PatchError(f"Failed to find expected lines in {path}:\n" + "\n".join(chunk.old_lines))
        old_start = new_start = 0
        for old_context, new_context in chunk.context_line_indices:
            if old_context >= len(pattern) or new_context >= len(new):
                break
            if old_context < old_start or new_context < new_start:
                raise ValueError("context indices must be strictly increasing")
            if old_start != old_context or new_start != new_context:
                replacements.append((found + old_start, old_context - old_start, list(new[new_start:new_context])))
            old_start, new_start = old_context + 1, new_context + 1
        if old_start != len(pattern) or new_start != len(new):
            replacements.append((found + old_start, len(pattern) - old_start, list(new[new_start:])))
        index = found + len(pattern)
    replacements.sort(key=lambda replacement: replacement[0])
    result: list[tuple[str, str]] = []
    cursor = 0
    for start, old_len, added in replacements:
        if start < cursor:
            raise PatchError("Overlapping replacements")
        result.extend(source[cursor:start])
        result.extend((line, preferred) for line in added)
        cursor = start + old_len
    result.extend(source[cursor:])
    return "".join(line + (ending or preferred) for line, ending in result)
