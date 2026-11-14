"""Core prefix-rule evaluation from fontes originais/execpolicy.

Does not load .rules files, resolve host executables, apply heuristics, or
provide a sandbox. Callers must supply an explicit fallback decision.
Apache-2.0; copyright autores originais. See LICENCA-TERCEIROS.txt and AVISOS-TERCEIROS.txt.
"""
from dataclasses import dataclass
from enum import IntEnum
from typing import Callable, Sequence
from unicodedata import normalize


class Decision(IntEnum):
    ALLOW = 0
    PROMPT = 1
    PROMPT_USER = 2
    FORBIDDEN = 3


def canonical_key(text: str) -> str:
    return normalize("NFD", normalize("NFD", text).casefold())


@dataclass(frozen=True)
class PrefixRule:
    pattern: tuple[str | tuple[str, ...], ...]
    decision: Decision
    canonical_matching: bool = False
    justification: str | None = None

    def __post_init__(self):
        if not self.pattern or not isinstance(self.pattern[0], str) or not self.pattern[0]:
            raise ValueError("pattern must begin with a non-empty program string")
        if any(not isinstance(token, str) and
               (not isinstance(token, tuple) or not token or not all(isinstance(item, str) for item in token))
               for token in self.pattern):
            raise ValueError("tokens must be strings or non-empty tuples of strings")

    def matches(self, command: Sequence[str]) -> bool:
        if len(command) < len(self.pattern):
            return False
        key = canonical_key if self.canonical_matching else lambda text: text
        return all(any(key(actual) == key(option) for option in
                       ((token,) if isinstance(token, str) else token))
                   for token, actual in zip(self.pattern, command))


@dataclass(frozen=True)
class RuleMatch:
    decision: Decision
    matched_prefix: tuple[str, ...] | None
    command: tuple[str, ...] | None = None
    justification: str | None = None


@dataclass(frozen=True)
class Evaluation:
    decision: Decision
    matched_rules: tuple[RuleMatch, ...]

    @property
    def is_match(self) -> bool:
        return any(match.matched_prefix is not None for match in self.matched_rules)


class PrefixPolicy:
    def __init__(self, rules: Sequence[PrefixRule] = ()):
        self.rules = tuple(rules)

    def check(self, command: Sequence[str], fallback: Callable[[Sequence[str]], Decision]) -> Evaluation:
        matches = tuple(RuleMatch(rule.decision, tuple(command[:len(rule.pattern)]),
                                  justification=rule.justification)
                        for rule in self.rules if rule.matches(command))
        if not matches:
            matches = (RuleMatch(fallback(command), None, tuple(command)),)
        return Evaluation(max(match.decision for match in matches), matches)

    def check_multiple(self, commands: Sequence[Sequence[str]],
                       fallback: Callable[[Sequence[str]], Decision]) -> Evaluation:
        matches = tuple(match for command in commands for match in self.check(command, fallback).matched_rules)
        if not matches:
            raise ValueError("at least one command is required")
        return Evaluation(max(match.decision for match in matches), matches)
