"""Port parcial das decisões de responses_retry.rs; sem rede e sem mensagens de sistema."""
from dataclasses import dataclass


@dataclass
class EstadoTentativas:
    tentativas: int = 0
    reconexoes: int = 0
    atraso_conexao: float = 5.0

    def decidir(self, *, limite: int, erro_recuperavel: bool, atraso: float = 0,
                prazo_servidor: float | None = None, conexao_ilimitada: bool = False,
                erro_conexao: bool = False, amostragem: bool = True,
                sessao_interna: bool = False, bedrock: bool = False,
                transporte_alternativo: bool = False):
        if limite < 0 or atraso < 0 or (prazo_servidor is not None and prazo_servidor < 0):
            raise ValueError('valores negativos são inválidos')
        if not erro_recuperavel:
            return ('falhar', 0.0)
        if conexao_ilimitada and erro_conexao and amostragem and not sessao_interna and not bedrock:
            espera = self.atraso_conexao
            self.reconexoes += 1
            self.atraso_conexao = min(espera * 2, 60.0)
            return ('reconectar', espera)
        if self.tentativas >= limite and transporte_alternativo:
            self.tentativas = 0
            return ('trocar_transporte', prazo_servidor if prazo_servidor is not None else 0.0)
        if self.tentativas < limite:
            self.tentativas += 1
            return ('tentar', prazo_servidor if prazo_servidor is not None else atraso)
        return ('falhar', 0.0)


@dataclass
class CompactacaoRevisao:
    """Guarda da retomada após limite de contexto, inspirada em session/turn.rs."""
    ja_tentou: bool = False

    def deve_compactar(self, *, resumo_automatico: bool, contexto_excedido: bool,
                       revisao_sem_orcamento: bool) -> bool:
        if resumo_automatico and contexto_excedido and revisao_sem_orcamento and not self.ja_tentou:
            self.ja_tentou = True
            return True
        return False

    def amostragem_bem_sucedida(self):
        self.ja_tentou = False
