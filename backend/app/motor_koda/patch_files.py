"""Filesystem application of Koda patch hunks, based on apply-patch/lib.rs.

Apache-2.0; copyright autores originais. See LICENCA-TERCEIROS.txt and AVISOS-TERCEIROS.txt.
"""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from . import local_files
from .patch_parser import Hunk, parse_patch
from .patch_update import PatchError, apply_update


@dataclass
class AffectedPaths:
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = ["Success. Updated the following files:"]
        for label, paths in (("A", self.added), ("M", self.modified), ("D", self.deleted)):
            lines.extend(f"{label} {path}" for path in paths)
        return "\n".join(lines) + "\n"


class ApplyFailure(Exception):
    """A hunk failed; earlier entries in affected were already applied."""
    def __init__(self, message: str, affected: AffectedPaths):
        self.affected = affected
        super().__init__(message)


def apply_hunks(hunks: Sequence[Hunk], cwd: str | Path = ".", *,
                follow_symlinks: bool = True) -> AffectedPaths:
    affected = AffectedPaths()
    if not hunks:
        raise ApplyFailure("No files were modified.", affected)
    cwd = Path(cwd).absolute()
    for hunk in hunks:
        path = cwd / hunk.path
        try:
            if hunk.kind == "add":
                local_files.write(path, hunk.contents.encode("utf-8"),
                                  follow_symlinks=follow_symlinks, create_parents=True)
                affected.added.append(hunk.path)
            elif hunk.kind == "delete":
                local_files.remove(path, follow_symlinks=follow_symlinks)
                affected.deleted.append(hunk.path)
            elif hunk.kind == "update":
                original = local_files.read(path, follow_symlinks=follow_symlinks).decode("utf-8")
                updated = apply_update(original, hunk.chunks, str(path))
                if hunk.move_path is not None:
                    destination = cwd / hunk.move_path
                    local_files.write(destination, updated.encode("utf-8"),
                                      follow_symlinks=follow_symlinks, create_parents=True)
                    local_files.remove(path, follow_symlinks=follow_symlinks)
                else:
                    local_files.write(path, updated.encode("utf-8"),
                                      follow_symlinks=follow_symlinks, create_parents=False)
                affected.modified.append(hunk.move_path if hunk.move_path is not None else hunk.path)
            else:
                raise ValueError(f"Unknown hunk kind: {hunk.kind}")
        except (OSError, UnicodeError, PatchError, ValueError) as error:
            raise ApplyFailure(str(error), affected) from error
    return affected


def apply_patch(patch: str, cwd: str | Path = ".", *, follow_symlinks: bool = True) -> AffectedPaths:
    return apply_hunks(parse_patch(patch).hunks, cwd, follow_symlinks=follow_symlinks)
