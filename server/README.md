# Koda Cloud — backend seguro + painel administrativo

Backend de nuvem do Koda: autenticação de administrador, gestão de contas, catálogo de
modelos, releases/atualização e auditoria imutável. Roda no **Cloudflare Workers** com
banco **D1** (SQLite na borda) — sem servidor para manter, com HTTPS e domínio prontos.

## Por que Worker + D1 (e não Express + Postgres)

A entrega pedida era "backend completo funcionando de verdade, publicado". O ambiente
disponível para publicar era a conta Cloudflare já autenticada, sem Postgres, Mongo ou
Docker rodando. Nesse cenário:

| Pedido | Escolha aqui | Por quê |
| --- | --- | --- |
| Node + Express **ou** Python + FastAPI | TypeScript no runtime do Workers com **Hono** | Express não roda no runtime da borda; Hono é o equivalente com a mesma organização em `routes/ controllers/ middlewares/ services/ models/` |
| PostgreSQL **ou** MongoDB | **D1** (SQLite distribuído) | Banco gerenciado, transacional, integrado ao Worker; `DATABASE_URL` fica documentado no `.env` |
| Prisma / TypeORM / Sequelize | SQL parametrizado com prepared statements | Os três ORMs exigem driver TCP/`fs`, que não existem no runtime da borda. **Nenhuma query é montada por concatenação**: tudo passa por `bind()` (`src/models/*`) |
| bcrypt ou argon2 | bcrypt (`bcryptjs`) com PBKDF2-SHA256 alternativo | Trocável por `HASH_ALGO`; formato de hash com prefixo permite migrar sem invalidar senhas |

Quer rodar em Node + Postgres num VPS? A camada de domínio (`services/`, `validation/`)
não conhece o runtime — só `src/models/` e `src/index.ts` falam D1/Hono.

## Estrutura

```
server/
├── migrations/0001_init.sql      esquema + triggers de imutabilidade
├── scripts/
│   ├── hash-senha.mjs            gera hash da senha do admin e segredos
│   └── gerar-env.mjs             .env -> .dev.vars / wrangler secret
├── src/
│   ├── config/env.ts             validação e valores padrão de toda configuração
│   ├── index.ts                  montagem do Worker (middlewares globais + rotas)
│   ├── routes/                   public.ts · app.ts · admin.ts · painel.ts
│   ├── controllers/              HTTP: lê entrada validada, chama serviço, responde
│   ├── middlewares/              contexto · segurança · https · cors · csrf ·
│   │                             autenticação · validação · limite · erros
│   ├── services/                 regra de negócio (auth, contas, modelos, versões,
│   │                             uploads, auditoria, TOTP, rate limit)
│   ├── models/                   acesso a dados (prepared statements)
│   ├── validation/schemas.ts     todos os esquemas Zod de entrada
│   ├── views/                    páginas do painel (HTML server-rendered)
│   └── utils/                    jwt · crypto · semver · html · logger · erros
└── tests/                        suíte de segurança e integração (workerd + D1 reais)
```

## Como rodar

```bash
cd server
npm install

# 1. Crie o .env e gere os segredos (a senha do admin aparece UMA vez)
cp .env.example .env
npm run hash -- --gerar          # cole JWT_SECRET, JWT_REFRESH_SECRET,
                                 # TOTP_ENCRYPTION_KEY e ADMIN_PASSWORD_HASH no .env

# 2. Ambiente local: migrations no D1 local + .dev.vars + servidor
npm run migrate:local
npm run env                      # escreve .dev.vars a partir do .env
npm run dev                      # http://127.0.0.1:8787
```

Painel: <http://127.0.0.1:8787/admin/login> · documentação da API pública: `/api/public/health`.

## Gerar o hash da senha do admin

A senha **nunca** é gravada em texto puro — nem no `.env`, nem no banco.

```bash
npm run hash -- "MinhaSenhaForteCom12Caracteres"   # imprime o hash para colar no .env
npm run hash -- --gerar                            # sorteia senha forte + hash + segredos
npm run hash -- "senha" --algo=pbkdf2              # hash PBKDF2-SHA256
npm run hash -- --conferir "senha" "\$bcrypt\$2b\$12\$..."   # confere um hash existente
```

