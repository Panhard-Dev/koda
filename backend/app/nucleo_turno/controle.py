"""Controlador independente de ferramentas e progresso, sem integração com Koda."""
from dataclasses import dataclass, field
from enum import Enum
import inspect
from typing import Any, Awaitable, Callable, Mapping


class Recusa(Exception):
    pass


class Modo(Enum):
    CODIGO = 'codigo'
    PLANEJAMENTO = 'planejamento'


@dataclass(frozen=True)
class Ferramenta:
    nome: str
    executar: Callable[..., Any]
    obrigatorios: frozenset[str] = frozenset()
    opcionais: frozenset[str] = frozenset()
    altera: bool = False
    requer_aprovacao: bool = False
    verificacao: bool = False


@dataclass(frozen=True)
class Resultado:
    ferramenta: str
    sucesso: bool
    conteudo: Any


@dataclass
class Tarefa:
    descricao: str
    concluida: bool = False
    evidencias: list[int] = field(default_factory=list)


class Controlador:
    def __init__(self, ferramentas: list[Ferramenta], *, modo: Modo = Modo.CODIGO,
                 aprovar: Callable[[str, Mapping[str, Any]], bool | Awaitable[bool]] | None = None):
        self.catalogo = {f.nome: f for f in ferramentas}
        if len(self.catalogo) != len(ferramentas):
            raise ValueError('nome de ferramenta duplicado')
        self.modo = modo
        self.aprovar = aprovar
        self.resultados: list[Resultado] = []
        self.tarefas: list[Tarefa] = []
        self.alteracoes = 0
        self.ultima_verificacao = 0

    def aprovar_plano(self, *, origem: str) -> None:
        if origem != 'decisao_estruturada':
            raise Recusa('o modo de planejamento exige uma decisão estruturada')
        self.modo = Modo.CODIGO

    def adicionar_tarefa(self, descricao: str) -> int:
        if not descricao.strip():
            raise ValueError('descrição vazia')
        self.tarefas.append(Tarefa(descricao))
        return len(self.tarefas) - 1

    def concluir_tarefa(self, indice: int, evidencias: list[int]) -> None:
        if not evidencias or any(i < 0 or i >= len(self.resultados) or not self.resultados[i].sucesso for i in evidencias):
            raise Recusa('conclusão exige resultados de ferramentas bem-sucedidos')
        tarefa = self.tarefas[indice]
        tarefa.evidencias = list(evidencias)
        tarefa.concluida = True

    async def chamar(self, nome: str, argumentos: Mapping[str, Any]) -> Resultado:
        ferramenta = self.catalogo.get(nome)
        if ferramenta is None:
            raise Recusa('ferramenta fora do catálogo')
        nomes = set(argumentos)
        if ferramenta.obrigatorios - nomes or nomes - ferramenta.obrigatorios - ferramenta.opcionais:
            raise Recusa('argumentos incompatíveis com o catálogo')
        if self.modo is Modo.PLANEJAMENTO and ferramenta.altera:
            raise Recusa('alteração bloqueada durante planejamento')
        if ferramenta.requer_aprovacao:
            permitido = self.aprovar(nome, argumentos) if self.aprovar else False
            if inspect.isawaitable(permitido):
                permitido = await permitido
            if permitido is not True:
                raise Recusa('aprovação não concedida')
        if ferramenta.altera:
            # Uma falha ou cancelamento ainda pode ter deixado efeitos no disco.
            self.alteracoes += 1
        try:
            valor = ferramenta.executar(**argumentos)
            if inspect.isawaitable(valor):
                valor = await valor
        except Exception as erro:
            resultado = Resultado(nome, False, str(erro))
        else:
            sucesso = not (ferramenta.verificacao and valor is False)
            resultado = Resultado(nome, sucesso, valor)
            if sucesso and ferramenta.verificacao:
                self.ultima_verificacao = self.alteracoes
        self.resultados.append(resultado)
        return resultado

    def estado(self) -> dict[str, Any]:
        return {'tarefas_pendentes': sum(not t.concluida for t in self.tarefas),
                'alteracoes_sem_verificacao': self.alteracoes > self.ultima_verificacao,
                'falhas': sum(not r.sucesso for r in self.resultados)}
