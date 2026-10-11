## Relatório QA — F03 e F04

Revisei o checkout atual e reproduzi os casos com fixtures MCP temporários. **Não alterei arquivos do projeto.** Já havia alterações locais antes da revisão, inclusive em `backend/app/mcp/__init__.py`; o relatório descreve esse estado de trabalho.

### F03 — MCPs dependem de Node instalado

**Causa:** os dois MCPs habilitados em \[mcps.json (line 5)\](/C:/Users/Administrator/Downloads/koda/mcp/mcps.json:5) iniciam com `command: "node"`. O cliente executa esse nome diretamente pelo `PATH` em \[cliente.py (line 134)\](/C:/Users/Administrator/Downloads/koda/backend/app/mcp/cliente.py:134). A lista de recursos do instalador inclui `mcp` e Python, mas não Node, em \[tauri.conf.json (line 49)\](/C:/Users/Administrator/Downloads/koda/src-tauri/tauri.conf.json:49).

**QA:** simulei `PATH` sem Node. O servidor ficou `conectado: false`, o status informou que não conseguiu iniciar `node` e o catálogo ficou vazio. A indicação de estado é correta, mas não explica ao usuário como habilitar o recurso. Não executei o instalador real nem uma VM limpa.

O texto do instalador diz que o usuário não precisa instalar “nenhum outro programa” em \[hooks.nsh (line 73)\](/C:/Users/Administrator/Downloads/koda/src-tauri/installer/hooks.nsh:73), embora Node seja exigido. O navegador também depende de Chrome ou Edge já presentes; o próprio servidor informa quando não encontra nenhum em \[server.mjs (line 62)\](/C:/Users/Administrator/Downloads/koda/mcp/dev-browser/server.mjs:62). Não encontrei Git como dependência desses dois MCPs.

**Correção sugerida:** incluir um runtime Node compatível no pacote e iniciá-lo pelo caminho dentro dos recursos do app, ou remover essa dependência. Se Node continuar sendo pré-requisito, informar claramente qual recurso fica indisponível e como habilitá-lo. Ajustar a mensagem do instalador e verificar Chrome/Edge somente para o recurso de navegador.

### F04 — paginação, mudanças no catálogo e nomes de ferramentas

**QA com servidor MCP temporário:**

| Caso                                                     | Resultado                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Duas páginas, com `nextCursor`                           | **Falhou:** o cliente fez uma chamada sem cursor e não encontrou a ferramenta da segunda página.                                             |
| `notifications/tools/list_changed`                       | **Falhou:** o catálogo continuou antigo; nenhuma nova chamada `tools/list` ocorreu.                                                          |
| Nome `ação`                                              | **Falhou:** o identificador externo preservou os acentos e não passou pela validação ASCII simulada. O mapa reverso manteve o nome original. |
| Colisão `x-y` / `x.y`, com ordem invertida após reinício | **Falhou:** os dois nomes viraram `x_y` e trocaram entre o identificador simples e o identificador com sufixo.                               |
| Processo MCP encerrado                                   | **Falhou:** o status passou a desconectado, mas sem erro; o catálogo ainda expôs a ferramenta em cache.                                      |
| Versão anunciada pelo servidor                           | **Falhou:** o cliente aceitou `9999-99-99`. Um servidor que recusou `initialize` falhou com erro de método recusado.                         |

Os pontos principais estão em \[cliente.py (line 215)\](/C:/Users/Administrator/Downloads/koda/backend/app/mcp/cliente.py:215): uma única chamada para `tools/list` e cache local; notificações sem `id` são ignoradas em \[cliente.py (line 361)\](/C:/Users/Administrator/Downloads/koda/backend/app/mcp/cliente.py:361). O mapa do gerenciador também continua ativo após a queda, como mostrou o teste, em \[_\_init\__.py (line 236)\](/C:/Users/Administrator/Downloads/koda/backend/app/mcp/_\_init\__.py:236). A normalização preserva letras Unicode via `isalnum()` em \[cliente.py (line 433)\](/C:/Users/Administrator/Downloads/koda/backend/app/mcp/cliente.py:433); o sufixo de colisão usa o nome já normalizado em \[_\_init\__.py (line 208)\](/C:/Users/Administrator/Downloads/koda/backend/app/mcp/_\_init\__.py:208).

