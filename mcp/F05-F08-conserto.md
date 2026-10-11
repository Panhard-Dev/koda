# F05–F08 — conserto

O que foi corrigido do relatório `QA-F05-F08-relatorio.md`, e o que ficou pendente.

---

## 1. Veredito por achado

| Achado | Verificado no código | O que foi feito |
|---|---|---|
| **F05** — modelo mostrado ≠ modelo chamado | confirmado | **resolvido**: o provider de terceiro saiu do produto (§5) |
| **F06** — limites/capacidades por modelo | confirmado | **namespace corrigido** (§4); limites e visão dependem do host (§6) |
| **F07** — agregação e término do stream | confirmado | **corrigido** (§2) |
| **F08** — metadados opacos de tool call | confirmado | **corrigido** (§3) |

As quatro leituras do relatório estavam certas — incluindo o detalhe de que o F05 e o F08 são
**condicionais** (BYOK e upstream que exige o round-trip), e não defeitos do caminho Host. O
F05 era condicional a um caminho que, a pedido do dono, deixou de existir.

---

## 2. F07 — agregação e término do stream

### 2.1 O mesmo `id` era tratado como chamada nova

`openai_compat.py`, no `step_streaming`. O código era:

```python
indice = len(parciais) if (novo_id or not parciais) else max(parciais)
```

Sempre que o fragmento tinha `id`, abria posição nova. Um provedor que repete o `id` (a
sequência `A, B, A`) ganhava **três** chamadas: a segunda cópia de `A` ficava sem nome e só com
o resto dos argumentos.

Havia um segundo defeito na mesma linha: `len(parciais)` não é "a próxima posição" quando as
posições não são `0..n-1` — com `index` 0 e 2, `len` devolve 2 e cai **justamente na que já
existe**, e a chamada nova sobrescreve a anterior.

Agora as duas regras estão explícitas:

```python
def _posicao_do_pedaco(parciais: dict[int, dict[str, Any]], novo_id: str) -> int:
    """Onde este pedaço de tool call entra, quando o provedor **não** manda `index`.

    Duas regras, e as duas custaram tempo:

    - **id que já apareceu volta para a posição dele.** O mesmo id é a mesma chamada. Abrir
      posição nova duplicava a ferramenta, e a segunda cópia ficava **sem nome** — só com o
      resto dos argumentos. Uma sequência `A, B, A` virava três chamadas em vez de duas.
    - **posição nova é `max + 1`, não `len`.** Com posições fora da sequência (um provedor que
      num pedaço manda `index` 0 e no outro 2), `len` devolve 2 e cai justamente numa que já
      existe — a chamada nova sobrescrevia a anterior.
    """
    if not novo_id:
        # Pedaço sem id é continuação da última chamada aberta.
        return max(parciais) if parciais else 0
    for posicao, parcial in parciais.items():
        if parcial.get("id") == novo_id:
            return posicao
    return max(parciais) + 1 if parciais else 0
```

### 2.2 Stream que acaba sem marcador virava passo completo

O `truncado` olhava só `finish_reason == "length"`. Um stream que termina **sem** `finish_reason`
e **sem** `[DONE]` — conexão caiu no meio, provedor cortou — devolvia `truncado=False`, e o laço
tratava o prefixo como passo completo.

```python
        # `length` é o corte que o provedor **declarou**. O outro caso é o stream que
        # acabou sem `finish_reason` e sem `[DONE]`: aí não se sabe se ele terminou ou se
        # a conexão caiu no meio, e chamar isso de passo completo é o que fazia o laço
        # executar uma ferramenta cujos argumentos podiam estar pela metade.
        truncado=motivo_de_fim == "length" or not (terminou or motivo_de_fim),
```

E `terminou` passou a ser marcado onde o protocolo anuncia o fim:

```python
                    if data == "[DONE]":
                        terminou = True
                        break
```

O mesmo tratamento foi para o outro caminho de streaming do arquivo (`stream()`, que emite
`Piece(truncated=True)` no fim), que tinha o mesmo buraco.

O que acontece com `truncado=True` no laço já era o certo e não mudou: com chamadas, ele executa
as que estão completas e pede continuação ao modelo; sem chamadas, pede a continuação do texto.

