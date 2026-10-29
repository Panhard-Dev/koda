"""Estado opaco do provider em repouso: DPAPI do usuário Windows, nunca texto cru.

O encadeamento dentro da rodada continua em memória. Em sistemas sem proteção nativa
disponível, não persistimos esse estado privado.
"""
from __future__ import annotations

import base64
import ctypes
import logging
import os
from ctypes import wintypes

PREFIX = "dpapi-v1:"


class _Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def _transform(data: bytes, encrypt: bool) -> bytes:
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt.CryptProtectData if encrypt else crypt.CryptUnprotectData
    function.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    function.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(data)
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = _Blob()
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel.LocalFree(target.data)


def proteger(text: str | None) -> str | None:
    if text is None or os.name != "nt":
        return None
    try:
        return PREFIX + base64.b64encode(_transform(text.encode("utf-8"), True)).decode("ascii")
    except OSError:
        logging.getLogger(__name__).warning("provider_state_not_persisted")
        return None


def abrir(value: str | None) -> str | None:
    if not value or not value.startswith(PREFIX) or os.name != "nt":
        return None
    try:
        return _transform(base64.b64decode(value[len(PREFIX):], validate=True), False).decode("utf-8")
    except (OSError, ValueError, UnicodeError):
        logging.getLogger(__name__).warning("provider_state_unavailable")
        return None
