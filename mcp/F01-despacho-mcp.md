# F01 — argumento de ferramenta MCP era alterado antes de sair

Documento do conserto. Tudo o que mudou, com o código, e os testes que provam.

---

## 1. A causa

`backend/app/tools/ferramentas.py`, função `_executar_impl()`. A linha

```python
argumentos = _sinonimos(argumentos or {})
```

rodava **antes** do desvio para MCP. `_sinonimos()` (`backend/app/tools/registry.py`) é uma
tradução do catálogo **nativo** (`path`→`caminho`, `limit`→`limite`, `content`→`conteudo`…) e
ela **acrescenta** a chave, não troca:

```python
def _sinonimos(argumentos: dict[str, Any]) -> dict[str, Any]:
    """Renomeia os campos escritos como sinônimo, sem nunca perder o canônico."""
    if not argumentos:
        return {}
    normalizado: dict[str, Any] = {}
    for chave, valor in argumentos.items():
        normalizado[str(chave)] = valor
    for chave, valor in list(normalizado.items()):
        destino = SINONIMOS.get(chave.lower())
        if destino and destino not in normalizado:
            normalizado[destino] = valor      # <-- acrescenta, não troca
    return normalizado
```

Aplicada a uma chamada de **servidor externo**, o servidor recebia um campo que o modelo nunca
mandou. Não era erro do modelo: quem alterava a chamada era o Koda. Com esquema fechado
(`additionalProperties: false`, comum em MCP de terceiro) o servidor recusa — e o modelo vai
procurar o erro no lugar errado.

---

## 2. A prova (medida, não deduzida)

Servidor MCP de mentira que devolve o JSON dos argumentos que recebeu. Chamada feita com o
payload do modelo `{"a": 1, "limit": 5}` — `limit` é sinônimo de `limite` no catálogo nativo,
é ele que denuncia o vazamento.

| | modelo mandou | servidor viu |
|---|---|---|
| **antes** | `{"a": 1, "limit": 5}` | `{"a": 1, "limit": 5, "limite": 5}` |
| **depois** | `{"a": 1, "limit": 5}` | `{"a": 1, "limit": 5}` |

Os dois servidores que vêm no Koda (`dev-browser`, `dev-logs`) usam nomes de campo em
português e esquema aberto — por isso o defeito ficava **latente** aqui e só mordia servidor
de fora (Playwright, filesystem, GitHub), que usa `path`/`limit`/`content` em inglês.

---

## 3. O que mudou no código

### 3.1 `backend/app/tools/ferramentas.py` — o núcleo

Ordem nova em `_executar_impl`:

```
canonico(nome)  →  KODA_TOOLS_DENY  →  MCP (mcp__…)  →  _sinonimos(argumentos)
```

**Antes:**

```python
    argumentos = _sinonimos(argumentos or {})
    nome = canonico(nome)
    if negadas and nome in {canonico(item) for item in negadas}:
        return f"ERRO: a ferramenta {nome} está desligada (KODA_TOOLS_DENY)."

    if nome.startswith(mcp.PREFIXO):
        restante = _restante_da_ferramenta()
        _permitido, saida = mcp.executar(nome, argumentos, tempo_s=restante)
        return saida
```

**Depois:**

```python
    # `canonico` só baixa a caixa do nome; não toca nos argumentos. Ele vem antes de tudo
    # porque é ele que a porteira usa para decidir se a chamada passa — o nome oferecido no
    # catálogo e o despachado aqui não podem divergir.
    nome = canonico(nome)
    if negadas and nome in {canonico(item) for item in negadas}:
        return f"ERRO: a ferramenta {nome} está desligada (KODA_TOOLS_DENY)."

    # Ferramenta de servidor MCP: roda **fora**, no processo do servidor. Vem antes de tudo
    # — inclusive de `_sinonimos`, e é esse o ponto (F01). Os argumentos de uma ferramenta
    # externa são do **contrato do servidor**, não do nosso: `_sinonimos` existe para o
    # modelo poder escrever `path` numa ferramenta nativa que espera `caminho`, e ele
    # **acrescenta** a chave em vez de trocar (`{"path": …}` vira `{"path": …, "caminho": …}`).
    # Aplicado aqui, isso manda ao servidor um campo que ele não pediu — e um servidor de
    # esquema fechado recusa a chamada com o modelo tendo acertado. Quem altera a chamada
    # passa a ser o Koda, e o erro aparece do lado errado. Por isso: nada de normalizar
    # argumento de fora.
    #
    # O desvio é pelo **prefixo**, e não por estar no mapa: um servidor que cai no meio da
    # rodada deixa o nome oferecido e fora do mapa, e aí o certo é a recusa explicada ("não
    # está disponível") — não "ferramenta desconhecida", que mandaria o modelo procurar o
    # erro no lugar errado. O prazo restante da tarefa é repassado: um servidor MCP que
    # trava não pode prender a tarefa além do que ela já tinha.
    if nome.startswith(mcp.PREFIXO):
        restante = _restante_da_ferramenta()
        _permitido, saida = mcp.executar(nome, argumentos or {}, tempo_s=restante)
        # A recusa já vem com a marca `ERRO:` no texto — é o contrato das ferramentas, e é o
        # que o laço lê para saber que o passo falhou.
        return saida

    # Daqui para baixo é ferramenta do Koda: aí sim vale o sinônimo.
    argumentos = _sinonimos(argumentos or {})
```

