**F03: o Node que vem no pacote falha ao iniciar.** Ao executá-lo, o Windows mostrou `0xC0000142` (`STATUS_DLL_INIT_FAILED`). Com o `PATH` sem Node global, os MCPs `navegador` e `logs` ficaram desconectados, sem ferramentas. A falha está no runtime empacotado; **não consegui identificar qual DLL falha**. Para resolver, é preciso diagnosticar o carregamento dessa DLL, conferir origem e integridade do `node.exe` e validar o pacote numa VM limpa. Não tentei iniciá-lo de novo.

**F04: cursor vazio encerra a paginação antes da hora.** Em \[cliente.py (line 344)\](C:/Users/Administrator/Downloads/koda/backend/app/mcp/cliente.py:344) e \[cliente.py (line 354)\](C:/Users/Administrator/Downloads/koda/backend/app/mcp/cliente.py:354), o cliente trata `""` como ausência de cursor. Reproduzi: pediu uma página, ignorou a seguinte e informou conexão normal. O protocolo permite cursor vazio; a correção é distinguir `null/ausente` de string vazia ([especificação](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination)).

**F04: a lista pode ficar velha no modo stateless.** Depois da primeira listagem, meu servidor de teste mudou de `old` para `new`, mas o cliente fez só uma chamada `tools/list` e continuou servindo `old`. Não implementa `subscriptions/listen` nem o tratamento de `ttlMs`, então não percebe a mudança ([notificações](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [cache](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)).

**F04: ao atingir o limite de páginas, o app apresenta resultado parcial como normal.** Reproduzi com limite de duas páginas: o catálogo mostrou duas ferramentas, `conectado: true` e nenhum erro no status, embora o servidor ainda tivesse mais páginas. O cliente guarda um erro interno, mas ele não chega ao status público. Deve marcar a conexão/catálogo como incompleto e expor o erro, sem apresentar a lista parcial como completa.



```

---

## 3. A decisão sobre as gerações

**As duas.** O dono escolheu, e a razão de não ser uma só:

- falar só `2024-11-05` quebraria com todo servidor que já migrou — a geração nova não tem
  `initialize`, então o servidor aparece como "não suportado" e o usuário fica sem o recurso;
- falar só `2026-07-28` quebraria com a maioria do que existe hoje.

A detecção é por resposta (erro `-32601` no `initialize`), então não há adivinhação nem
requisição desperdiçada: o servidor da geração antiga negocia normalmente, e o da nova
recusa o método e recebe o caminho stateless.

**O que ficou para depois nesta rodada, e foi feito na segunda:** `subscriptions/listen` e o
`ttlMs` — ver a seção 9. Sem os dois, um servidor stateless podia mudar de lista que o Koda
continuava servindo a antiga.

---


## 4. Os testes

Todos em `backend/tests/test_mcp.py` (local, não viaja com o branch). Um servidor de mentira
parametrizável por `argv` cobre os seis casos:

```python
SERVIDOR_FLEX = r'''
import json, sys

OPCOES = {a.split("=")[0]: a.split("=", 1)[1] for a in sys.argv[1:] if "=" in a}
PAGINAS = int(OPCOES.get("paginas", "1"))
VERSAO = OPCOES.get("versao", "2024-11-05")
STATELESS = OPCOES.get("stateless") == "1"
MUDAR = OPCOES.get("mudar") == "1"
NOMES = [n for n in OPCOES.get("nomes", "eco_args").split(",") if n]

def ferramenta(nome):
    return {"name": nome, "description": "Ferramenta de teste.",
            "inputSchema": {"type": "object", "properties": {}}}

def responder(ident, resultado):
    print(json.dumps({"jsonrpc": "2.0", "id": ident, "result": resultado}), flush=True)

listagens = 0
for linha in sys.stdin:
    linha = linha.strip()
    if not linha:
        continue
    msg = json.loads(linha)
    metodo, ident = msg.get("method"), msg.get("id")
    params = msg.get("params") or {}
    if metodo == "initialize":
        if STATELESS:
            print(json.dumps({"jsonrpc": "2.0", "id": ident, "error": {
                "code": -32601, "message": "method not found"}}), flush=True)
        else:
            responder(ident, {"protocolVersion": VERSAO, "capabilities": {},
                              "serverInfo": {"name": "flex"}})
    elif metodo == "tools/list":
        if STATELESS:
            meta = params.get("_meta") or {}
            if not meta.get("io.modelcontextprotocol/protocolVersion"):
                print(json.dumps({"jsonrpc": "2.0", "id": ident, "error": {
                    "code": -32602, "message": "falta _meta"}}), flush=True)
                continue
        listagens += 1
        # Com MUDAR, a segunda listagem responde uma lista **diferente**: e o que prova que
        # o aviso de mudanca refez o catalogo, e nao que o cliente releu a mesma coisa.
        nomes = NOMES + (["nova_ferramenta"] if MUDAR and listagens > 1 else [])
        if PAGINAS > 1 and not params.get("cursor"):
            responder(ident, {"tools": [ferramenta(nomes[0])], "nextCursor": "pagina-2"})
        elif PAGINAS > 1:
            responder(ident, {"tools": [ferramenta(n) for n in nomes[1:]]})
        else:
            responder(ident, {"tools": [ferramenta(n) for n in nomes]})
        if MUDAR and listagens == 1:
            print(json.dumps({"jsonrpc": "2.0", "method": "notifications/tools/list_changed",
                              "params": {}}), flush=True)
    elif metodo == "tools/call":
        responder(ident, {"content": [{"type": "text", "text": "ok"}]})
'''


@pytest.fixture()
def servidor_flex(tmp_path: Path):
    """Sobe um servidor de mentira com as opções pedidas e devolve o config usado."""
    contador = {"n": 0}

    def _montar(**opcoes: object) -> Path:
        contador["n"] += 1
        caminho = tmp_path / f"flex{contador['n']}.py"
        caminho.write_text(SERVIDOR_FLEX, encoding="utf-8")
        args = " ".join(f"{chave}={valor}" for chave, valor in opcoes.items())
        config = tmp_path / f"mcps{contador['n']}.json"
        config.write_text(
            json.dumps(
                [{"name": "flex", "command": sys.executable,
                  "params": f'"{caminho}" {args}'.strip()}]
            ),
            encoding="utf-8",
        )
        mcp.configurar(config)
        mcp.preparar()
        return config

    try:
        yield _montar
    finally:
        mcp.configurar(None)
```

Os sete testes que ele sustenta:

```python
def test_mcp_segue_a_paginacao_ate_o_fim(servidor_flex) -> None:
    """F04 — `tools/list` em duas páginas: a ferramenta da segunda tem de existir.

    Ler só a primeira página era o defeito: o servidor respondia `nextCursor` e a ferramenta
    da página seguinte simplesmente não existia para o Koda.
    """
    servidor_flex(paginas=2, nomes="primeira,segunda")

    nomes = [item["function"]["name"] for item in mcp.catalogo()]
    assert nomes == ["mcp__flex__primeira", "mcp__flex__segunda"]


def test_mcp_aviso_de_mudanca_refaz_o_catalogo(servidor_flex) -> None:
    """F04 — `notifications/tools/list_changed` tem de invalidar o catálogo.

    Antes, notificação (mensagem sem `id`) caía fora em silêncio: o catálogo ficava velho até
    o app reiniciar.
    """
    servidor_flex(mudar=1, nomes="eco_args")

    with mcp.gerenciador._trava:
        cliente = mcp.gerenciador._ligacoes["flex"].cliente
    assert cliente is not None

    # O aviso é uma **notificação**: chega pela thread de leitura, logo depois da listagem.
    # Esperar por ele é o certo — sem isto o teste dependeria de o `tools/list` ter sido
    # lento, e passaria ou falharia por acaso.
    limite = time.monotonic() + 5
    while not cliente.mudou and time.monotonic() < limite:
        time.sleep(0.02)
    assert cliente.mudou, "o servidor avisou da mudança e o cliente não percebeu"

    nomes = [item["function"]["name"] for item in mcp.catalogo()]
    assert "mcp__flex__nova_ferramenta" in nomes


def test_mcp_servidor_que_morre_sai_do_catalogo(servidor_flex) -> None:
    """F04 — processo morto não publica ferramenta.

    O cache do cliente continuava listando o que ele oferecia antes de cair, e o modelo
    chamava uma ferramenta que não existia mais.
    """
    servidor_flex(nomes="eco_args")
    assert mcp.catalogo()  # vivo: publica

    with mcp.gerenciador._trava:
        ligacao = mcp.gerenciador._ligacoes["flex"]
    assert ligacao.cliente is not None
    ligacao.cliente._processo.kill()  # type: ignore[union-attr]
    ligacao.cliente._processo.wait(timeout=5)  # type: ignore[union-attr]

    assert mcp.catalogo() == []
    estado = mcp.status()[0]
    assert estado["conectado"] is False
    assert estado["ferramentas"] == 0
    assert estado["erro"] and "encerrou" in estado["erro"]


def test_mcp_nome_com_acento_vira_ascii() -> None:
    """F04 — o identificador externo é ASCII, como a especificação recomenda.

    `isalnum()` do Python aceita `é`, e era por ali que o acento passava para dentro do nome
    de função. O acento é **removido** (`ação` -> `acao`), não trocado por separador.
    """
    assert nome_seguro("ação") == "acao"
    assert nome_seguro("Configuração.Inicial") == "configuracao_inicial"
    assert nome_seguro("Café-com-Leite") == "cafe_com_leite"
    # O que não tem transliteração honesta vira separador — e o nome continua ASCII.
    assert nome_seguro("名前").isascii()
    assert nome_seguro("").isascii()


def test_mcp_colisao_nao_depende_da_ordem() -> None:
    """F04 — `x-y` e `x.y` normalizam para o mesmo `x_y`; o ID não pode trocar de dono.

    O sufixo de desempate saía da ordem de iteração: bastava o servidor trocar a ordem da
    lista (ou um reinício) para as duas ferramentas trocarem de identificador entre si — e a
    conversa antiga passaria a chamar a ferramenta errada.
    """
    from app.mcp import Ligacao, Servidor

    class ClienteFalso:
        vivo = True

        def __init__(self, nomes: list[str]) -> None:
            self._ferramentas = [FerramentaMCP(nome=n, descricao="") for n in nomes]

        def ferramentas(self):
            return self._ferramentas

    def mapa(nomes: list[str]) -> dict[str, str]:
        ligacao = Ligacao(
            config=Servidor(nome="srv", comando="x"), cliente=ClienteFalso(nomes)
        )
        return {
            externo: real
            for externo, (_, real) in mcp.gerenciador._montar_mapa({"srv": ligacao}).items()
        }

    direta = mapa(["x-y", "x.y"])
    invertida = mapa(["x.y", "x-y"])

    assert direta == invertida, "o identificador trocou de dono com a ordem da lista"
    assert sorted(direta.values()) == ["x-y", "x.y"]
    # Os dois nomes colidiram na normalização, então os dois levam sufixo — e não só o
    # segundo a chegar.
    assert all(externo.endswith("_") or "_" in externo for externo in direta)
    assert len(set(direta)) == 2


def test_mcp_versao_nao_suportada_nao_conecta(servidor_flex) -> None:
    """F04 — versão de protocolo desconhecida não pode passar como conectada.

    O cliente aceitava qualquer string que o servidor devolvesse, `9999-99-99` inclusive, e
    seguia falando um protocolo que não conhece.
    """
    servidor_flex(versao="9999-99-99")

    assert mcp.catalogo() == []
    estado = mcp.status()[0]
    assert estado["conectado"] is False
    assert "9999-99-99" in str(estado["erro"])
    assert "2024-11-05" in str(estado["erro"])


def test_mcp_geracao_stateless_conecta(servidor_flex) -> None:
    """F04 — o servidor da geração `2026-07-28` (sem `initialize`) também conecta.

    Ele recusa o handshake com "método não encontrado", e é isso que diz ao cliente qual
    caminho seguir: sem sessão, com `_meta` em cada pedido. O servidor de teste só responde a
    `tools/list` se o `_meta` com a versão estiver lá.
    """
    servidor_flex(stateless=1, nomes="eco_args")

    nomes = [item["function"]["name"] for item in mcp.catalogo()]
    assert nomes == ["mcp__flex__eco_args"]
    assert mcp.status()[0]["conectado"] is True
```

---

## 5. Como rodar

```bash
cd C:/Users/Administrator/Downloads/koda/backend
KODA_API_TOKEN=koda-dev ./.venv/Scripts/python.exe -m pytest tests/test_mcp.py -q
```

---

## 6. Estado dos testes

- `tests/test_mcp.py` — **22 passaram** (12 novos do F04: 7 da primeira rodada, 5 da segunda).
- Suíte inteira — **479 passaram, 8 falharam**. As 8 falham **também na árvore limpa**
  (conferido com `git stash`): `test_api` (2, de árvore), `test_host` (3) e `test_tools` (3).
  Na árvore limpa eram **20** falhas: as restantes eram exatamente os testes do F04 e do F02,
  que só falhavam porque o recurso não existia.

---

## 7. Arquivos tocados

| Arquivo | O que mudou |
|---|---|
| `backend/app/mcp/cliente.py` | paginação, `listar()`/cache, notificações, `_meta`, versão, nomes ASCII, `ErroMCP.codigo` |
| `backend/app/mcp/__init__.py` | `_montar_mapa` ordenado, `_relistar`, queda no catálogo/status |
| `backend/tests/test_mcp.py` | servidor parametrizável + 7 testes (local) |

---

## 9. Segunda rodada: cursor vazio, lista velha e parcial como completo

Três achados novos, os três confirmados no código.

### 9.1 Cursor vazio encerrava a paginação — `cliente.py`

O código fazia `cursor = proximo if isinstance(proximo, str) and proximo else None`, e o
`if not cursor: break` cortava a paginação. A especificação é **explícita** em sentido contrário:

> Clients **MUST** treat cursors as opaque tokens: … Don't make any determination based on
> cursor value other than whether a **non-null** value was provided (e.g. **an empty string is a
> valid cursor and thus MUST NOT be treated as the end of results**)

A checagem passou a ser de **tipo**, e não de veracidade — nas duas pontas (ler o `nextCursor` e
montar os `params`):

```python
            # `cursor` **presente** é o que se manda — inclusive vazio. A especificação diz
            # que string vazia é cursor válido, e o `if cursor` daqui cortava a paginação na
            # primeira página de um servidor que usa `""` como primeiro cursor.
            resultado = self._pedir("tools/list", {} if cursor is None else {"cursor": cursor})
            ...
            proximo = resultado.get("nextCursor")
            # **Ausente/null** é o fim. `""` **não** é: ...
            if proximo is None:
                break
            if not isinstance(proximo, str):
                incompleto = (
                    f"o servidor MCP '{self.nome}' devolveu um 'nextCursor' que não é texto "
                    f"({type(proximo).__name__}); a paginação parou aí"
                )
                break
            cursor = proximo
```

Teste: `test_mcp_cursor_vazio_nao_encerra_a_paginacao`.

### 9.2 Lista velha no stateless — `cliente.py`

Faltavam os dois mecanismos que a `2026-07-28` dá para saber que a lista mudou:

**`subscriptions/listen`** — lá o aviso só vai para quem **pediu**. É um fluxo longo: o servidor
não responde de imediato (a resposta só vem quando o fluxo fecha), então o pedido sai sem espera
e o id fica guardado em `_escutas`:

```python
    def escutar_mudancas(self) -> bool:
        """Pede ao servidor para avisar quando a lista de ferramentas mudar.
        ...
        """
        if not self._stateless or not self.vivo:
            return False
        with self._trava:
            identificador = self._proximo_id
            self._proximo_id += 1
            self._escutas.add(identificador)
            try:
                self._escrever({
                    "jsonrpc": "2.0",
                    "id": identificador,
                    "method": "subscriptions/listen",
                    "params": self._com_meta({"notifications": {"toolsListChanged": True}}),
                })
            except ErroMCP:
                self._escutas.discard(identificador)
                return False
        return True
```

E o `_despachar` passou a reconhecer os dois casos que não são resposta de pedido comum: a
resposta de um id de escuta (que só chega no fechamento gracioso, ou com erro quando o servidor
não tem o método) e a `notifications/subscriptions/acknowledged`, que diz o que o servidor
aceitou:

```python
        if identificador is not None and identificador in self._escutas:
            self._escutas.discard(identificador)
            if mensagem.get("error"):
                self.escutando_lista = False
            return
        ...
        if metodo == "notifications/subscriptions/acknowledged":
            aceitos = params.get("notifications") if isinstance(params, dict) else None
            self.escutando_lista = bool(
                isinstance(aceitos, dict) and aceitos.get("toolsListChanged")
            )
```

**`ttlMs`** — a `2026-07-28` devolve o tempo de validade da lista em cada resposta paginada.
Sem ele, e sem a escuta, o cache ficava velho para sempre:

```python
def _expira_em(ttl_ms: Any) -> float | None:
    """Quando o cache desta listagem deixa de valer, pelo `ttlMs` que o servidor devolveu.
    ...
    """
    if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, (int, float)):
        return None
    if ttl_ms <= 0:
        return None
    return time.monotonic() + float(ttl_ms) / 1000.0