**Um risco declarado:** um provedor que nunca manda `finish_reason` **nem** `[DONE]` passa a ter
todo passo marcado como truncado, e o laço pede continuação. É o lado seguro — mas se aparecer um
upstream assim, o sintoma será "pede continuação demais", e a causa é esta linha.

---

## 3. F08 — o envelope opaco da tool call

O `ToolCall` só tinha `id`, `name`, `arguments` e `raw_arguments`, e o `para_mensagem()`
reconstruía só os campos padrão. O `extra_content` (a assinatura de pensamento do Gemini 3, que
a Vertex exige de volta no histórico e responde **400** quando falta) era perdido no primeiro
passo com ferramenta.

Campo novo no contrato, com o envelope inteiro:

```python
    #: O que o provedor mandou junto da chamada e espera receber **de volta**, sem que o Koda
    #: entenda o que é. Hoje é o `extra_content` — o `google.thought_signature` do Gemini 3,
    #: que a Vertex exige no histórico e responde 400 quando falta. Guardar o envelope e
    #: ecoá-lo inteiro é o certo: interpretar um campo opaco é o que quebra na próxima versão
    #: dele. `None` quando não veio nada além dos campos que o Koda já trata.
    extra: dict[str, Any] | None = None

    def para_mensagem(self) -> dict[str, Any]:
        mensagem: dict[str, Any] = {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.raw_arguments or "{}"},
        }
        if self.extra:
            mensagem.update(self.extra)
        return mensagem
```

O que entra em `extra` é **tudo o que não é campo do Koda**:

```python
#: Campos da tool call que o Koda **trata**. `index` fica de fora porque é a posição na lista
#: do provedor, não informação da chamada — devolvê-lo ao histórico não significa nada.
CAMPOS_DA_CHAMADA = ("id", "type", "function", "index")
```

É genérico de propósito: um envelope novo (outro provedor, outra versão do Gemini) passa a
sobreviver sozinho, sem campo novo no contrato. E nada muda quando o campo não vem — o teste
`test_chamada_sem_envelope_nao_ganha_campo` garante que a mensagem não ganha
`extra_content: null`.

**O que isto não prova:** que o gateway Google aceite a conversa. Não chamei conta real — o que
está provado é que o campo atravessa o Koda intacto, nos dois parsers e no fatiamento.

---

## 4. F06 (parte) — o nome com namespace

Tanto o catálogo do seletor (`routers/models.py`) quanto o de esforços
(`openai_compat.py::_esforcos`) faziam `.split("/")[-1]` no id. Dois fornecedores publicando
`vendor-a/model-x` e `vendor-b/model-x` viravam **um** `model-x`: o usuário escolhia um e o
pedido saía com o id do outro, e os esforços de um valiam para o outro.

A correção mantém o nome curto **enquanto ele é único** — que é o que o seletor mostra hoje — e
cai no id integral quando colide:

```python
    # O id do provedor pode vir com namespace (`vendor/model`), e o seletor mostra o nome curto.
    # Encurtar **sempre** funde dois modelos quando dois fornecedores publicam o mesmo nome: o
    # usuário escolhe um e o pedido sai com o id do outro, sem ninguém perceber. Então o curto
    # vale só enquanto for único — colidiu, os dois ficam com o **id integral**, que é o que o
    # host aceita de volta.
    entradas = [...]
    curtos = Counter(bruto.split("/")[-1] for bruto, _ in entradas)
    for bruto, item in entradas:
        curto = bruto.split("/")[-1]
        identificador = bruto if curtos[curto] > 1 else curto
```

Nos dois lugares, e pelo mesmo motivo.

---

## 5. F05 — resolvido: o provider de terceiro **saiu do produto**

A decisão do dono foi outra, e é a mais direta: *"não é pra ter outro provedor além do
c-host"*. Em vez de tratar o seletor, o caminho que criava o problema deixou de existir.

O que saiu:

| Onde | O que era |
|---|---|
| `providers/__init__.py` | `if settings.provider == "openai" or settings.openai_api_key: return OpenAICompatibleProvider(settings)` — **a linha que fazia existir outro provider** |
| `config.py` | `ProviderName` perdeu o `"openai"`; saíram `openai_api_key`, `openai_base_url`, `openai_model`, `model_map`, `model_aliases` e `resolve_model` |
| `openai_compat.py` | `OpenAICompatibleProvider.__init__` deixou de ler chaves do `Settings` — recebe `base_url`, `api_key` e `model` de quem constrói (o `HostProvider`) |
| `openai_compat.py` | `HostProvider.resolve_model` perdeu o alias; ficaram o id como veio e os nomes decorativos antigos caindo no `host_model` |
| `README.md` | saiu a seção do provider `openai` e o `KODA_MODEL_MAP` |