Duas coisas **não** mudaram de lugar, de propósito:

- `canonico()` continua primeiro: é ele que a porteira (`guards`) usa para decidir se a
  chamada passa. O nome oferecido no catálogo e o despachado não podem divergir — e ele só
  baixa a caixa do nome, não encosta nos argumentos.
- A checagem de `KODA_TOOLS_DENY` continua **antes** do MCP. Se subisse junto com o desvio,
  uma ferramenta MCP proibida voltaria a rodar — buraco de segurança.

### 3.2 `backend/app/contracts/turn.py` — o trace

`ToolStep` ganhou `raw_arguments`: a chamada **como o modelo a escreveu**, em texto.

```python
    name: str
    arguments: dict[str, Any]
    output: str
    duration_ms: int
    call_id: str = ""
    ok: bool = True
    #: A chamada **como o modelo a escreveu**, em texto. `arguments` é essa mesma chamada já
    #: desserializada, e é ela que a ferramenta recebe. Este campo existe para os casos em que
    #: não há o que desserializar: JSON cortado no meio (`finish_reason: "length"`) chega como
    #: `{}`, e o passo ficava sem nenhum registro do que o modelo tinha mandado — quem
    #: depurava via só "caminho vazio" e ia procurar o erro na ferramenta.
    raw_arguments: str = ""
```

E entra no `to_dict()`:

```python
    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "arguments": self.arguments,
            "output": self.output,
            "duration_ms": self.duration_ms,
            "call_id": self.call_id,
            "ok": self.ok,
            "raw_arguments": self.raw_arguments,
            "mcp": self.mcp,
        }
```

`arguments` já era a original desserializada — o texto fecha o caso em que não há o que
desserializar.

### 3.3 `backend/app/schemas.py` — a rota

```python
    duration_ms: int = 0
    call_id: str = ""
    ok: bool = True
    """A chamada como o modelo a escreveu, em texto (ver `contracts.turn.ToolStep`)."""
    raw_arguments: str = ""
```

Campo com default, então mensagem antiga gravada no banco continua validando (`model_validate`
na leitura do histórico). Vai para o SQLite via `[passo.model_dump() for passo in message.steps]`.

### 3.4 `backend/app/routers/chat.py` — a ponte

```python
                call_id=passo.call_id,
                ok=passo.ok,
                raw_arguments=passo.raw_arguments,
```

### 3.5 `backend/app/agent/loop.py` — os 7 pontos que montam `ToolStep`

Uma linha em cada um (o `chamada` já está em escopo):

```python
                        raw_arguments=chamada.raw_arguments,
```

Nas linhas 2216, 2250, 2285, 2333, 2366, 2425 e 2549. São os passos de: orçamento de chamadas
estourado, JSON inválido, recusa da porteira, repetição (aviso e encerramento), permissão
negada, e a execução de verdade. Todos passam a registrar a chamada literal do modelo.

### 3.6 `src/api/client.ts` — o tipo

```ts
  call_id: string
  ok: boolean
  /**
   * A chamada como o modelo a escreveu, em texto. Vem do histórico (a conversa reaberta);
   * a tela não desenha isto — está aqui para o `arguments` acima ter o original ao lado
   * quando o JSON do modelo não desserializou (resposta cortada no teto de tokens).
   */
  raw_arguments?: string
```

