"""Guarda opcional para repetição literal na saída visível; não inspeciona pensamento."""


class RepeticaoFluxo:
    def __init__(self, *, minimo=2048, intervalo=512, repeticoes=8, periodo_maximo=256):
        if minimo < 1 or intervalo < 1 or repeticoes < 2 or periodo_maximo < 1:
            raise ValueError('parâmetros inválidos')
        self.minimo, self.intervalo = minimo, intervalo
        self.repeticoes, self.periodo_maximo = repeticoes, periodo_maximo
        self.cauda = ''
        self.total = 0
        self.proxima = minimo

    def alimentar(self, texto):
        self.total += len(texto)
        limite = max(self.minimo, self.periodo_maximo * self.repeticoes)
        self.cauda = (self.cauda + texto)[-limite:]
        if self.total < self.proxima:
            return False
        self.proxima = self.total + self.intervalo
        maior = min(self.periodo_maximo, len(self.cauda) // self.repeticoes)
        for periodo in range(1, maior + 1):
            padrao = self.cauda[-periodo:]
            if self.cauda[-periodo * self.repeticoes:] == padrao * self.repeticoes:
                return True
        return False