Sobraram **dois**, e nenhum de fora: o **host** (o `c-host.exe`, com catálogo e tool calling)
e o **local** (responde offline, sem ferramentas). O `auto` procura o host e cai no local.

**Segunda passada: os resquícios que ficaram mentindo.** Depois do corte, uma varredura por
`OPENAI_`/`api_key` no código achou o que ainda falava de um provider que não existe:

| Onde | O que dizia |
|---|---|
| `openai_compat.py` (topo) | *"Serve OpenAI, Groq, OpenRouter e o Ollama — muda só a `OPENAI_BASE_URL` e a chave"* |
| `providers/base.py` (topo) | *"qualquer coisa … serve como provider (modelo local, OpenAI, Ollama, o que vier)"* |
| `openai_compat.py::stream()` | `raise ProviderError("Provider OpenAI escolhido sem chave: preencha OPENAI_API_KEY no backend/.env")` — **uma mensagem de erro mandando preencher uma variável que não existe** |
| `openai_compat.py::step()` | `raise ProviderError("Provider sem chave para chamar ferramentas.")` — nunca dispara |
| `routers/chat.py` | o `sse("error", …)` com *"preencha OPENAI_API_KEY no backend/.env"* — idem |
| `openai_compat.py` | `self.api_key` e o `Authorization: Bearer` do `headers()` — o Host sobrescreve os dois |

As guardas saíram (código que não dispara, com mensagem falsa dentro) e o `api_key` saiu do
construtor: hoje a classe base recebe só `base_url` e `model`, e o `headers()` dela manda só o
`Content-Type`. O `HostProvider` monta a credencial dele, que é a sessão da conta.

Varredura final: **nenhuma referência a `OPENAI_`, a chave de API ou a endereço de terceiro em
`backend/app/` ou em `src/`** — fora os comentários históricos que explicam o que saiu.

O que **não** mudou, e por quê:

- **A classe `OpenAICompatibleProvider` continua**, com o mesmo nome: o `HostProvider` **herda**
  dela, e é ali que mora o parsing do stream e das tool calls (F07, F08). O nome descreve o
  **protocolo** que o host fala, não um fornecedor. O docstring dela diz isso.
- **A `MODEL_MENU` do frontend continua**: ela existe para o caso de o host **não responder**,
  que é outro problema e continua acontecendo.
- **O `ready`/`provider_ready` continua no contrato**: hoje os dois providers são sempre
  prontos (a guarda não dispara), mas é o campo que a interface lê no health, e um provider
  que precise de credencial volta a cair nele em vez de falhar no meio da conversa. Está
  escrito no `base.py` que hoje ele não dispara — para não parecer que faz algo que não faz.

**A porteira é um teste:** `test_nao_existe_provider_de_terceiro`, em `test_api.py`. Ele prova
que `provider="openai"` é recusado, que uma `OPENAI_API_KEY` plantada no ambiente não muda o
provider, e que o seletor segue vazio para quem não é o host.

E o script de validação do dono (`.tmp-validacao-20261001/item1-provider.py`) foi atualizado:
o caso **C**, que antes *documentava* o provider de terceiro em dev, agora **prova que ele não
existe**. Roda e passa (`RESULTADO: APROVADO (item 1)`).

---

## 6. O que **não** foi corrigido: os limites por modelo (F06-b/c)

Os dois dependem de **o host publicar**, e ele não publica:

- `MAX_TOKENS_SAIDA = 131_072` e `contexto_tokens = 1_000_000` são globais, e o próprio
  comentário do código já reconhece o risco de 400 quando o teto passa o limite de saída do
  modelo;
- a lista de quem enxerga imagem é fixa (`Settings.host_modelos_com_visao`) porque
  `/v1/models` não traz a capacidade.

O que o host publica, segundo o `backend/README.md`, é `efforts` e `targetFormat` — **não**
`images`. *(A memória do projeto dizia o contrário; corrigida.)*

