"""Operações de arquivo no Windows com diretórios fixados por handles nativos.

O handle de cada ancestral nega FILE_SHARE_DELETE enquanto a operação usa o caminho.
Assim outro processo não pode renomear/substituir um ancestral entre validação e uso.
Reparse points são recusados no objeto aberto, não apenas por uma inspeção anterior.
Isto protege ferramentas de arquivo; não pretende isolar comandos shell autorizados.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from contextlib import contextmanager
import os
from pathlib import Path
import shutil


class UnsafePath(OSError):
    pass


def _open_windows(path: Path, *, read: bool = False) -> int:
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    kernel.CreateFileW.restype = wintypes.HANDLE
    # OPEN_EXISTING, OPEN_REPARSE_POINT, BACKUP_SEMANTICS. Não compartilhar DELETE
    # permite ler/escrever os filhos, mas impede trocar este diretório/arquivo.
    native_path = str(path.absolute())
    if not native_path.startswith('\\\\?\\'):
        native_path = ('\\\\?\\UNC\\' + native_path[2:]) if native_path.startswith('\\\\') else '\\\\?\\' + native_path
    # FILE_LIST_DIRECTORY / FILE_READ_DATA participa da checagem de compartilhamento.
    # Um handle apenas de atributos não impede rename no Windows.
    handle = kernel.CreateFileW(native_path, 0x80000000 if read else 0x1,
                               0x1 | 0x2, None, 3, 0x00200000 | 0x02000000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    class Info(ctypes.Structure):
        _fields_ = [('attributes', wintypes.DWORD), ('creation', wintypes.FILETIME),
            ('access', wintypes.FILETIME), ('write', wintypes.FILETIME),
            ('volume', wintypes.DWORD), ('size_high', wintypes.DWORD), ('size_low', wintypes.DWORD),
            ('links', wintypes.DWORD), ('index_high', wintypes.DWORD), ('index_low', wintypes.DWORD)]
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(Info)]
    kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    info = Info()
    valid = bool(kernel.GetFileInformationByHandle(handle, ctypes.byref(info)))
    if valid and info.attributes & 0x400:
        class TagInfo(ctypes.Structure):
            _fields_ = [('attributes', wintypes.DWORD), ('tag', wintypes.DWORD)]
        tag = TagInfo()
        kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                      ctypes.c_void_p, wintypes.DWORD]
        kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
        valid = bool(kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(tag), ctypes.sizeof(tag)))
        # Tags de sincronização cloud não redirecionam o nome do caminho.
        valid = valid and not bool(tag.tag & 0x20000000)
    if not valid:
        _close_windows(handle)
        raise UnsafePath(f'link/reparse point ou caminho instável recusado: {path}')
    return handle


def _close_windows(handle: int) -> None:
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.CloseHandle(handle)


class PathGuard:
    """Fixa ancestrais existentes e cria/fixa pais novos sem seguir junções."""
    def __init__(self) -> None:
        self.handles: dict[str, int] = {}

    def directory(self, directory: Path, *, create: bool = False) -> None:
        directory = directory.absolute()
        key = os.path.normcase(str(directory))
        if key in self.handles:
            return
        if directory.parent != directory:
            self.directory(directory.parent, create=create)
        if create and not directory.exists():
            try:
                directory.mkdir()
            except FileExistsError:
                pass
        if os.name == 'nt':
            self.handles[key] = _open_windows(directory)
        elif not directory.is_dir() or directory.is_symlink():
            raise UnsafePath(f'diretório inválido: {directory}')

    def parents(self, target: Path, *, create: bool = False) -> None:
        self.directory(target.absolute().parent, create=create)

    def entry(self, target: Path) -> None:
        if os.name == 'nt':
            key = 'entry:' + os.path.normcase(str(target.absolute()))
            if key not in self.handles:
                self.handles[key] = _open_windows(target)

    def close(self) -> None:
        for handle in reversed(list(self.handles.values())):
            _close_windows(handle)
        self.handles.clear()

    def __enter__(self):
        return self

    def __exit__(self, *args) -> None:
        self.close()


@contextmanager
def open_read(path: Path, *, binary: bool = False, errors: str = 'strict'):
    """Abre o próprio arquivo sem seguir uma troca de symlink no último componente."""
    with PathGuard() as guard:
        guard.parents(path)
        if os.name == 'nt':
            import msvcrt
            handle = _open_windows(path, read=True)
            try:
                descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            except BaseException:
                _close_windows(handle)
                raise
        else:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb' if binary else 'r',
                       **({} if binary else {'encoding': 'utf-8', 'errors': errors})) as source:
            yield source


def read_text(path: Path, *, encoding: str = 'utf-8', errors: str = 'strict') -> str:
    with open_read(path, binary=True) as source:
        return source.read().decode(encoding, errors=errors).replace('\r\n', '\n').replace('\r', '\n')


def read_bytes(path: Path) -> bytes:
    with open_read(path, binary=True) as source:
        return source.read()


def remove_tree(path: Path) -> None:
    """Percorre cada diretório fixado; uma junção nunca vira uma árvore a apagar."""
    with PathGuard() as parent:
        parent.parents(path)
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise UnsafePath(f'não removo árvore através de link/junção: {path}')
        with PathGuard() as current:
            current.directory(path)
            for entry in path.iterdir():
                if entry.is_symlink() or (hasattr(entry, 'is_junction') and entry.is_junction()):
                    # Remover a entrada do link não acessa o destino.
                    if entry.is_symlink():
                        entry.unlink()
                    else:
                        entry.rmdir()
                elif entry.is_dir():
                    remove_tree(entry)
                else:
                    entry.unlink()
        path.rmdir()


def copy_tree(source: Path, destination: Path, *, ignore=None) -> None:
    with PathGuard() as guard:
        guard.directory(source)
        guard.parents(destination, create=True)
        destination.mkdir()
        guard.directory(destination)
        entries = list(source.iterdir())
        excluded = set(ignore(str(source), [entry.name for entry in entries])) if ignore else set()
        for entry in entries:
            if entry.name in excluded:
                continue
            target = destination / entry.name
            if entry.is_dir():
                copy_tree(entry, target, ignore=ignore)
            else:
                copy_file(entry, target)


def copy_file(source: Path, destination: Path) -> None:
    with PathGuard() as guard:
        guard.parents(destination, create=True)
        with open_read(source, binary=True) as src, destination.open('xb') as dst:
            shutil.copyfileobj(src, dst, length=64 * 1024)
            dst.flush()
            os.fsync(dst.fileno())
