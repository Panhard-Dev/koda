import type { ContextoApp } from '../types.js';
import { corpoForm, parametros } from '../middlewares/validacao.js';
import {
  acaoContaSchema,
  avisoSchema,
  formularioContaNovaSchema,
  formularioModeloEdicaoSchema,
  formularioModeloNovoSchema,
  formularioOverrideSchema,
  identificadorParamSchema,
  suspenderContaSchema,
} from '../validation/schemas.js';
import * as contas from '../services/accountService.js';
import * as modelos from '../services/modelService.js';
import * as uploads from '../services/uploadService.js';
import { hashSenha, politicaDeSenha } from '../services/passwordService.js';
import { requisicaoInvalida } from '../utils/errors.js';
import { contexto, executar } from './panelComum.js';

const LISTA = '/admin/contas';

/* --------------------------------- Contas -------------------------------- */
export async function criarConta(c: ContextoApp): Promise<Response> {
  const cfg = c.get('config');
  const dados = await corpoForm(c, formularioContaNovaSchema);
  return executar(c, LISTA, 'conta-criada', async () => {
    const motivo = politicaDeSenha(dados.senha, { email: dados.email });
    if (motivo) throw requisicaoInvalida(motivo);
    const hash = await hashSenha(dados.senha, {
      algo: cfg.hashAlgo,
      bcryptCost: cfg.bcryptCost,
      pbkdf2Iterations: cfg.pbkdf2Iterations,
    });
    await contas.criarConta(c.env.DB, contexto(c), cfg, {
      email: dados.email,
      senhaHash: hash,
      nome: dados.nome ?? null,
    });
  });
}

export async function banirConta(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, acaoContaSchema);
  return executar(c, `/admin/contas/${id}`, 'conta-atualizada', async () => {
    await contas.banir(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  });
}

export async function suspenderConta(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, suspenderContaSchema);
  return executar(c, `/admin/contas/${id}`, 'conta-atualizada', async () => {
    await contas.suspender(c.env.DB, contexto(c), { id, motivo: dados.motivo, horas: dados.horas });
  });
}

export async function reativarConta(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, acaoContaSchema);
  return executar(c, `/admin/contas/${id}`, 'conta-atualizada', async () => {
    await contas.reativar(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  });
}

export async function removerConta(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, acaoContaSchema);
  return executar(c, `/admin/contas/${id}`, 'conta-removida', async () => {
    await contas.deletarLogico(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  });
}

export async function restaurarConta(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, acaoContaSchema);
  return executar(c, `/admin/contas/${id}`, 'conta-restaurada', async () => {
    await contas.restaurar(c.env.DB, contexto(c), { id, motivo: dados.motivo });
  });
}

export async function avisarConta(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, avisoSchema);
  return executar(c, `/admin/contas/${id}`, 'conta-avisada', async () => {
    await contas.avisar(c.env.DB, contexto(c), {
      id,
      titulo: dados.titulo,
      corpo: dados.corpo,
      severidade: dados.severidade,
    });
  });
}

export async function definirModeloConta(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, formularioOverrideSchema);
  const habilitado = dados.habilitado === 'herdar' ? null : dados.habilitado === '1';
  return executar(c, `/admin/contas/${id}`, 'conta-atualizada', async () => {
    await contas.definirModelo(c.env.DB, contexto(c), { userId: id, modelId: dados.model_id, habilitado });
  });
}

/* -------------------------------- Modelos -------------------------------- */
const MODELOS = '/admin/modelos';

export async function criarModelo(c: ContextoApp): Promise<Response> {
  const dados = await corpoForm(c, formularioModeloNovoSchema);
  return executar(c, MODELOS, 'modelo-criado', async () => {
    await modelos.criar(c.env.DB, contexto(c), {
      slug: dados.slug,
      name: dados.name,
      description: dados.description ?? null,
      provider: dados.provider,
      kind: dados.kind,
      contextWindow: dados.context_window ?? null,
      ativo: dados.ativo ?? true,
      sortOrder: dados.sort_order,
      metadata: dados.metadata ?? {},
    });
  });
}

export async function editarModelo(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const dados = await corpoForm(c, formularioModeloEdicaoSchema);
  return executar(c, MODELOS, 'modelo-atualizado', async () => {
    await modelos.editar(c.env.DB, contexto(c), id, {
      name: dados.name,
      description: dados.description ?? null,
      contextWindow: dados.context_window ?? null,
      sortOrder: dados.sort_order,
      kind: dados.kind,
      provider: dados.provider,
    });
  });
}

export async function alternarModelo(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const formulario = await c.req.parseBody();
  const ativo = String(formulario['ativo'] ?? '1') === '1';
  return executar(c, MODELOS, 'modelo-atualizado', async () => {
    await modelos.ativarGlobal(c.env.DB, contexto(c), id, ativo);
  });
}

export async function removerModelo(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  return executar(c, MODELOS, 'modelo-removido', async () => {
    await modelos.remover(c.env.DB, contexto(c), { id, definitivo: false });
  });
}

export async function restaurarModelo(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  return executar(c, MODELOS, 'modelo-atualizado', async () => {
    await modelos.restaurar(c.env.DB, contexto(c), id);
  });
}

export async function enviarImagemModelo(c: ContextoApp): Promise<Response> {
  const { id } = parametros(c, identificadorParamSchema);
  const cfg = c.get('config');
  return executar(c, MODELOS, 'modelo-atualizado', async () => {
    const formulario = await c.req.parseBody();
    const arquivo = formulario['arquivo'];
    if (!(arquivo instanceof File)) throw requisicaoInvalida('campo arquivo ausente');
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    const salvo = await uploads.salvar(c.env.DB, cfg, contexto(c), {
      arquivo: { nome: arquivo.name, mimeDeclarado: arquivo.type, bytes },
      kind: 'model-image',
    });
    const atual = await modelos.obter(c.env.DB, id);
    await modelos.editar(c.env.DB, contexto(c), id, {
      name: atual.modelo.name,
      description: atual.modelo.description,
      provider: atual.modelo.provider,
      kind: atual.modelo.kind,
      contextWindow: atual.modelo.context_window,
      sortOrder: atual.modelo.sort_order,
      assetId: salvo.id,
    });
  });
}