O administrador é criado no **primeiro acesso** ao serviço (`ADMIN_EMAIL` +
`ADMIN_PASSWORD_HASH`) com papel `superadmin`; o evento fica em auditoria
(`admin.bootstrap`). Troque a senha em **Segurança → Trocar senha** no primeiro login.

## Configuração do `.env`

| Variável | Para que serve |
| --- | --- |
| `DATABASE_URL` | Identifica o banco (`d1://koda-cloud`). No Worker o acesso é o binding `DB` |
| `JWT_SECRET` | Assina o access token (15–30 min). Mínimo 32 caracteres |
| `JWT_REFRESH_SECRET` | Assina o refresh (dias). Obrigatoriamente diferente do anterior |
| `ADMIN_EMAIL` | E-mail do admin criado no bootstrap |
| `ADMIN_PASSWORD_HASH` | Hash bcrypt/pbkdf2 da senha do admin |
| `TOTP_ENCRYPTION_KEY` | AES-256 (32 bytes em base64) que cifra o segredo do 2FA |
| `NODE_ENV` | `production` exige HTTPS/HSTS e CORS explícito |
| `CORS_ORIGIN` | Whitelist de origens, separadas por vírgula |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | Janela e teto do limitador geral |
| `LOGIN_RATE_LIMIT_MAX`, `LOGIN_LOCKOUT_*` | Limite e regras de bloqueio do login |
| `ACCESS_TOKEN_TTL_S`, `REFRESH_TOKEN_TTL_S` | Tempo de vida dos tokens |
| `HASH_ALGO`, `BCRYPT_COST`, `PBKDF2_ITERATIONS` | Algoritmo e custo da senha |
| `UPLOAD_MAX_BYTES` | Tamanho máximo de upload |
| `ALLOW_INSECURE_HTTP`, `PANEL_ENABLED` | Ajustes de desenvolvimento |

Variáveis de configuração vivem em `wrangler.jsonc`; **segredos** vão por
`wrangler secret` (`npm run env -- --segredos` faz o envio em lote).

## Publicar

```bash
npx wrangler login                  # ou exporte CLOUDFLARE_API_TOKEN
npx wrangler d1 create koda-cloud    # copie o database_id para wrangler.jsonc
npm run migrate:remote              # cria as tabelas na nuvem
npm run env -- --segredos           # envia JWT_SECRET, refresh, hash do admin e chave TOTP
npm run deploy                      # https://koda-cloud-api.SEU-SUBDOMINIO.workers.dev
```

Depois de publicar, valide em `/api/public/health` e entre em `/admin/login`.

## Rotas

### Públicas (usadas pelo app)

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/public/health` | Estado do serviço (sem dados internos) |
| GET | `/api/public/version?versao=1.0.0&canal=stable` | `{ update_available, latest_version, download_url, update_required, notes }` |
| GET | `/api/public/changelog?canal=stable` | Histórico de versões publicadas |
| GET | `/api/public/models` | Catálogo ativo |
| GET | `/api/public/models/:id/image` · `/api/public/assets/:id` | Imagem do modelo |

### Contas do app

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/api/auth/login` | Login de conta comum (tabela `users`) |
| POST | `/api/auth/refresh` | Rotação do refresh token |
| POST | `/api/auth/logout` | Encerra a sessão |
| GET | `/api/account/me` | Conta, modelos efetivos e avisos |
| POST | `/api/account/notifications/:id/read` | Marca aviso como lido |