Calibrar `max_output` e a janela por modelo é trabalho de quem conhece os números de cada
modelo, e não dá para medir daqui: o host não está no ar nesta máquina (`/v1/models` responde
502). O que o backend pode fazer, quando você quiser, é **ler** os campos no dia em que o host
os publicar — o caminho já existe para `efforts`.

---

## 7. Os testes

`backend/tests/test_provider.py` (novo, local — não viaja com o branch). O transporte é um
dublê do `httpx.AsyncClient`: o que se mede é o que o provider devolve, não a rede.

| Teste | O que prova |
|---|---|
| `test_id_repetido_nao_duplica_a_chamada` | `A, B, A` sem `index` dá **duas** chamadas, e `A` fica com o nome e os argumentos inteiros |
| `test_fragmento_sem_id_e_continuacao_da_ultima` | pedaço sem `id` continua a chamada aberta |
| `test_posicao_nova_nao_sobrescreve_a_existente` | com `index` 0 e 2, a segunda não cai em cima da primeira |
| `test_stream_sem_marcador_de_termino_e_truncado` | EOF sem `[DONE]` e sem `finish_reason` → `truncado` |
| `test_stream_com_done_nao_e_truncado` | `[DONE]` fecha o passo como completo |
| `test_stream_com_finish_reason_nao_e_truncado` | `finish_reason` também |
| `test_stream_cortado_por_teto_continua_truncado` | `length` continua marcando |
| `test_envelope_opaco_volta_como_veio` | `extra_content` volta idêntico, e `index` não volta |
| `test_envelope_opaco_sobrevive_ao_fatiamento` | envelope num pedaço, nome noutro: os dois sobrevivem |
| `test_chamada_sem_envelope_nao_ganha_campo` | sem envelope, nada muda |
| `test_catalogo_nao_funde_modelos_homonimos` | `vendor-a/model-x` ≠ `vendor-b/model-x` |
| `test_catalogo_encurta_quando_nao_ha_colisao` | nome curto continua valendo quando é único |

```bash
cd C:/Users/Administrator/Downloads/koda/backend
KODA_API_TOKEN=koda-dev ./.venv/Scripts/python.exe -m pytest tests/test_provider.py -q
```

---

## 8. Estado dos testes

- `tests/test_provider.py` — **12 passaram**.
- Suíte inteira — **493 passaram, 5 falharam**. As 5 falham **também na árvore limpa**:
  `test_api` (2, de árvore) e `test_host` (3). Numa passada intermediária apareceram mais 5
  (`test_tools` 3 e `test_mcp` 2) que **não reproduziram** na passada seguinte — são
  intermitentes neste ambiente, e não são destas mudanças.
- Três testes que exercitavam o caminho que saiu foram atualizados, e não removidos:
  `test_resolve_model_deixa_o_id_do_host_passar` (perdeu o bloco do `model_map`),
  `test_aceita_imagem_pela_lista_e_o_alias` (idem, virou `..._pela_lista_do_host`) e
  `test_models_do_openai_nao_aparecem_no_seletor`, que virou
  **`test_nao_existe_provider_de_terceiro`** — a porteira do corte. Um quarto
  (`test_missing_key_uses_openai_provider_but_says_it_is_not_ready`) foi removido: testava um
  provider que não existe mais.

---

## 9. Arquivos tocados

| Arquivo | O que mudou |
|---|---|
| `backend/app/providers/openai_compat.py` | agregação por id, término do stream, envelope opaco, namespace dos esforços; e o `__init__` sem chaves de terceiro |
| `backend/app/providers/__init__.py` | `build_provider` sem o caminho de terceiro |
| `backend/app/providers/base.py` | `ready` documentado: hoje nenhum provider é "não pronto" |
| `backend/app/config.py` | `ProviderName` sem `"openai"`; saíram os campos do openai e o `model_map` |
| `backend/app/contracts/turn.py` | `ToolCall.extra` e o eco em `para_mensagem()` |
| `backend/app/routers/models.py` | namespace do catálogo |
| `backend/README.md` | seção do provider `openai` removida; a ordem do `auto` |
| `backend/tests/test_provider.py` | **novo** — 12 testes (local) |
| `backend/tests/test_api.py`, `test_visao.py` | testes do caminho que saiu (locais) |
| `.tmp-validacao-20261001/item1-provider.py` | caso C invertido: prova que não existe |