---

## 4. Os testes

### 4.1 Regressão — `backend/tests/test_mcp.py`

Vai no fim do arquivo, depois de `test_ferramentas_mcp_nao_sao_confundidas_com_as_do_koda`.
(Esta pasta é local, não viaja com o branch.)

```python
#: Servidor que devolve, como texto, o JSON dos argumentos que **recebeu**.
SERVIDOR_ECO = r'''
import json, sys
for linha in sys.stdin:
    linha = linha.strip()
    if not linha:
        continue
    msg = json.loads(linha)
    metodo, ident = msg.get("method"), msg.get("id")
    if metodo == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": ident, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "eco"}}}), flush=True)
    elif metodo == "tools/list":
        print(json.dumps({"jsonrpc": "2.0", "id": ident, "result": {"tools": [
            {"name": "eco_args", "description": "Devolve os argumentos recebidos.",
             "inputSchema": {"type": "object", "additionalProperties": False,
                             "properties": {"a": {"type": "number"},
                                            "limit": {"type": "number"}}}}]}}), flush=True)
    elif metodo == "tools/call":
        argumentos = (msg.get("params") or {}).get("arguments") or {}
        print(json.dumps({"jsonrpc": "2.0", "id": ident, "result": {
            "content": [{"type": "text", "text": json.dumps(argumentos, sort_keys=True)}]}}), flush=True)
'''


@pytest.fixture()
def servidor_eco(tmp_path: Path):
    """Gerenciador apontado para o servidor que ecoa os argumentos."""
    caminho = tmp_path / "eco.py"
    caminho.write_text(SERVIDOR_ECO, encoding="utf-8")
    config = tmp_path / "mcps.json"
    config.write_text(
        json.dumps([{"name": "eco", "command": sys.executable, "params": f'"{caminho}"'}]),
        encoding="utf-8",
    )
    mcp.configurar(config)
    try:
        mcp.preparar()
        yield
    finally:
        mcp.configurar(None)


def test_mcp_recebe_o_argumento_do_modelo_intacto(servidor_eco, tmp_path: Path) -> None:
    """F01 — `_sinonimos` é para ferramenta do Koda; o argumento de fora vai **intacto**.

    `limit`→`limite` é tradução do catálogo nativo. Aplicada à chamada de um servidor MCP,
    ela não troca nada: **acrescenta** ao servidor uma chave que o modelo não mandou
    (`{"a", "limit"}` virava `{"a", "limit", "limite"}`). Um servidor de esquema fechado
    recusa a chamada — com o modelo tendo acertado, e o erro aparecendo do lado errado.
    """
    from app.tools import ferramentas

    enviado = {"a": 1, "limit": 5}
    saida = ferramentas.executar("mcp__eco__eco_args", enviado, tmp_path, acesso_livre=True)

    assert json.loads(saida) == enviado
    # E o dicionário do modelo não foi tocado no caminho.
    assert enviado == {"a": 1, "limit": 5}
```

O `import` no corpo do teste é de propósito: o arquivo é **pulado** numa árvore sem o MCP
(`pytest.importorskip("app.mcp")` no topo), e `app.tools.ferramentas` importa `mcp`.

### 4.2 Script de bancada — `diagnostico-anexos/f01-prova.py`

Roda fora do pytest, imprime antes/depois e devolve código de saída 1 se o vazamento voltar.

