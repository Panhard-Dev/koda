/** base64url de uma string — usado para montar tokens forjados nos testes. */
export function base64url(texto: string): string {
  const bytes = new TextEncoder().encode(texto);
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Códigos de retorno (`?aviso=`/`?erro=`) aparecem no Location do redirect. */
export function codigoDoRedirect(location: string | null, chave: 'aviso' | 'erro'): string | null {
  if (!location) return null;
  const url = new URL(location, 'https://koda.test');
  return url.searchParams.get(chave);
}
