# Checklist OWASP Top 10 — Koda Cloud

Cada item aponta **onde** o controle está implementado e como ele é verificado.
Estado: ✅ implementado e testado · ⚠️ implementado, depende de configuração de
produção · ⛔ fora do escopo do serviço (com o motivo).

## A01 — Broken Access Control ✅

- Toda rota `/admin/*` passa por `exigirAdmin()` (`src/middlewares/autenticacao.ts`), que
  revalida: assinatura do JWT, `aud` correto, existência do admin, piso de emissão
  (`tokens_valid_from`), sessão viva na família de refresh e papel.
- Token de conta comum em rota de admin devolve **403** (`insufficient_role`), não 401.
- Hard delete de conta exige papel `superadmin` (`exigirPapel(['superadmin'])`).
- Contas suspensas/banidas perdem acesso na hora: status, `tokens_valid_from` e
  `refresh_tokens.revoked_at` são checados a cada requisição.
- IDOR: recursos são consultados por id, mas sempre dentro do escopo do ator; a conta
  comum só lê a própria conta (`/api/account/*`).
- Testes: `tests/security.authz.test.ts` (33 rotas sem token, token expirado, alg=none,
  token forjado, token de conta comum), `tests/admin.contas.test.ts`.

## A02 — Cryptographic Failures ✅

- Senhas: bcrypt (padrão) ou PBKDF2-SHA256 com 600k iterações, guardadas com prefixo de
  algoritmo (`$bcrypt$…` / `$pbkdf2-sha256$…`) para permitir troca e rehash.
- Refresh token: apenas o **SHA-256** no banco; o valor cru nunca é gravado.
- Segredo TOTP: **AES-256-GCM** em repouso com `TOTP_ENCRYPTION_KEY`.
- JWT: HS256 com segredos distintos (access/refresh), mínimo de 32 caracteres,
  comparação de assinatura via `crypto.subtle.verify` (tempo constante).
- Comparações sensíveis usam `timingSafeEqualStr` (tempo constante).
- HTTPS obrigatório com HSTS (`strict-transport-security: max-age=31536000; includeSubDomains; preload`).
- Testes: `tests/unidades.semver.totp.test.ts`, `tests/security.headers.test.ts`.

## A03 — Injection ✅

- **Zero SQL concatenado**: toda query é prepared statement com parâmetros vinculados
  (`src/models/*`). Colunas de `ORDER BY` vêm de um mapa fixo (`COLUNA_ORDENACAO`), nunca
  do valor do cliente.
- Entrada validada com Zod em 100% das rotas (`src/validation/schemas.ts`), com `strip` de
  campos desconhecidos e teto de tamanho antes de alocar memória.
- Comandos de shell não existem neste serviço — nada de `exec`/`eval`.
- Testes: `tests/security.injection.test.ts` (cargas `' OR 1=1 --`, `'; DROP TABLE …`,
  `UNION SELECT password_hash`, ordenação com metacaracteres).

## A04 — Insecure Design ✅

- Lockout duplo (IP **e** conta) antes de validar credenciais: com o bloqueio ativo nem a
  senha certa entra; contadores em instrução única (UPSERT + RETURNING), sem corrida.
- Rotação de refresh com **uso único** e detecção de reuso: reapresentar um refresh já
  usado revoga a família inteira e fica auditado.
- Conta banida/suspensa não gasta orçamento de lockout (evita DoS de conta alheia).
- Suspensão sempre com prazo; reversão explícita (`/reactivate`, `/restore`).
- 2FA TOTP opcional com janela de ±30 s e códigos de recuperação de uso único.

## A05 — Security Misconfiguration ✅

- Configuração validada no boot (Zod): faltando segredo, o serviço responde 503 sem
  vazar detalhe; em produção `CORS_ORIGIN` é obrigatório.
