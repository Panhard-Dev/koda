# host

Pasta do **gateway local**: a ponte entre esta máquina e o serviço de modelos do projeto.

O binário **não é versionado** (é grande e binário). Coloque o seu aqui, com o nome
`c-host.exe`, e o backend o encontra em `http://127.0.0.1:21128`:

```bash
host/c-host.exe        # sobe o gateway e fica escutando em 127.0.0.1:21128
```

O gateway conversa com o serviço e responde ao backend no formato da API da OpenAI — é por
ele que os modelos ficam disponíveis no seletor e que o agente consegue chamar ferramenta.

## Sem o gateway

Nada quebra: `KODA_PROVIDER=auto` cai no provider local (offline, sem ferramentas) quando
não encontra nada em 21128, e o `/api/health` diz qual está no ar:

```bash
curl -s localhost:8787/api/health   # "provider": "gemini" | "local"
```

O endereço do gateway é configurável em `GEMINI_PROXY_URL` (e `GEMINI_WEB_URL`, quando o
serviço expõe um painel próprio) — ver `backend/.env.example`.
