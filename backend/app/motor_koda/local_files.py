"""Local filesystem operations used by the patch tool.

The optional POSIX no-follow mode resolves directories with openat-style file
 descriptors and rejects links. It does not implement Koda's sandbox layer.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import stat


@contextmanager
def _parent(path: Path, create: bool):
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        raise NotImplementedError("no-follow filesystem mode requires POSIX O_NOFOLLOW")
    absolute = Path(os.path.abspath(path))
    parts = absolute.parts
    fd = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            try:
                next_fd = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
                next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd, parts[-1]
    finally:
        os.close(fd)


def read(path: Path, *, follow_symlinks: bool) -> bytes:
    if follow_symlinks:
        return path.read_bytes()
    with _parent(path, False) as (fd, name):
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        with os.fdopen(file_fd, "rb") as stream:
            return stream.read()


def write(path: Path, data: bytes, *, follow_symlinks: bool, create_parents: bool) -> None:
    if follow_symlinks:
        if create_parents:
            path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return
    with _parent(path, create_parents) as (fd, name):
        file_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o666, dir_fd=fd)
        with os.fdopen(file_fd, "wb") as stream:
            stream.write(data)


def remove(path: Path, *, follow_symlinks: bool) -> None:
    if follow_symlinks:
        if path.is_dir():
            raise IsADirectoryError(f"Failed to delete file {path}: Is a directory")
        path.unlink()
        return
    with _parent(path, False) as (fd, name):
        mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
        if stat.S_ISLNK(mode):
            raise OSError(f"Refusing to remove symbolic link: {path}")
        if stat.S_ISDIR(mode):
            raise IsADirectoryError(f"Failed to delete file {path}: Is a directory")
        os.unlink(name, dir_fd=fd)