```python
"""F01 — prova de que os argumentos chegam transformados ao servidor MCP.

Servidor MCP de mentira que devolve, como texto, o JSON dos argumentos que **recebeu**.
Se `ferramentas.executar` deixar `_sinonimos` passar na frente, o servidor recebe
`limit` **e** `limite` — o modelo mandou um só.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "backend"))

from app import mcp  # noqa: E402
from app.tools import ferramentas  # noqa: E402

SERVIDOR = r'''
import json, sys
for linha in sys.stdin:
    linha = linha.strip()
    if not linha:
        continue
    msg = json.loads(linha)
    metodo, ident = msg.get("method"), msg.get("id")
    if metodo == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": ident, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "eco"}}}), flush=True)
    elif metodo == "tools/list":
        print(json.dumps({"jsonrpc": "2.0", "id": ident, "result": {"tools": [
            {"name": "eco_args", "description": "Devolve os argumentos.",
             "inputSchema": {"type": "object", "additionalProperties": False,
                             "properties": {"a": {"type": "number"},
                                            "limit": {"type": "number"}}}}]}}), flush=True)
    elif metodo == "tools/call":
        args = (msg.get("params") or {}).get("arguments") or {}
        print(json.dumps({"jsonrpc": "2.0", "id": ident, "result": {
            "content": [{"type": "text", "text": json.dumps(args, sort_keys=True)}]}}), flush=True)
'''


def main() -> int:
    pasta = RAIZ / "diagnostico-anexos"
    (pasta / "f01-servidor.py").write_text(SERVIDOR, encoding="utf-8")
    config = pasta / "f01-mcps.json"
    config.write_text(
        json.dumps([{"name": "eco", "command": sys.executable,
                     "params": f'"{pasta / "f01-servidor.py"}"'}]),
        encoding="utf-8",
    )

    mcp.configurar(config)
    mcp.preparar()
    try:
        enviado = {"a": 1, "limit": 5}
        saida = ferramentas.executar(
            "mcp__eco__eco_args", enviado, RAIZ, acesso_livre=True
        )
    finally:
        mcp.configurar(None)

    print("modelo mandou :", json.dumps(enviado, sort_keys=True))
    print("servidor viu  :", saida)
    print("dicionario do modelo depois da chamada:", json.dumps(enviado, sort_keys=True))
    vazou = "limite" in saida
    print()
    print("VEREDITO:", "VAZOU sinônimo para o MCP (F01 presente)" if vazou
          else "argumentos chegaram intactos (F01 corrigido)")
    return 1 if vazou else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

---

## 5. Como rodar

```bash
cd C:/Users/Administrator/Downloads/koda

# a prova, com o antes/depois
./backend/.venv/Scripts/python.exe diagnostico-anexos/f01-prova.py

# a regressão
cd backend && KODA_API_TOKEN=koda-dev ./.venv/Scripts/python.exe -m pytest tests/test_mcp.py -q
```

Saída do script depois do conserto:

```
modelo mandou : {"a": 1, "limit": 5}
servidor viu  : {"a": 1, "limit": 5}
dicionario do modelo depois da chamada: {"a": 1, "limit": 5}

VEREDITO: argumentos chegaram intactos (F01 corrigido)
```

---

## 6. Estado dos testes

- `tests/test_mcp.py` — **7 passaram**.
- Bateria maior (`test_tools`, `test_modo_da_rodada`, `test_api`, `test_projetos`,
  `test_contexto`, `test_arquitetura`) — **268 passaram, 2 falharam**:
  `test_skills_lista_com_estado_e_toggle` e `test_mcps_vazio_sem_config`.
  **Pré-existentes nesta máquina**, confirmado com `git stash`: falham sem as mudanças do F01.
  São de árvore — o `mcps.json` e a skill global da máquina vazam para a suíte
  (`assert 'global' == 'projeto'`, `assert [...navegador, logs...] == []`). Não é F01.

---

## 7. Arquivos tocados

| Arquivo | O que mudou |
|---|---|
| `backend/app/tools/ferramentas.py` | o conserto: MCP antes de `_sinonimos` |
| `backend/app/contracts/turn.py` | `ToolStep.raw_arguments` + `to_dict()` |
| `backend/app/schemas.py` | `ToolStepOut.raw_arguments` |
| `backend/app/routers/chat.py` | passa `raw_arguments` para a resposta |
| `backend/app/agent/loop.py` | 7 linhas, uma por ponto que monta `ToolStep` |
| `src/api/client.ts` | `raw_arguments?: string` no tipo |
| `backend/tests/test_mcp.py` | teste de regressão (local, não versionado) |
| `diagnostico-anexos/f01-prova.py` | script de bancada (não versionado) |

`6 arquivos mudados, 44 inserções, 8 remoções` (fora os de bancada).

---

## 8. O que **não** foi mexido, e por quê

- **`alvos()` e `classificar()`** também chamam `_sinonimos`, mas só alcançam ferramenta
  nativa. Conferido: `ferramentas.classificar('mcp__eco__eco_args', {...})` devolve `None` e
  `ferramentas.alvos('mcp__eco__eco_args', {...})` devolve `[]`. Nenhum dos dois muta o
  dicionário do modelo — `_sinonimos` devolve cópia.
- **`_sinonimos` em si** continua igual: para ferramenta nativa ele é útil e correto.
