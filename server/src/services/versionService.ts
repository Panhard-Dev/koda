import type { Config } from '../config/env.js';
import type { Contexto } from '../types.js';
import * as releases from '../models/releases.js';
import type { ReleaseRow } from '../models/releases.js';
import { conflito, naoEncontrado, requisicaoInvalida } from '../utils/errors.js';
import {
  chaveDeVersao,
  compararVersao,
  parseVersao,
  urlDeDownloadValida,
  versaoValida,
} from '../utils/semver.js';
import { uuid } from '../utils/crypto.js';
import { auditar } from './auditService.js';

export interface ChecagemAtualizacao {
  update_available: boolean;
  latest_version: string | null;
  download_url: string | null;
  update_required: boolean;
  mandatory: boolean;
  channel: 'stable' | 'beta';
  notes: string | null;
  published_at: string | null;
  checked_version: string;
}

export interface EntradaRelease {
  version: string;
  downloadUrl: string;
  notes?: string | null;
  channel?: 'stable' | 'beta';
  mandatory?: boolean;
  minSupportedVersion?: string | null;
  publicado?: boolean;
}

function validarUrl(url: string, cfg: Config): void {
  if (!urlDeDownloadValida(url, !cfg.isProduction)) {
    throw requisicaoInvalida('download_url deve ser https (sem credenciais embutidas)');
  }
}

/** Resposta consumida pelo próprio app ao abrir. */
export async function checarAtualizacao(
  db: D1Database,
  cfg: Config,
  entrada: { versaoLocal: string; canal: 'stable' | 'beta' },
): Promise<ChecagemAtualizacao> {
  const local = parseVersao(entrada.versaoLocal);
  if (!local) throw requisicaoInvalida('versao local invalida (use semver, ex.: 1.0.0)');

  const ultima = await releases.ultimaPublicada(db, entrada.canal);
  if (!ultima) {
    return {
      update_available: false,
      latest_version: null,
      download_url: null,
      update_required: false,
      mandatory: false,
      channel: entrada.canal,
      notes: null,
      published_at: null,
      checked_version: entrada.versaoLocal,
    };
  }

  const remota = parseVersao(ultima.version);
  const maisNova = remota !== null && compararVersao(local, remota) < 0;
  const minima = ultima.min_supported_version ? parseVersao(ultima.min_supported_version) : null;
  const abaixoDoMinimo = minima !== null && compararVersao(local, minima) < 0;

  return {
    update_available: maisNova,
    latest_version: ultima.version,
    download_url: maisNova || abaixoDoMinimo ? ultima.download_url : ultima.download_url,
    update_required: abaixoDoMinimo || ultima.mandatory === 1,
    mandatory: ultima.mandatory === 1,
    channel: entrada.canal,
    notes: ultima.notes,
    published_at: ultima.published_at,
    checked_version: entrada.versaoLocal,
  };
}

export async function publicar(db: D1Database, cfg: Config, contexto: Contexto, entrada: EntradaRelease): Promise<ReleaseRow> {
  const versao = (entrada.version ?? '').trim();
  if (!versaoValida(versao)) throw requisicaoInvalida('versao deve seguir semver (ex.: 1.4.2)');
  validarUrl(entrada.downloadUrl, cfg);
  if (entrada.minSupportedVersion && !versaoValida(entrada.minSupportedVersion)) {
    throw requisicaoInvalida('min_supported_version deve seguir semver');
  }
  const existente = await releases.buscarPorVersao(db, versao);
  if (existente) throw conflito('versao_existente', 'ja existe release com esta versao');

  const analisada = parseVersao(versao);
  if (!analisada) throw requisicaoInvalida('versao invalida');
  const id = uuid();
  const agora = new Date().toISOString();
  await releases.criar(db, {
    id,
    version: versao,
    versionKey: chaveDeVersao(analisada),
    isPrerelease: analisada.prerelease.length > 0,
    downloadUrl: entrada.downloadUrl,
    notes: entrada.notes?.trim() ?? null,
    channel: entrada.channel ?? 'stable',
    mandatory: entrada.mandatory ?? false,
    minSupportedVersion: entrada.minSupportedVersion ?? null,
    publicado: entrada.publicado ?? true,
    autorId: contexto.ator.id,
    agora,
  });
  await auditar(db, contexto, {
    action: entrada.publicado === false ? 'release.create_draft' : 'release.publish',
    targetType: 'release',
    targetId: id,
    after: { version: versao, channel: entrada.channel ?? 'stable', mandatory: entrada.mandatory ?? false },
    details: { download_url: entrada.downloadUrl },
  });
  const criada = await releases.buscarPorId(db, id);
  if (!criada) throw naoEncontrado('release recem-criada nao encontrada');
  return criada;
}