- `ALLOW_INSECURE_HTTP` é forçado a `false` em produção, independentemente do valor.
- Headers no espírito do helmet: CSP (`default-src 'none'`, sem `unsafe-inline`),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`, COOP/CORP, `Cache-Control: no-store`.
- Erros: mensagem genérica ao cliente, detalhe só no log do servidor com `request_id`.
- Testes: `tests/security.headers.test.ts`, `tests/security.authz.test.ts`.

## A06 — Vulnerable and Outdated Components ✅ (com nota)

- `npm audit --omit=dev` → **0 vulnerabilidades** nas dependências de runtime
  (`hono`, `zod`, `bcryptjs`).
- Nota: `npm audit` completo acusa 4 achados *high* em `sharp` (libheif) vindo de
  `miniflare` → **devDependency** usada só para rodar os testes localmente. Não entra no
  bundle publicado; a correção sugerida hoje é um downgrade incompatível com o vitest 4,
  então fica monitorado até o upstream publicar a correção.

## A07 — Identification and Authentication Failures ✅

- Login de admin em rota separada (`/admin/login`, tabela `admins`) do login de conta
  (`/api/auth/login`, tabela `users`) — públicos de token diferentes (`aud`).
- Access token curto (15–30 min, padrão 20) + refresh de dias com hash no banco.
- Lockout por IP e por conta após 5 falhas, com rate limit adicional na rota.
- Enumeração de usuário: e-mail inexistente executa um hash descartável para igualar o
  tempo de resposta e devolve o mesmo erro genérico.
- Senha não pode conter o e-mail, ter menos de 12 caracteres nem estar na lista de comuns.
- Trocar senha/revogar sessões invalida todos os tokens ativos.
- Testes: `tests/security.bruteforce.test.ts`, `tests/admin.contas.test.ts`.

## A08 — Software and Data Integrity Failures ✅

- Log de auditoria **append-only**: triggers no banco recusam `UPDATE` e `DELETE`, e cada
  linha carrega `entry_hash` (SHA-256 do conteúdo canônico) com verificação sob demanda
  (`GET /admin/api/audit/verify`).
- Auditoria é *fail-closed*: se o registro falhar, a operação não é dada como concluída.
- Uploads validados por tamanho, extensão, MIME declarado **e bytes mágicos**
  (PNG/JPEG/GIF/WebP); SVG é recusado de propósito (vetor de XSS armazenado).
- Conteúdo enviado é servido com `Content-Type` explícito, `nosniff`, CSP `sandbox` e
  nunca a partir de diretório público.
- Testes: `tests/audit.imutabilidade.test.ts`, `tests/admin.modelos.test.ts`.

## A09 — Security Logging and Monitoring Failures ✅

- Log estruturado em JSON com redação de campos sensíveis (`senha`, `token`, `hash`,
  `cookie`, `totp`) em `src/utils/logger.ts`.
- Auditoria de toda ação administrativa com autor, alvo, IP, user agent, `request_id`,
  estado antes/depois e resultado.
- Histórico de tentativas de login (append-only) disponível em `/admin/api/audit/logins`.
- `x-request-id` correlaciona resposta, log e auditoria.

## A10 — Server-Side Request Forgery ✅

- O serviço **não faz requisições de saída** em nome do usuário: não há webhook, proxy ou
  fetch de URL informada. A única URL aceita é `download_url` de release, validada como
  `https://` sem credenciais embutidas e apenas devolvida ao cliente (não é requisitada
  pelo servidor).

---

## Fora do escopo deste serviço

- **Segredos de infraestrutura** (contas Cloudflare, chaves de API): vivem em
  `wrangler secret`, nunca no repositório.
- **Pentest e WAF**: o Cloudflare já aplica mitigação de borda; recomendamos habilitar
  Rate Limiting Rules e Bot Fight Mode na zona do domínio.
- **Verificação em staging externo** (securityheaders.com): rode após apontar um domínio
  próprio; o Worker já entrega os cabeçalhos que o scanner espera.

## Como reproduzir as verificações

```bash
npm run check            # types + suíte completa (workerd + D1 reais)
npm run audit            # dependências de runtime
npm run audit:all        # inclui devDependencies (ver nota em A06)
```
