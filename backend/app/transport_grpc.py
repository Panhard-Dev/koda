"""Leitor incremental de quadros gRPC-Web compartilhado por provedores."""
from .providers.base import ProviderError

MAX_QUADRO = 8 * 1024 * 1024


class LeitorGrpcWeb:
    def __init__(self) -> None:
        self._buffer = bytearray()

    def receber(self, bloco: bytes) -> list[tuple[int, bytes]]:
        self._buffer.extend(bloco)
        saida: list[tuple[int, bytes]] = []
        while len(self._buffer) >= 5:
            tipo = self._buffer[0]
            tamanho = int.from_bytes(self._buffer[1:5], "big")
            if tamanho > MAX_QUADRO:
                raise ProviderError("quadro gRPC-Web grande demais")
            if len(self._buffer) < tamanho + 5:
                break
            saida.append((tipo, bytes(self._buffer[5:5 + tamanho])))
            del self._buffer[:5 + tamanho]
        return saida

    def terminar(self) -> None:
        if self._buffer:
            raise ProviderError("resposta interrompeu um quadro gRPC-Web no meio")
