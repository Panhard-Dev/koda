import { describe, expect, it } from 'vitest';
import { chaveDeVersao, compararTexto, compararVersao, parseVersao, urlDeDownloadValida, versaoValida } from '../src/utils/semver.js';
import { codigoAtual, codigoValido, gerarCodigosRecuperacao, gerarSegredoTotp, consumirCodigoRecuperacao, cifrarSegredo, decifrarSegredo } from '../src/services/totpService.js';
import { hashSenha, politicaDeSenha, precisaRehash, verificarSenha } from '../src/services/passwordService.js';
import { validarArquivo, nomeSeguro } from '../src/services/uploadService.js';
import { hashDeSenhaValido } from '../src/services/bootstrapService.js';
import { timingSafeEqualStr } from '../src/utils/crypto.js';
import type { Config } from '../src/config/env.js';

const config: Config = {
  nodeEnv: 'test',
  isProduction: false,
  adminEmail: 'admin@koda.test',
  corsOrigins: [],
  rateLimitWindowMs: 60_000,
  rateLimitMax: 1000,
  loginRateLimitMax: 1000,
  lockoutThreshold: 5,
  lockoutWindowMs: 900_000,
  lockoutDurationMs: 900_000,
  accessTtlS: 1200,
  refreshTtlS: 604_800,
  hashAlgo: 'bcrypt',
  bcryptCost: 4,
  pbkdf2Iterations: 1000,
  uploadMaxBytes: 65_536,
  allowInsecureHttp: true,
  panelEnabled: true,
  cadastroAberto: true,
  secrets: {
    jwt: 'a'.repeat(40),
    jwtRefresh: 'b'.repeat(40),
    adminPasswordHash: null,
    // 32 bytes em base64 — mesmo valor de teste do vitest.config.ts
    totpKey: '0UuwdxraPGJ5WGCMkHoQzXjFCjxauBvtLpvAQou0P54=',
  },
};

describe('semver', () => {
  it('aceita versoes validas e recusa lixo', () => {
    expect(versaoValida('1.0.0')).toBe(true);
    expect(versaoValida('v1.2.3')).toBe(true);
    expect(versaoValida('1.2.3-beta.1')).toBe(true);
    expect(versaoValida('1.2')).toBe(false);
    expect(versaoValida('1.2.3; DROP TABLE releases')).toBe(false);
    expect(versaoValida('')).toBe(false);
  });

  it('compara seguindo a regra do semver', () => {
    expect(compararTexto('1.0.0', '1.0.1')).toBe(-1);
    expect(compararTexto('1.10.0', '1.9.0')).toBe(1);
    expect(compararTexto('2.0.0-beta.1', '2.0.0')).toBe(-1);
    expect(compararTexto('1.0.0', '1.0.0')).toBe(0);
  });

  it('gera chave ordenavel com zero a esquerda', () => {
    const a = parseVersao('1.9.0');
    const b = parseVersao('1.10.0');
    expect(a && b).toBeTruthy();
    expect(chaveDeVersao(b as never) > chaveDeVersao(a as never)).toBe(true);
  });

  it('só aceita url de download sem credenciais', () => {
    expect(urlDeDownloadValida('https://cdn.koda.app/app.exe', false)).toBe(true);
    expect(urlDeDownloadValida('http://cdn.koda.app/app.exe', false)).toBe(false);
    expect(urlDeDownloadValida('https://user:senha@cdn.koda.app/a.exe', false)).toBe(false);
    expect(urlDeDownloadValida('javascript:alert(1)', true)).toBe(false);
  });
});

describe('TOTP', () => {
  it('valida o codigo atual e recusa o errado', async () => {
    const segredo = gerarSegredoTotp();
    const codigo = await codigoAtual(segredo);
    expect(codigo).toMatch(/^\d{6}$/);
    expect(await codigoValido(segredo, codigo)).toBe(true);
    expect(await codigoValido(segredo, '000000')).toBe(codigo === '000000');
    expect(await codigoValido(segredo, 'abc')).toBe(false);
  });

  it('aceita a janela de tolerancia e recusa codigo velho', async () => {
    const segredo = gerarSegredoTotp();
    const agora = Date.now();
    const passado = await codigoAtual(segredo, agora - 30_000);
    expect(await codigoValido(segredo, passado, { agoraMs: agora })).toBe(true);
    const antigo = await codigoAtual(segredo, agora - 300_000);
    expect(await codigoValido(segredo, antigo, { agoraMs: agora })).toBe(false);
  });

  it('cifra o segredo em repouso e consome recuperacao uma vez', async () => {
    const segredo = gerarSegredoTotp();
    const chave = config.secrets.totpKey as string;
    const cifrado = await cifrarSegredo(segredo, chave);
    expect(cifrado).not.toContain(segredo);
    expect(await decifrarSegredo(cifrado, chave)).toBe(segredo);

    const codigos = await gerarCodigosRecuperacao(3);
    const hashes = codigos.map((item) => item.hash);
    const consumo = await consumirCodigoRecuperacao(hashes, codigos[0]?.codigo ?? '');
    expect(consumo.valido).toBe(true);
    expect(consumo.restantes).toHaveLength(2);
    const repetido = await consumirCodigoRecuperacao(consumo.restantes, codigos[0]?.codigo ?? '');
    expect(repetido.valido).toBe(false);
  });
});

