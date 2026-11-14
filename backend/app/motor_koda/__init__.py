"""Módulos nativos Python portados do código aberto do Koda."""
from .client import BackendClient
from .patch_files import AffectedPaths, ApplyFailure, apply_hunks, apply_patch
from .patch_parser import Hunk, ParseError, Patch, StreamingPatchParser, parse_patch
from .patch_update import PatchChunk, PatchError, apply_update, seek_sequence

__all__ = ["BackendClient", "AffectedPaths", "ApplyFailure", "apply_hunks", "apply_patch", "Hunk", "ParseError", "Patch", "StreamingPatchParser", "parse_patch", "PatchChunk", "PatchError", "apply_update", "seek_sequence"]
