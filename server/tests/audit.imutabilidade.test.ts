import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { auditar } from '../src/services/auditService.js';
import { verificarIntegridade } from '../src/models/auditLog.js';
import { criarConta, emailUnico, loginAdmin, requisitar } from './helpers.js';

const contexto = {
  ip: '198.51.100.44',
  userAgent: 'teste/1.0',
  requestId: 'teste-auditoria',
  ator: { tipo: 'admin' as const, id: 'admin-1', email: 'admin@koda.test', papel: 'superadmin' as const },
};

describe('log de auditoria imutável', () => {
  it('recusa UPDATE e DELETE direto no banco', async () => {
    await auditar(env.DB, contexto, { action: 'teste.marcador', targetType: 'teste', targetId: 'x1' });
    const linha = await env.DB.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').first<{ id: number }>();
    expect(linha?.id).toBeTruthy();

    await expect(
      env.DB.prepare('UPDATE audit_log SET action = ? WHERE id = ?').bind('alterado', linha?.id ?? 0).run(),
    ).rejects.toThrow(/append-only/);

    await expect(env.DB.prepare('DELETE FROM audit_log WHERE id = ?').bind(linha?.id ?? 0).run()).rejects.toThrow(
      /append-only/,
    );

    const aindaLa = await env.DB.prepare('SELECT action FROM audit_log WHERE id = ?').bind(linha?.id ?? 0).first<{
      action: string;
    }>();
    expect(aindaLa?.action).toBe('teste.marcador');
  });

  it('cada entrada carrega hash do próprio conteúdo', async () => {
    await auditar(env.DB, contexto, {
      action: 'teste.hash',
      targetType: 'teste',
      targetId: 'x2',
      before: { status: 'active' },
      after: { status: 'banned' },
      details: { motivo: 'teste' },
    });
    const linha = await env.DB.prepare('SELECT entry_hash, before_state, after_state FROM audit_log ORDER BY id DESC LIMIT 1')
      .first<{ entry_hash: string; before_state: string; after_state: string }>();
    expect(linha?.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(linha?.before_state).toContain('active');
    expect(linha?.after_state).toContain('banned');
  });

  it('a verificação confirma integridade e detecta linha forjada', async () => {
    await auditar(env.DB, contexto, { action: 'teste.limpo', targetType: 'teste', targetId: 'x3' });
    const limpo = await verificarIntegridade(env.DB, { limite: 100 });
    expect(limpo.ok).toBe(true);

    // Simula adulteração por quem tem acesso ao banco: insere direto, sem hash válido.
    await env.DB.prepare(
      `INSERT INTO audit_log (created_at, actor_type, action, outcome, entry_hash)
       VALUES (?, 'system', 'teste.forjado', 'success', 'hash-invalido')`,
    )
      .bind(new Date().toISOString())
      .run();

    const detectado = await verificarIntegridade(env.DB, { limite: 100 });
    expect(detectado.ok).toBe(false);
    expect(detectado.adulteradas.some((item) => item.encontrado === 'hash-invalido')).toBe(true);
  });

  it('a senha nunca aparece no log, mesmo quando o payload tem o campo', async () => {
    await auditar(env.DB, contexto, {
      action: 'teste.redacao',
      targetType: 'teste',
      targetId: 'x4',
      details: { senha: 'SuperSecreta#2026', token: 'abc123', email: 'pessoa@koda.test' },
    });
    const linha = await env.DB.prepare('SELECT details FROM audit_log ORDER BY id DESC LIMIT 1').first<{ details: string }>();
    expect(linha?.details).not.toContain('SuperSecreta#2026');
    expect(linha?.details).not.toContain('abc123');
    expect(linha?.details).toContain('redigido');
    expect(linha?.details).toContain('pessoa@koda.test');
  });

  it('ações do painel geram entrada com autor, alvo e IP', async () => {
    const admin = await loginAdmin();
    const conta = await criarConta(emailUnico('audit-painel'), 'SenhaDeConta#2026', admin);
    await requisitar(`/admin/api/accounts/${conta.id}/suspend`, {
      method: 'POST',
      token: admin.token,
      json: { motivo: 'teste de auditoria', horas: 12 },
    });

    const entradas = await requisitar(`/admin/api/audit?target_id=${conta.id}`, { token: admin.token });
    const item = entradas
      .json<{ entradas: { action: string; actor_email: string; target_id: string; ip: string; outcome: string }[] }>()
      .entradas.find((linha) => linha.action === 'account.suspend');
    expect(item).toBeTruthy();
    expect(item?.actor_email).toBe(admin.email);
    expect(item?.ip).toBe('198.51.100.10');
    expect(item?.outcome).toBe('success');
  });

  it('a rota de auditoria é exclusiva de admin autenticado', async () => {
    expect((await requisitar('/admin/api/audit')).status).toBe(401);
    expect((await requisitar('/admin/api/audit/verify')).status).toBe(401);
  });

  it('a rota de verificação responde o resultado do recálculo', async () => {
    const admin = await loginAdmin();
    const resposta = await requisitar('/admin/api/audit/verify?limite=200', { token: admin.token });
    expect(resposta.status).toBe(200);
    const dados = resposta.json<{ ok: boolean; verificadas: number; algoritmo: string }>();
    expect(dados.verificadas).toBeGreaterThan(0);
    expect(dados.algoritmo).toContain('sha256');
  });
});