export async function editar(
  db: D1Database,
  cfg: Config,
  contexto: Contexto,
  id: string,
  entrada: {
    downloadUrl: string;
    notes?: string | null;
    channel?: 'stable' | 'beta';
    mandatory?: boolean;
    minSupportedVersion?: string | null;
  },
): Promise<ReleaseRow> {
  const antes = await releases.buscarPorId(db, id);
  if (!antes) throw naoEncontrado('release nao encontrada');
  validarUrl(entrada.downloadUrl, cfg);
  if (entrada.minSupportedVersion && !versaoValida(entrada.minSupportedVersion)) {
    throw requisicaoInvalida('min_supported_version deve seguir semver');
  }
  const depois = await releases.atualizar(db, id, {
    downloadUrl: entrada.downloadUrl,
    notes: entrada.notes?.trim() ?? null,
    channel: entrada.channel ?? antes.channel,
    mandatory: entrada.mandatory ?? antes.mandatory === 1,
    minSupportedVersion: entrada.minSupportedVersion ?? null,
    agora: new Date().toISOString(),
  });
  if (!depois) throw naoEncontrado('release nao encontrada');
  await auditar(db, contexto, {
    action: 'release.update',
    targetType: 'release',
    targetId: id,
    before: { download_url: antes.download_url, channel: antes.channel, mandatory: antes.mandatory },
    after: { download_url: depois.download_url, channel: depois.channel, mandatory: depois.mandatory },
  });
  return depois;
}

export async function definirPublicacao(
  db: D1Database,
  contexto: Contexto,
  id: string,
  publicado: boolean,
): Promise<ReleaseRow> {
  const antes = await releases.buscarPorId(db, id);
  if (!antes) throw naoEncontrado('release nao encontrada');
  const depois = await releases.definirPublicacao(db, id, publicado, contexto.ator.id, new Date().toISOString());
  if (!depois) throw naoEncontrado('release nao encontrada');
  await auditar(db, contexto, {
    action: publicado ? 'release.publish' : 'release.unpublish',
    targetType: 'release',
    targetId: id,
    before: { published: antes.published },
    after: { published: depois.published },
    details: { version: antes.version },
  });
  return depois;
}

export async function listar(
  db: D1Database,
  opcoes: { pagina: number; porPagina: number; incluirNaoPublicadas: boolean },
): Promise<{ linhas: ReleaseRow[]; total: number; pagina: number; porPagina: number }> {
  const { linhas, total } = await releases.listar(db, {
    limite: opcoes.porPagina,
    deslocamento: (opcoes.pagina - 1) * opcoes.porPagina,
    incluirNaoPublicadas: opcoes.incluirNaoPublicadas,
  });
  return { linhas, total, pagina: opcoes.pagina, porPagina: opcoes.porPagina };
}

export async function remover(db: D1Database, contexto: Contexto, id: string): Promise<void> {
  const antes = await releases.buscarPorId(db, id);
  if (!antes) throw naoEncontrado('release nao encontrada');
  await auditar(db, contexto, {
    action: 'release.delete',
    targetType: 'release',
    targetId: id,
    before: { version: antes.version, published: antes.published, download_url: antes.download_url },
  });
  await releases.deletar(db, id);
}

export async function changelog(
  db: D1Database,
  canal: 'stable' | 'beta',
  limite = 20,
): Promise<{ versao: string; notas: string | null; publicado_em: string | null; obrigatoria: boolean }[]> {
  const { linhas } = await releases.listar(db, { limite, deslocamento: 0, incluirNaoPublicadas: false });
  return linhas
    .filter((linha) => linha.channel === canal || canal === 'stable')
    .map((linha) => ({
      versao: linha.version,
      notas: linha.notes,
      publicado_em: linha.published_at,
      obrigatoria: linha.mandatory === 1,
    }));
}

export async function resumo(db: D1Database) {
  return releases.contar(db);
}
