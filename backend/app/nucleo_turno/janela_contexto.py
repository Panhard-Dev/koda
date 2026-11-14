"""Cálculo puro de session/context_window.rs (Apache-2.0; LICENCA e AVISOS)."""
from dataclasses import dataclass


@dataclass(frozen=True)
class EstadoContexto:
    tokens_ativos: int
    tokens_escopo: int
    limite_escopo: int | None
    limite_total: int | None
    restantes: int | None
    prefixo: int | None
    limite_total_atingido: bool
    limite_atingido: bool
    compactar_apos_turno: bool


def calcular_contexto(*, ativos: int, limite_modelo: int | None, janela_modelo: int | None,
                      percentual_janela: int = 100, escopo: str = 'total',
                      prefixo: int | None = None, limite_configurado: int | None = None,
                      reserva: int = 0, percentual_apos_turno: int = 0) -> EstadoContexto:
    if escopo not in ('total', 'apos_prefixo'):
        raise ValueError('escopo inválido')
    if escopo == 'total':
        usados, limite, preenchimento = ativos, limite_modelo, None
    else:
        usados = max(ativos - (prefixo if prefixo is not None else ativos), 0)
        limite = limite_configurado if limite_configurado is not None else limite_modelo
        preenchimento = prefixo
    total = janela_modelo * percentual_janela // 100 if janela_modelo is not None else None
    restantes = [max(lim - uso, 0) for lim, uso in ((limite, usados), (total, ativos)) if lim is not None]
    total_atingido = total is not None and ativos >= total
    atingido = (limite is not None and usados >= limite + reserva) or total_atingido
    apos = percentual_apos_turno > 0 and (atingido or (total is not None and ativos * 100 >= total * percentual_apos_turno))
    return EstadoContexto(ativos, usados, limite, total, min(restantes) if restantes else None,
                          preenchimento, total_atingido, atingido, apos)