```

Os dois entram na mesma pergunta que o gerenciador já fazia — e é por isso que a propriedade
`mudou` virou `desatualizado`:

```python
    @property
    def desatualizado(self) -> bool:
        """O cache da lista não vale mais: o servidor avisou, ou o TTL que ele deu venceu."""
        if self._avisos != self._avisos_lidos:
            return True
        return self._expira_em is not None and time.monotonic() >= self._expira_em
```

Testes: `test_mcp_ttl_do_servidor_renova_o_catalogo` e
`test_mcp_stateless_pede_a_escuta_para_receber_o_aviso`.

### 9.3 Lista parcial saía como completa — `cliente.py` + `__init__.py`

No teto de páginas o cliente guardava o motivo em `self.erro` e devolvia o que tinha lido — mas o
`status()` lia `ligacao.erro`, que continuava vazio. Resultado: `conectado: true`, sem erro
nenhum, com metade do catálogo.

Agora o motivo tem nome próprio (`cliente.incompleto`) e vai para o status:

```python
                    # Lista parcial apresentada como completa é pior do que lista parcial com
                    # o motivo escrito: `conectado: true` com metade das ferramentas não diz a
                    # ninguém que faltou coisa. `None` quando a última listagem foi inteira.
                    "incompleto": (
                        cliente.incompleto if cliente is not None and conectado else None
                    ),
```

O mesmo campo cobre o caso do servidor que devolve um `nextCursor` que não é texto — antes isso
também parava em silêncio.

Teste: `test_mcp_teto_de_paginas_marca_a_conexao_incompleta`.

---

## 10. O que **não** foi mexido

- **`cacheScope`** (`public`/`private`) — só diz se a resposta pode ser compartilhada entre
  clientes. O Koda é um cliente, com uma conexão; não muda nada aqui.
- **Cancelamento da escuta** (`notifications/cancelled`) — a escuta morre com o processo, que é
  o caso normal. Não há cancelamento explícito.
- **`x-mcp-header`** — é do transporte HTTP; este cliente é stdio.
