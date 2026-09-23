# host

O binário do host (`c-host.exe`) **não está neste repositório** — ele é grande, é binário e
é distribuído à parte. Coloque o seu aqui, com esse nome, e o backend o encontra em
`http://127.0.0.1:21128`:

```bash
host/c-host.exe        # sobe a API e fica escutando em 127.0.0.1:21128
```

## O que o backend espera dele

Uma API no formato da OpenAI, sem chave:

| rota | para que serve |
| --- | --- |
| `GET /v1/models` | catálogo do seletor. O `id` é o que vai no pedido, o `name` é o rótulo da interface e o `targetFormat` diz o que o modelo aceita — os de `openai-responses` recusam `reasoning_effort: none` com 400, então o backend manda `minimal` para eles |
| `POST /v1/chat/completions` | conversa, com `stream` e com `tools` |

Extras que o backend aproveita quando existem, e ignora quando não:

- `POST` de `reasoning_effort` (`minimal`…`high`) para o esforço de raciocínio;
- `/api/accounts`, o painel de contas, de onde sai a troca de conta quando uma bate no
  limite (o host atual não publica essa rota, então a rotação fica inerte);
- o `reasoning_content` que vem no delta, mostrado na conversa como o modelo pensando.

O host também injeta uma **persona própria** no histórico (o
`owned_by: serve-liz`), e ela vencia quando o modelo falava de si. Quem trata isso é
`backend/app/identidade.py` — vale a identidade que o app manda, e a apresentação que vier
na resposta é cortada na saída.

## Sem o host

Nada quebra: `KODA_PROVIDER=auto` cai no provider local (offline, sem ferramentas) quando
não encontra nada em 21128, e o `/api/health` diz qual está no ar:

```bash
curl -s localhost:8787/api/health   # "provider": "gemini" | "local"
```
