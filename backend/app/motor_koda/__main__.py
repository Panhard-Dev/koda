"""Standalone apply-patch entrypoint."""
import sys
from .patch_files import ApplyFailure, apply_patch
from .patch_parser import ParseError


def main() -> int:
    if len(sys.argv) > 2:
        print("Error: apply_patch accepts exactly one argument.", file=sys.stderr)
        return 2
    patch = sys.argv[1] if len(sys.argv) == 2 else sys.stdin.read()
    if not patch:
        print("Usage: apply_patch 'PATCH'\n       echo 'PATCH' | apply_patch", file=sys.stderr)
        return 2
    try:
        result = apply_patch(patch)
    except (ParseError, ApplyFailure) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(result.summary(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
