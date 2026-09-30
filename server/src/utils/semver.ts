/**
 * Semver mínimo, sem dependência: o endpoint público de atualização precisa
 * decidir "a versão instalada é menor que a publicada?".
 */
export interface Versao {
  original: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const PADRAO = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersao(entrada: string): Versao | null {
  const encontrado = PADRAO.exec((entrada ?? '').trim());
  if (!encontrado) return null;
  return {
    original: (entrada ?? '').trim(),
    major: Number(encontrado[1]),
    minor: Number(encontrado[2]),
    patch: Number(encontrado[3]),
    prerelease: (encontrado[4] ?? '').split('.').filter((item) => item !== ''),
  };
}

export const versaoValida = (entrada: string): boolean => parseVersao(entrada) !== null;

/** Chave ordenável em SQL: zero-padding à esquerda, pré-lançamento marcado. */
export function chaveDeVersao(versao: Versao): string {
  return [
    String(versao.major).padStart(6, '0'),
    String(versao.minor).padStart(6, '0'),
    String(versao.patch).padStart(6, '0'),
  ].join('.');
}

/** -1 se `a` < `b`, 0 se iguais, 1 se `a` > `b` (regras do semver). */
export function compararVersao(a: Versao, b: Versao): number {
  for (const campo of ['major', 'minor', 'patch'] as const) {
    if (a[campo] !== b[campo]) return a[campo] < b[campo] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const tamanho = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < tamanho; i += 1) {
    const parteA = a.prerelease[i];
    const parteB = b.prerelease[i];
    if (parteA === undefined) return -1;
    if (parteB === undefined) return 1;
    if (parteA === parteB) continue;
    const numeroA = /^\d+$/.test(parteA);
    const numeroB = /^\d+$/.test(parteB);
    if (numeroA && numeroB) return Number(parteA) < Number(parteB) ? -1 : 1;
    if (numeroA) return -1;
    if (numeroB) return 1;
    return parteA < parteB ? -1 : 1;
  }
  return 0;
}

export function compararTexto(a: string, b: string): number {
  const versaoA = parseVersao(a);
  const versaoB = parseVersao(b);
  if (!versaoA || !versaoB) return a.localeCompare(b);
  return compararVersao(versaoA, versaoB);
}

/** URL de download: só https (ou http em desenvolvimento) e sem credenciais. */
export function urlDeDownloadValida(entrada: string, permitirHttp: boolean): boolean {
  let url: URL;
  try {
    url = new URL(entrada);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return permitirHttp && url.protocol === 'http:';
}