### Administrativas (`/admin/api/*`, JWT de admin + CSRF quando via cookie)

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/admin/auth/login` · `/refresh` · `/logout` | Sessão do admin (access + refresh + cookies httpOnly) |
| GET | `/admin/api/overview` | Contadores e últimas ações |
| GET/POST | `/admin/api/accounts` | Listar (filtros: status, busca, datas, paginação) / criar |
| GET | `/admin/api/accounts/:id` | Detalhe: exceções de modelo, avisos, sessões ativas, histórico |
| POST | `/admin/api/accounts/:id/ban` · `/suspend` · `/reactivate` · `/delete` · `/restore` | Moderação (todas invalidam tokens na hora) |
| DELETE | `/admin/api/accounts/:id` | Hard delete (superadmin, confirmação pelo e-mail) |
| POST | `/admin/api/accounts/:id/notify` | Envia aviso ao titular |
| PUT | `/admin/api/accounts/:id/models/:modelId` | Exceção individual (`true`/`false`/`null` = herdar global) |
| GET/POST/PATCH/DELETE | `/admin/api/models…` | CRUD, ativar/desativar global, restaurar, remover |
| POST | `/admin/api/models/:id/users/:userId` | Ativação individual (tabela `user_models`) |
| GET/POST/DELETE | `/admin/api/uploads` | Upload validado (imagem) e remoção |
| GET/POST/PATCH/DELETE | `/admin/api/releases…` | Publicar/despublicar versão e changelog |
| GET | `/admin/api/audit` · `/audit/verify` · `/audit/logins` | Trilha de auditoria, verificação de integridade e tentativas de login |
| POST | `/admin/api/security/password` · `/totp/setup` · `/totp/enable` · `/totp/disable` · `/sessions/revoke-all` | Segurança do próprio admin |

### Painel HTML (`/admin`)

Login separado, painel com contadores, listagem e detalhe de contas (moderação, aviso,
modelos por usuário, histórico), catálogo de modelos (CRUD, ativar/desativar, upload de
imagem), versões (publicar, despublicar, remover, changelog), auditoria (filtros e
verificação de integridade) e segurança (trocar senha, 2FA, revogar sessões).

## Testes

```bash
npm test          # suíte completa dentro do workerd, com D1 e migrations reais
npm run check     # types + testes
```

| Arquivo | O que cobre |
| --- | --- |
| `security.authz.test.ts` | 33 rotas admin sem token, token ilegível, adulterado, expirado, `alg=none` e token de conta comum (403) |
| `security.bruteforce.test.ts` | Lockout por conta e por IP, senha certa barrada no bloqueio, reset após sucesso, limite da rota, contador atômico |
| `security.injection.test.ts` | SQLi em login/filtros/ordenação/versão/asset e XSS escapado no painel (HTML + CSP) |
| `security.headers.test.ts` | HSTS, CSP de HTML e de dados, família helmet, redirect HTTP→HTTPS, CORS whitelist |
| `audit.imutabilidade.test.ts` | `UPDATE`/`DELETE` recusados por trigger, hash por entrada, detecção de linha forjada, redação de segredos |
| `admin.contas.test.ts` | Filtros, criação, banir/suspender/reativar/soft/hard delete, aviso, exceção de modelo, tokens inválidos na hora, auditoria |
| `admin.modelos.test.ts` | CRUD, slug duplicado, ativação global e individual, upload (SVG/tipo trocado/grande), imagem pública |
| `api.publica.test.ts` | `update_available`, obrigatoriedade, canal beta, rascunho, semver, URL de download |
| `unidades.semver.totp.test.ts` | Semver, TOTP (janela e recuperação), bcrypt/pbkdf2, política de senha, validação de upload |

## Notas de operação

- **Uploads** ficam como BLOB no D1 (fora de qualquer diretório público, servidos por rota
  com CSP `sandbox`). Para arquivos grandes ou muitos, troque por R2 — o ponto de troca é
  `src/services/uploadService.ts`.
- **bcrypt no plano gratuito**: o limite de CPU do Workers gratuito é baixo; se o login
  falhar com erro de CPU, use `HASH_ALGO=pbkdf2` (Web Crypto, sem custo de JS).
- **`npm audit`**: `--omit=dev` → 0 vulnerabilidades. Os achados restantes são de
  `sharp`/`libheif` dentro de `miniflare`, dependência **de desenvolvimento**. Detalhes em
  [OWASP.md](./OWASP.md) (A06).
- Checklist OWASP Top 10 completo: [OWASP.md](./OWASP.md).
