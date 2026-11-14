"""Incremental parser for the Koda apply-patch format.

Adapted from fontes originais/apply-patch/src/{parser,streaming_parser}.rs,
Apache-2.0, autores originais; see LICENCA-TERCEIROS.txt.
"""
from dataclasses import dataclass, field

from .patch_update import PatchChunk


class ParseError(ValueError):
    pass


@dataclass
class Hunk:
    kind: str
    path: str
    contents: str = ""
    move_path: str | None = None
    chunks: list[PatchChunk] = field(default_factory=list)


@dataclass
class Patch:
    hunks: list[Hunk]
    environment_id: str | None = None


class StreamingPatchParser:
    def __init__(self):
        self.buffer = ""
        self.mode = "initial"
        self.hunks: list[Hunk] = []
        self.environment_id: str | None = None
        self.line_number = 0
        self.hunk_line = 0

    def _error(self, message: str) -> None:
        raise ParseError(f"invalid hunk at line {self.line_number}, {message}")

    def _ensure_update(self, line: str) -> None:
        if self.mode == "update":
            hunk = self.hunks[-1]
            if not hunk.chunks:
                raise ParseError(f"invalid hunk at line {self.hunk_line}, Update file hunk for path '{hunk.path}' is empty")
            chunk = hunk.chunks[-1]
            if not chunk.old_lines and not chunk.new_lines:
                if line == "*** End Patch":
                    self._error("Update hunk does not contain any lines")
                self._unexpected(line)

    def _unexpected(self, line: str) -> None:
        self._error(f"Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)")

    def _headers(self, line: str) -> bool:
        marker = "*** Environment ID:"
        if self.mode == "started" and line.startswith(marker):
            value = line[len(marker):].strip()
            if self.environment_id is not None:
                raise ParseError("invalid patch: apply_patch environment_id cannot be specified more than once")
            if not value:
                raise ParseError("invalid patch: apply_patch environment_id cannot be empty")
            self.environment_id = value
            return True
        if line == "*** End Patch":
            self._ensure_update(line)
            self.mode = "ended"
            return True
        for kind in ("add", "delete", "update"):
            marker = f"*** {kind.title()} File: "
            if line.startswith(marker):
                self._ensure_update(line)
                self.hunks.append(Hunk(kind, line[len(marker):]))
                self.mode = kind
                self.hunk_line = self.line_number
                return True
        return False

    def _line(self, line: str) -> None:
        self.line_number += 1
        trimmed = line.strip()
        if self.mode == "initial":
            if trimmed != "*** Begin Patch":
                raise ParseError("invalid patch: The first line of the patch must be '*** Begin Patch'")
            self.mode = "started"
            return
        if self.mode == "ended":
            if trimmed:
                raise ParseError("invalid patch: The last line of the patch must be '*** End Patch'")
            return
        header = line.rstrip() if self.mode == "update" else trimmed
        if self._headers(header):
            return
        if self.mode == "add" and line.startswith("+"):
            self.hunks[-1].contents += line[1:] + "\n"
            return
        if self.mode in ("started", "add", "delete"):
            self._error(f"'{trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'")
        hunk = self.hunks[-1]
        update = line.rstrip()
        if hunk.chunks and hunk.chunks[-1].is_end_of_file:
            if not update:
                return
            if update != "@@" and not update.startswith("@@ "):
                self._error(f"Expected update hunk to start with a @@ context marker, got: '{line}'")
        if not hunk.chunks and hunk.move_path is None and update.startswith("*** Move to: "):
            hunk.move_path = update[len("*** Move to: "):]
            return
        if update == "@@" or update.startswith("@@ "):
            if hunk.chunks and not hunk.chunks[-1].old_lines and not hunk.chunks[-1].new_lines:
                self._unexpected(line)
            hunk.chunks.append(PatchChunk(change_context=update[3:] if update.startswith("@@ ") else None))
            return
        if update == "*** End of File":
            if hunk.chunks:
                chunk = hunk.chunks[-1]
                if not chunk.old_lines and not chunk.new_lines:
                    self._error("Update hunk does not contain any lines")
                chunk.is_end_of_file = True
            return
        if not line or line[0] in " +-":
            if not hunk.chunks:
                hunk.chunks.append(PatchChunk())
            chunk = hunk.chunks[-1]
            if not line or line[0] == " ":
                chunk.add_context(line[1:] if line else "")
            elif line[0] == "+":
                chunk.new_lines.append(line[1:])
            else:
                chunk.old_lines.append(line[1:])
            return
        if hunk.chunks and (hunk.chunks[-1].old_lines or hunk.chunks[-1].new_lines):
            self._error(f"Expected update hunk to start with a @@ context marker, got: '{line}'")
        self._unexpected(line)

    def push(self, delta: str) -> list[Hunk]:
        self.buffer += delta
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            self._line(line.removesuffix("\r"))
        return self.hunks

    def finish(self) -> Patch:
        if self.buffer:
            line, self.buffer = self.buffer, ""
            if line.strip() == "*** End Patch":
                self.line_number += 1
                self._ensure_update(line.strip())
                self.mode = "ended"
            else:
                self._line(line)
        if self.mode != "ended":
            raise ParseError("invalid patch: The last line of the patch must be '*** End Patch'")
        return Patch(self.hunks, self.environment_id)


def parse_patch(patch: str) -> Patch:
    lines = [line.removesuffix("\r") for line in patch.strip().split("\n")]
    if lines and lines[0] in ("<<EOF", "<<'EOF'", '<<"EOF"') and len(lines) >= 4 and lines[-1].endswith("EOF"):
        lines = lines[1:-1]
    if not lines or lines[0].strip() != "*** Begin Patch":
        raise ParseError("invalid patch: The first line of the patch must be '*** Begin Patch'")
    if lines[-1].strip() != "*** End Patch":
        raise ParseError("invalid patch: The last line of the patch must be '*** End Patch'")
    parser = StreamingPatchParser()
    parser.push("\n".join(lines))
    return parser.finish()