describe('senhas', () => {
  it('gera hash bcrypt e confere a senha', async () => {
    const hash = await hashSenha('SenhaDeTeste#Koda2026', { algo: 'bcrypt', bcryptCost: 4, pbkdf2Iterations: 1000 });
    expect(hash.startsWith('$bcrypt$')).toBe(true);
    expect(await verificarSenha('SenhaDeTeste#Koda2026', hash)).toBe(true);
    expect(await verificarSenha('SenhaErrada#Koda2026', hash)).toBe(false);
  });

  it('gera hash pbkdf2 e confere a senha', async () => {
    const hash = await hashSenha('OutraSenhaForte#2026', { algo: 'pbkdf2', bcryptCost: 4, pbkdf2Iterations: 1000 });
    expect(hash.startsWith('$pbkdf2-sha256$1000$')).toBe(true);
    expect(await verificarSenha('OutraSenhaForte#2026', hash)).toBe(true);
    expect(await verificarSenha('outrasenha#2026', hash)).toBe(false);
  });

  it('detecta hash fraco/antigo para rehash', async () => {
    const fraco = await hashSenha('SenhaDeTeste#Koda2026', { algo: 'bcrypt', bcryptCost: 4, pbkdf2Iterations: 1000 });
    expect(precisaRehash(fraco, { algo: 'bcrypt', bcryptCost: 12, pbkdf2Iterations: 1000 })).toBe(true);
    expect(precisaRehash(fraco, { algo: 'pbkdf2', bcryptCost: 12, pbkdf2Iterations: 1000 })).toBe(true);
  });

  it('aplica politica de senha', () => {
    expect(politicaDeSenha('curta')).toMatch(/12 caracteres/);
    expect(politicaDeSenha('aaaaaaaaaaaaaaaa')).toMatch(/repetitiva/);
    expect(politicaDeSenha('senha1234567')).toMatch(/comum/);
    expect(politicaDeSenha('SenhaForte#Koda2026')).toBeNull();
    expect(politicaDeSenha('adminadmin12', { email: 'admin@koda.test' })).not.toBeNull();
  });

  it('valida formatos de hash aceitos no bootstrap', () => {
    expect(hashDeSenhaValido('$bcrypt$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
    expect(hashDeSenhaValido('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
    expect(hashDeSenhaValido('Ki12%%($**aDmmmLIZSUPER')).toBe(false);
    expect(hashDeSenhaValido(null)).toBe(false);
  });

  it('comparacao de tempo constante funciona com tamanhos diferentes', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});

describe('validacao de upload', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  it('aceita png com extensao e mime coerentes', () => {
    expect(validarArquivo({ nome: 'logo.png', mimeDeclarado: 'image/png', bytes: png }, config)).toEqual({
      mime: 'image/png',
      extensao: 'png',
    });
  });

  it('recusa svg (vetor de XSS), extensao trocada e mime divergente', () => {
    expect(() => validarArquivo({ nome: 'logo.svg', mimeDeclarado: 'image/svg+xml', bytes: svg }, config)).toThrow();
    expect(() => validarArquivo({ nome: 'logo.png', mimeDeclarado: 'image/png', bytes: svg }, config)).toThrow();
    expect(() => validarArquivo({ nome: 'logo.png', mimeDeclarado: 'image/jpeg', bytes: png }, config)).toThrow();
    expect(() => validarArquivo({ nome: 'logo.jpg', mimeDeclarado: 'image/jpeg', bytes: png }, config)).toThrow();
  });

  it('recusa arquivo vazio e acima do limite', () => {
    expect(() => validarArquivo({ nome: 'x.png', mimeDeclarado: 'image/png', bytes: new Uint8Array() }, config)).toThrow();
    const grande = new Uint8Array(config.uploadMaxBytes + 1);
    grande.set(png.subarray(0, png.length));
    expect(() => validarArquivo({ nome: 'x.png', mimeDeclarado: 'image/png', bytes: grande }, config)).toThrow();
  });

  it('neutraliza travessia de caminho no nome do arquivo', () => {
    expect(nomeSeguro('../../etc/passwd')).toBe('passwd');
    expect(nomeSeguro('C:\\Windows\\system32\\evil.png')).toBe('evil.png');
    expect(nomeSeguro('...')).toBe('arquivo');
  });
});
