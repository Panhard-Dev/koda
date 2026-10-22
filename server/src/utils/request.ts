/**
 * Leitura defensiva de cabeçalhos. Atrás do Cloudflare o IP confiável vem em
 * `cf-connecting-ip`; `x-forwarded-for` é usado só como último recurso e sempre
 * o primeiro item da lista (o resto pode ter sido forjado pelo cliente).
 */
const TAMANHO_MAXIMO_IP = 64;
const TAMANHO_MAXIMO_UA = 300;

export function ipDaRequisicao(request: Request): string | null {
  const candidatos = [
    request.headers.get('cf-connecting-ip'),
    request.headers.get('x-real-ip'),
    request.headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const candidato of candidatos) {
    const limpo = (candidato ?? '').trim();
    if (limpo !== '' && limpo.length <= TAMANHO_MAXIMO_IP && /^[0-9a-fA-F:.]+$/.test(limpo)) return limpo.toLowerCase();
  }
  return null;
}

export function ipConhecida(request: Request): string {
  return ipDaRequisicao(request) ?? 'desconhecido';
}

export function userAgentDaRequisicao(request: Request): string | null {
  const valor = request.headers.get('user-agent');
  if (!valor) return null;
  return valor.slice(0, TAMANHO_MAXIMO_UA);
}

export function origemDaRequisicao(request: Request): string | null {
  const origem = request.headers.get('origin');
  return origem ? origem.trim().toLowerCase() : null;
}

export function extrairBearer(request: Request): string | null {
  const cabecalho = request.headers.get('authorization');
  if (!cabecalho) return null;
  const [esquema, valor] = cabecalho.split(' ');
  if (!esquema || !valor || esquema.toLowerCase() !== 'bearer') return null;
  const token = valor.trim();
  return token === '' ? null : token;
}

export function ehHttps(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return true;
  const visitante = request.headers.get('cf-visitor');
  if (visitante) {
    try {
      const dados = JSON.parse(visitante) as { scheme?: string };
      if (dados.scheme === 'https') return true;
    } catch {
      // cabeçalho malformado: segue para a checagem seguinte
    }
  }
  return request.headers.get('x-forwarded-proto') === 'https';
}

export function urlBase(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
