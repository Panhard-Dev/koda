import type { Config } from '../config/env.js';
import type { Contexto } from '../types.js';
import * as assets from '../models/assets.js';
import { requisicaoInvalida } from '../utils/errors.js';
import { sha256Base64, uuid } from '../utils/crypto.js';
import { auditar } from './auditService.js';

interface Assinatura {
  mime: string;
  extensoes: string[];
  bytes: number[];
  offset?: number;
  sufixo?: { offset: number; bytes: number[] };
}

/**
 * Só imagem raster. SVG fica de fora de propósito: é XML e pode carregar
 * script (XSS armazenado servido do nosso domínio).
 */
const ASSINATURAS: Assinatura[] = [
  { mime: 'image/png', extensoes: ['png'], bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', extensoes: ['jpg', 'jpeg'], bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', extensoes: ['gif'], bytes: [0x47, 0x49, 0x46, 0x38] },
  {
    mime: 'image/webp',
    extensoes: ['webp'],
    bytes: [0x52, 0x49, 0x46, 0x46],
    sufixo: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  },
];

const NOME_SEGURO = /[^a-zA-Z0-9._-]/g;

export interface ArquivoRecebido {
  nome: string;
  mimeDeclarado: string;
  bytes: Uint8Array;
}

export function extensaoDe(nome: string): string {
  const partes = nome.split('.');
  if (partes.length < 2) return '';
  return (partes[partes.length - 1] ?? '').toLowerCase().slice(0, 10);
}

export function nomeSeguro(nome: string): string {
  // Só o basename, sem separador de caminho nem caractere de controle.
  const base = nome.split(/[\\/]/).pop() ?? 'arquivo';
  const limpo = base.replace(NOME_SEGURO, '_').replace(/^\.+/, '').slice(0, 80);
  return limpo === '' ? 'arquivo' : limpo;
}

function detectar(conteudo: Uint8Array): Assinatura | null {
  for (const assinatura of ASSINATURAS) {
    if (conteudo.length < assinatura.bytes.length) continue;
    const confere = assinatura.bytes.every((byte, indice) => conteudo[indice] === byte);
    if (!confere) continue;
    if (assinatura.sufixo) {
      const { offset, bytes } = assinatura.sufixo;
      if (conteudo.length < offset + bytes.length) continue;
      const sufixoConfere = bytes.every((byte, indice) => conteudo[offset + indice] === byte);
      if (!sufixoConfere) continue;
    }
    return assinatura;
  }
  return null;
}

/**
 * Validação em quatro camadas antes de gravar: tamanho, extensão permitida,
 * MIME declarado batendo com o real e bytes mágicos conferindo o formato.
 */
export function validarArquivo(arquivo: ArquivoRecebido, cfg: Config): { mime: string; extensao: string } {
  const tamanho = arquivo.bytes.byteLength;
  if (tamanho === 0) throw requisicaoInvalida('arquivo vazio');
  if (tamanho > cfg.uploadMaxBytes) {
    throw requisicaoInvalida(`arquivo maior que o limite de ${cfg.uploadMaxBytes} bytes`);
  }
  const extensao = extensaoDe(arquivo.nome);
  if (extensao === '') throw requisicaoInvalida('arquivo sem extensao');

  const detectada = detectar(arquivo.bytes);
  if (!detectada) throw requisicaoInvalida('conteudo nao reconhecido como imagem png, jpeg, gif ou webp');
  if (!detectada.extensoes.includes(extensao)) {
    throw requisicaoInvalida(`extensao .${extensao} nao corresponde ao conteudo ${detectada.mime}`);
  }
  const declarado = (arquivo.mimeDeclarado ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (declarado !== '' && declarado !== detectada.mime) {
    throw requisicaoInvalida('tipo declarado nao corresponde ao conteudo do arquivo');
  }
  return { mime: detectada.mime, extensao };
}

export interface AssetSalvo {
  id: string;
  mime: string;
  size: number;
  sha256: string;
  url: string;
}

/** Guarda o conteúdo no banco (nenhum diretório servido estaticamente). */
export async function salvar(
  db: D1Database,
  cfg: Config,
  contexto: Contexto,
  entrada: { arquivo: ArquivoRecebido; kind?: string },
): Promise<AssetSalvo> {
  const { mime, extensao } = validarArquivo(entrada.arquivo, cfg);
  const id = uuid();
  const nomeArmazenado = `${id}.${extensao}`;
  const digest = await sha256Base64(entrada.arquivo.bytes);
  const kind = entrada.kind ?? 'model-image';

  await assets.criar(db, {
    id,
    filename: nomeArmazenado,
    originalName: nomeSeguro(entrada.arquivo.nome),
    mime,
    size: entrada.arquivo.bytes.byteLength,
    sha256: digest,
    kind,
    data: entrada.arquivo.bytes.slice().buffer as ArrayBuffer,
    uploadedBy: contexto.ator.id,
    agora: new Date().toISOString(),
  });

  await auditar(db, contexto, {
    action: 'asset.upload',
    targetType: 'asset',
    targetId: id,
    details: { mime, size: entrada.arquivo.bytes.byteLength, kind, nome_original: nomeSeguro(entrada.arquivo.nome) },
  });

  return { id, mime, size: entrada.arquivo.bytes.byteLength, sha256: digest, url: `/api/public/assets/${id}` };
}

/**
 * Resposta do arquivo: sem sniffing, cacheada por hash e — o detalhe que evita
 * XSS via conteúdo enviado — sempre com `Content-Security-Policy` travada.
 */
export function responderAsset(asset: assets.AssetComConteudo, opcoes: { publico: boolean }): Response {
  const cabecalhos = new Headers({
    'content-type': asset.mime,
    'content-length': String(asset.size),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-site',
    'cache-control': opcoes.publico ? 'public, max-age=86400, immutable' : 'private, no-store',
    etag: `"${asset.sha256}"`,
    'content-disposition': `inline; filename="${asset.filename}"`,
  });
  return new Response(asset.data, { status: 200, headers: cabecalhos });
}

export async function listarAssets(db: D1Database, kind: string | null = 'model-image') {
  return assets.listar(db, kind);
}

export async function removerAsset(db: D1Database, contexto: Contexto, id: string): Promise<void> {
  const asset = await assets.buscarPorId(db, id);
  if (!asset) throw requisicaoInvalida('arquivo nao encontrado');
  await auditar(db, contexto, {
    action: 'asset.delete',
    targetType: 'asset',
    targetId: id,
    before: { filename: asset.filename, mime: asset.mime, size: asset.size },
  });
  await assets.deletar(db, id);
}
