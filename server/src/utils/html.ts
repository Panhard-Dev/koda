/**
 * Saída de HTML sempre escapada. O painel é server-rendered: qualquer texto
 * que venha do banco (nome de modelo, aviso, e-mail de conta) passa por aqui.
 */
const TROCAS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/[&<>"'`]/g, (caractere) => TROCAS[caractere] ?? caractere);
}

/** Para atributos: mesmo escape, garantindo aspa dupla fechada. */
export const atributo = escapeHtml;

/**
 * JSON embutido em `<script>`: sem `<`, `>` e `&` o navegador não consegue
 * fechar a tag nem criar entidade a partir do conteúdo.
 */
export function jsonSeguro(valor: unknown): string {
  return JSON.stringify(valor ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function truncar(valor: unknown, limite = 120): string {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  return texto.length > limite ? `${texto.slice(0, limite - 1)}…` : texto;
}

export function formatarData(valor: unknown): string {
  if (typeof valor !== 'string' || valor === '') return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toISOString().replace('T', ' ').slice(0, 16);
}
