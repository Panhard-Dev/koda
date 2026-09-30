import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

/**
 * Cada arquivo de teste roda com um D1 isolado (isolatedStorage do pool).
 * Aqui as migrations do Worker são aplicadas nesse banco antes dos casos.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS?: never }).TEST_MIGRATIONS as never);
});