Há ainda uma questão de compatibilidade: o cliente anuncia `2024-11-05` em \[cliente.py (line 38)\](/C:/Users/Administrator/Downloads/koda/backend/app/mcp/cliente.py:38) e guarda a versão retornada sem validá-la. A especificação MCP publicada em 28 de julho de 2026 aposentou o handshake `initialize`/`initialized`; a revisão atual usa metadados por solicitação e descreve mudanças de lista por `subscriptions/listen`. Isso requer uma decisão explícita sobre quais gerações do protocolo o app suporta e testes para cada uma. [Especificação MCP 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/) A paginação usa cursor opaco, e a especificação recomenda que clientes suportem fluxos paginados. [Especificação de paginação](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination) A especificação de ferramentas recomenda nomes ASCII com letras, dígitos, `_`, `-` e `.`. [Especificação de ferramentas](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

**Correção sugerida:** seguir `nextCursor` até o fim com limites para evitar loops; implementar a invalidação e reconstrução do catálogo para o protocolo suportado; rejeitar versões não suportadas com diagnóstico claro; retirar ferramentas do catálogo ao detectar queda; gerar identificadores externos ASCII estáveis a partir dos nomes originais, com desambiguação independente da ordem e mapa reverso.

**Aceite recomendado para T04:** servidor de duas páginas mostra todas as ferramentas; mudança de lista atualiza o catálogo; queda remove ferramentas e informa o estado; IDs ASCII não trocam de ferramenta após colisão, reordenação ou reinício; versões não suportadas não aparecem como conectadas.

### Limites da verificação

Os testes foram isolados e temporários; os arquivos de fixture foram removidos. Não rodei o instalador real, uma VM limpa nem a suíte completa do projeto. As referências internas R08/R14/R18/R15 não foram verificadas individualmente; confirmei os comportamentos diretamente no código e nos fixtures.


Precisa de `import asyncio` no topo do arquivo (ele já importa `json`, `sys`, `Path` e
`pytest`), e usa a fixture `servidor_eco` do F01.

### 4.2 `backend/tests/test_projetos.py` — dentro de `test_modos_decidem_o_que_pergunta`

```python
    # Ferramenta de servidor externo (MCP): pergunta em manual e em default — não há como
    # saber o que ela faz. Auto e Livre seguem sendo os modos sem pergunta (F02).
    externa = {"kinds": ["ferramenta_externa"], "escopos": {"ferramenta_externa": "mcp__eco__x"}}
    assert approvals.resolver(conn, externa, "default") == "perguntar"
    assert approvals.resolver(conn, externa, "manual") == "perguntar"
    assert approvals.resolver(conn, externa, "auto") == "seguir"
    assert approvals.resolver(conn, externa, "livre") == "seguir"
```

### 4.3 Script de bancada — `diagnostico-anexos/f02-prova.py`

Roda fora do pytest, com o servidor MCP de mentira do F01. Devolve 1 se o cartão não sair.

```python
"""F02 — prova de que a ferramenta MCP passa pelo cartão de permissão.

Antes: `ferramentas.classificar()` devolvia `None` para nome `mcp__…`; sem `kinds`, o
`approvals.resolver` respondia «seguir» e a ferramenta rodava **sem pergunta nenhuma**.

Usa o servidor MCP de mentira do F01 (`f01-servidor.py`), que ecoa os argumentos: a
ferramenta precisa estar **oferecida** para a porteira deixar passar, e é só depois dela
que o `classificar` entra.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "backend"))

from app import mcp  # noqa: E402
from app.agent.loop import StepResult, ToolCall, executar  # noqa: E402
from app.db import Database  # noqa: E402
from app.policy import approvals  # noqa: E402
from app.tools import ferramentas  # noqa: E402

NOME = "mcp__eco__eco_args"


class ModeloFalso:
    name = "falso"
    ready = True

    def __init__(self) -> None:
        self.passos = [
            StepResult(
                text="",
                calls=[
                    ToolCall(
                        id="call-1",
                        name=NOME,
                        arguments={"a": 1, "limit": 5},
                        raw_arguments='{"a": 1, "limit": 5}',
                    )
                ],
            )
        ]

    async def step(self, messages, tools, model: str = "", escolha_ferramenta=None):
        if self.passos:
            return self.passos.pop(0)
        return StepResult(text="parei")


def main() -> int:
    pasta_bancada = RAIZ / "diagnostico-anexos"
    config = pasta_bancada / "f01-mcps.json"
    mcp.configurar(config)
    mcp.preparar()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            pasta = Path(tmp)

            print("1) o que o classificar diz de uma ferramenta MCP")
            acao = ferramentas.classificar(NOME, {"a": 1, "limit": 5}, pasta)
            print("   ", json.dumps(acao, ensure_ascii=False))
            if acao is None:
                print("\nVEREDITO: None — o cartão não sai (F02 presente)")
                return 1
            print()

            print("2) o que cada modo faz com essa ação")
            banco = Database(pasta / "koda.db")
            banco.initialize()
            with banco.connect() as conn:
                for modo in approvals.MODOS:
                    print(f"    {modo:8} -> {approvals.resolver(conn, acao, modo)}")
            print()

            print("3) o loop: o modelo chama a ferramenta MCP, modo default, pessoa nega")
            eventos: list[tuple[str, dict]] = []
            perguntas: list[dict] = []

            async def emit(evento, dados):
                eventos.append((evento, dados))

            async def aprovar(info):
                perguntas.append(info)
                return "nao"

            asyncio.run(
                executar(
                    ModeloFalso(),
                    [{"role": "user", "content": "rode a ferramenta eco e me diga o resultado"}],
                    workspace=pasta,
                    max_steps=2,
                    emit=emit,
                    aprovar=aprovar,
                )
            )

            resultado = next(dados for evento, dados in eventos if evento == "tool_result")
            print("    perguntou?", bool(perguntas),
                  "| kinds:", perguntas[0]["kinds"] if perguntas else None)
            print("    resultado:", resultado["output"][:100])
            print("    negado:", resultado.get("negado"))
            print()

            ok = bool(perguntas) and perguntas[0]["kinds"] == ["ferramenta_externa"]
            print("VEREDITO:", "a ferramenta MCP passa pelo cartão (F02 corrigido)" if ok
                  else "a ferramenta MCP rodou sem pergunta (F02 presente)")
            return 0 if ok else 1
    finally:
        mcp.configurar(None)


if __name__ == "__main__":
    raise SystemExit(main())
```

---

## 5. Como rodar

```bash
cd C:/Users/Administrator/Downloads/koda

# a prova, com o antes/depois
./backend/.venv/Scripts/python.exe diagnostico-anexos/f02-prova.py

# os testes
cd backend && KODA_API_TOKEN=koda-dev ./.venv/Scripts/python.exe -m pytest tests/test_mcp.py tests/test_projetos.py -q
```

---

## 6. Estado dos testes

- `tests/test_mcp.py` + `tests/test_projetos.py` — **22 passaram**.
- Bateria maior (`test_tools`, `test_modo_da_rodada`, `test_api`, `test_seguranca`,
  `test_contexto`, `test_arquitetura`, `test_skills`) — **292 passaram, 2 falharam**:
  `test_skills_lista_com_estado_e_toggle` e `test_mcps_vazio_sem_config`.
  **Pré-existentes nesta máquina** (já falhavam antes do F01), de árvore — o `mcps.json` e a
  skill global da máquina vazam para a suíte. Não é F02.

---

## 7. Arquivos tocados

| Arquivo | O que mudou |
|---|---|
| `backend/app/tools/ferramentas.py` | ramo MCP no `classificar` + `_acao_de_mcp` |
| `backend/app/mcp/__init__.py` | `descricao(nome)` — o que o servidor diz da ferramenta |
| `backend/app/policy/approvals.py` | tipo `ferramenta_externa` em `KINDS`/`PERGUNTA`/`ROTULO` |
| `backend/tests/test_mcp.py` | 3 testes (local, não versionado) |
| `backend/tests/test_projetos.py` | caso novo em `test_modos_decidem_o_que_pergunta` |
| `diagnostico-anexos/f02-prova.py` | script de bancada (não versionado) |

---

## 8. Decisões, com o porquê

**Toda ferramenta MCP pergunta — não só as "perigosas".** Não existe, no Koda, como saber
qual ferramenta de fora é perigosa: quem decide o que ela faz é o servidor. Classificar por
nome (`executar_js` pergunta, `ler` não) seria heurística de texto — e errar para o lado
permissivo é exatamente o furo que o F02 é.

**As `annotations` do MCP não são consultadas.** A especificação do MCP tem
`annotations.readOnlyHint` / `destructiveHint`, mas elas são uma dica que o **próprio
servidor** escreve sobre si mesmo, e a especificação diz que clientes não devem apoiar
decisão de segurança nelas. Usar isso como passe livre trocaria um furo por outro: bastaria
um servidor (ou um servidor comprometido) marcar `readOnlyHint: true` na ferramenta que
apaga tudo.

**Auto e Livre continuam sem perguntar.** São os modos em que a pessoa já dispensou a
pergunta — `chat.py` passa `aprovar=None` neles. Estender a pergunta para lá seria mudar o
significado dos modos por conta própria.

**O escopo de «sempre» é a ferramenta, não o servidor.** `mcp__servidor__ferramenta`, e não
`mcp__servidor__*`. Dizer "sempre" numa ferramenta de leitura não pode liberar a que executa
código.

**Custo de UX, honesto:** em modo `default` — o padrão —, a primeira chamada de cada
ferramenta MCP passa a pedir cartão. O escape é o "Sempre permitir", que fica lembrado
por ferramenta e não volta a perguntar. Para os dois servidores que vêm no Koda
(`dev-browser`, `dev-logs`), isso é um punhado de cartões uma vez. Se a preferência for que
ferramenta declaradamente só-leitura passe direto, isso é uma decisão à parte — e ela
precisa de uma fonte de confiança que hoje não existe.
