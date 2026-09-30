import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

/**
 * Os testes rodam dentro do workerd (Miniflare) com um D1 local e as migrations
 * aplicadas por `tests/setup.ts`. Os valores abaixo são de teste — nenhum deles
 * existe em produção.
 */
const SENHA_ADMIN = 'SenhaDeTeste#Koda2026';
// Chave de serviço do host local. Em produção ela é um secret do Worker; aqui é um valor
// de teste, só para o caminho da autorização por chave ser exercitado.
const CHAVE_SERVICO_HOST = 'chave-de-teste-do-host-local';
// bcrypt (custo 4, só para o teste rodar rápido) de 'SenhaDeTeste#Koda2026'
const HASH_ADMIN = '$bcrypt$$2b$04$aOdinidGedmqGq.GDgDHsOOVyBEkSykztL.X/OjyOgms4rO4IDeKC';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        main: './src/index.ts',
        miniflare: {
          compatibilityDate: '2026-08-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: { DB: 'koda-cloud-test' },
          bindings: {
            TEST_MIGRATIONS: migrations,
            NODE_ENV: 'test',
            ADMIN_EMAIL: 'admin@koda.test',
            ADMIN_PASSWORD_HASH: HASH_ADMIN,
            ADMIN_TEST_PASSWORD: SENHA_ADMIN,
            JWT_SECRET: 'segredo-de-teste-para-access-com-32-caracteres',
            JWT_REFRESH_SECRET: 'segredo-de-teste-para-refresh-com-32-caracteres',
            TOTP_ENCRYPTION_KEY: '0UuwdxraPGJ5WGCMkHoQzXjFCjxauBvtLpvAQou0P54=',
            CORS_ORIGIN: 'https://koda.test,http://tauri.localhost',
            RATE_LIMIT_WINDOW_MS: '60000',
            RATE_LIMIT_MAX: '1000',
            LOGIN_RATE_LIMIT_MAX: '10',
            LOGIN_LOCKOUT_THRESHOLD: '5',
            LOGIN_LOCKOUT_WINDOW_MS: '900000',
            LOGIN_LOCKOUT_DURATION_MS: '900000',
            ACCESS_TOKEN_TTL_S: '1200',
            REFRESH_TOKEN_TTL_S: '604800',
            HASH_ALGO: 'bcrypt',
            BCRYPT_COST: '4',
            PBKDF2_ITERATIONS: '50000',
            UPLOAD_MAX_BYTES: '65536',
            ALLOW_INSECURE_HTTP: 'true',
            PANEL_ENABLED: 'true',
            SERVE_LIZ_CLIENT_KEY: CHAVE_SERVICO_HOST,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.ts'],
      testTimeout: 20_000,
    },
  };
});
