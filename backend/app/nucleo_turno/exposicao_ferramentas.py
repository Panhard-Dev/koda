"""Port de ToolName e ToolRouter::exposes_tool, do projeto aberto (Apache-2.0)."""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class NomeFerramenta:
    nome: str
    namespace: str | None = None

    def normalizado(self):
        return NomeFerramenta(self.nome, self.namespace or 'functions')


@dataclass(frozen=True)
class FerramentaAdiada:
    nome: NomeFerramenta
    adiada: bool
    possui_especificacao: bool = False
    possui_dados_busca: bool = False


@dataclass
class Exposicao:
    diretas: set[str] = field(default_factory=set)
    namespaces: dict[str, set[str]] = field(default_factory=dict)
    modo_codigo: set[NomeFerramenta] = field(default_factory=set)
    busca_habilitada: bool = False
    registradas: list[FerramentaAdiada] = field(default_factory=list)
    paralelas: dict[NomeFerramenta, bool] = field(default_factory=dict)

    def permite(self, nome: NomeFerramenta) -> bool:
        alvo = nome.normalizado()
        if any(n.normalizado() == alvo for n in self.modo_codigo):
            return True
        if alvo.namespace == 'functions' and alvo.nome in self.diretas:
            return True
        if alvo.nome in self.namespaces.get(alvo.namespace, set()):
            return True
        return self.busca_habilitada and any(
            f.adiada and f.nome.normalizado() == alvo
            and (f.possui_especificacao or f.possui_dados_busca)
            for f in self.registradas)

    def controles_terminal(self) -> bool:
        return all(self.permite(NomeFerramenta(nome)) for nome in ('exec_command', 'write_stdin'))

    def gerencia_subagentes(self, ferramentas: list[NomeFerramenta]) -> bool:
        return bool(ferramentas) and all(self.permite(nome) for nome in ferramentas)

    def suporta_paralelo(self, nome: NomeFerramenta) -> bool:
        return self.paralelas.get(nome.normalizado(), False)
