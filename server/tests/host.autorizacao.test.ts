import { beforeEach, describe, expect, it } from 'vitest';
import {
  SENHA_CONTA,
  criarConta,
  emailUnico,
  limparLimites,
  loginAdmin,
  loginConta,
  requisitar,
} from './helpers.js';

const ROTA = '/api/public/host/authorize';
/** O mesmo valor de `vitest.config.ts`. Em produção é um secret do Worker. */
const CHAVE_SERVICO = 'chave-de-teste-do-host-local';

function autorizar(chave: unknown) {
  return requisitar(ROTA, { method: 'POST', json: { chave } });
}

async function sessaoDeConta() {
  const conta = await criarConta(emailUnico('host'));
  const login = await loginConta(conta.email, SENHA_CONTA);
  if (login.status !== 200) throw new Error(`login da conta falhou: ${login.status} ${login.texto}`);
  return { conta, token: login.json<{ access_token: string; refresh_token: string }>() };
}

describe('autorização do host local', () => {
  beforeEach(limparLimites);

  it('aceita a chave de serviço do env do Worker', async () => {
    const resposta = await autorizar(CHAVE_SERVICO);
    expect(resposta.status).toBe(200);
    expect(resposta.json<{ ok: boolean; autorizado: boolean }>()).toMatchObject({
      ok: true,
      autorizado: true,
    });
  });

  it('recusa chave errada (401) e corpo sem chave (400)', async () => {
    expect((await autorizar('chave-errada')).status).toBe(401);
    expect((await autorizar('')).status).toBe(400);
    expect((await autorizar(undefined)).status).toBe(400);
    expect((await requisitar(ROTA, { method: 'POST', json: {} })).status).toBe(400);
  });

  it('nunca devolve o valor esperado nem a chave recebida', async () => {
    const errada = await autorizar('chave-errada-mas-comprida');
    expect(errada.status).toBe(401);
    expect(errada.texto).not.toContain(CHAVE_SERVICO);
    expect(errada.texto).not.toContain('chave-errada-mas-comprida');
    expect(errada.json<{ autorizado: boolean }>().autorizado).toBe(false);
  });

  it('aceita a sessão de uma conta ativa — é assim que o app entra sem chave nenhuma', async () => {
    const { token } = await sessaoDeConta();
    const resposta = await autorizar(token.access_token);
    expect(resposta.status).toBe(200);
    expect(resposta.json<{ autorizado: boolean }>().autorizado).toBe(true);
  });

  it('recusa texto inventado, token de refresh e token de outro público', async () => {
    const { token } = await sessaoDeConta();
    const admin = await loginAdmin();
    expect((await autorizar('nao-e-token')).status).toBe(401);
    // Token de renovação não abre o modelo: só o de acesso, que é curto.
    expect((await autorizar(token.refresh_token)).status).toBe(401);
    // Sessão do painel não vale como sessão de conta.
    expect((await autorizar(admin.token)).status).toBe(401);
  });

  it('banir a conta no painel derruba o acesso ao modelo na hora', async () => {
    const admin = await loginAdmin();
    const { conta, token } = await sessaoDeConta();
    expect((await autorizar(token.access_token)).status).toBe(200);

    const banimento = await requisitar(`/admin/api/accounts/${conta.id}/ban`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'violacao de termos' },
    });
    expect(banimento.status).toBe(200);

    expect((await autorizar(token.access_token)).status).toBe(401);
  });

  it('sair da conta encerra o acesso ao modelo', async () => {
    const { token } = await sessaoDeConta();
    expect((await autorizar(token.access_token)).status).toBe(200);

    const saida = await requisitar('/api/auth/logout', {
      method: 'POST',
      json: { refresh_token: token.refresh_token },
    });
    expect([200, 204]).toContain(saida.status);

    expect((await autorizar(token.access_token)).status).toBe(401);
  });
});
