import { z } from 'zod';

/* ---------------------------------------------------------------------------
 * Primitivos reutilizados. Toda entrada passa por aqui: nenhum campo chega ao
 * banco sem tipo, tamanho e formato definidos.
 * ------------------------------------------------------------------------- */
const TEXTO_CURTO = 160;
const EMAIL_REGEX = /^[^@\s]{1,64}@[^@\s.]{1,190}(?:\.[^@\s.]{2,24})+$/;

export const emailSchema = z
  .string()
  .trim()
  .min(5, 'e-mail curto demais')
  .max(254, 'e-mail longo demais')
  .regex(EMAIL_REGEX, 'e-mail invalido')
  .transform((valor) => valor.toLowerCase());

export const senhaSchema = z
  .string()
  .min(12, 'senha deve ter ao menos 12 caracteres')
  .max(200, 'senha longa demais');

export const identificadorSchema = z
  .string()
  .trim()
  .min(6, 'identificador curto demais')
  .max(64, 'identificador longo demais')
  .regex(/^[A-Za-z0-9_-]+$/, 'identificador com caracteres invalidos');

export const versaoSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,20})?$/, 'versao deve seguir semver (ex.: 1.2.3)');

export const urlHttpsSchema = z
  .string()
  .trim()
  .max(500)
  .refine((valor) => {
    try {
      const url = new URL(valor);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'url invalida');

const booleanoDeTexto = z
  .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false'), z.boolean()])
  .transform((valor) => valor === true || valor === '1' || valor === 'true');

const booleanoDeQuery = (padrao: boolean) =>
  z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional()
    .transform((valor) => (valor === undefined ? padrao : valor === '1' || valor === 'true'));

const numeroDeQuery = (padrao: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((valor) => (valor === undefined || valor.trim() === '' ? padrao : Number(valor)))
    .pipe(z.number().int().min(min).max(max));

/**
 * Campo opcional de formulário ou de consulta: o input em branco chega como `''`,
 * que não é a mesma coisa que ausente. Sem esta conversão, deixar um campo
 * opcional em branco derruba a validação do formulário inteiro — era o caso da
 * "versao minima suportada" ao publicar uma release pelo painel.
 */
const opcional = <T extends z.ZodType>(esquema: T) =>
  z.preprocess((valor) => (valor === '' ? undefined : valor), esquema.optional());

const dataIso = opcional(
  z
    .string()
    .trim()
    .max(40)
    .refine((valor) => !Number.isNaN(Date.parse(valor)), 'data invalida'),
);

export const motivoSchema = z.string().trim().min(3, 'descreva o motivo (3 a 300 caracteres)').max(300);

/* ---------------------------------------------------------------------------
 * Autenticação
 * ------------------------------------------------------------------------- */
export const loginAdminSchema = z.object({
  email: emailSchema,
  senha: z.string().min(1, 'informe a senha').max(200),
  totp: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((valor) => (valor === '' ? undefined : valor)),
});

export const loginContaSchema = z.object({
  email: emailSchema,
  senha: z.string().min(1, 'informe a senha').max(200),
});

/**
 * Cadastro pelo próprio app. A senha entra pela mesma régua que o painel usa ao criar
 * conta (`senhaSchema` + `politicaDeSenha`, que ainda barra senha comum e senha que
 * repete o e-mail).
 */
export const registroContaSchema = z.object({
  email: emailSchema,
  senha: senhaSchema,
  nome: opcional(z.string().trim().max(TEXTO_CURTO)),
});

export const refreshSchema = z.object({
  refresh_token: opcional(z.string().trim().min(20).max(200)),
});

export const criarContaSchema = z.object({
  email: emailSchema,
  senha: opcional(senhaSchema),
  nome: opcional(z.string().trim().max(TEXTO_CURTO)),
});

export const totpConfirmacaoSchema = z.object({
  codigo: z
    .string()
    .trim()
    .min(6, 'informe o codigo de 6 digitos')
    .max(64, 'codigo longo demais'),
});

export const alterarSenhaSchema = z.object({
  senha_atual: z.string().min(1).max(200),
  senha_nova: senhaSchema,
});

/* ---------------------------------------------------------------------------
 * Contas (painel administrativo)
 * ------------------------------------------------------------------------- */
export const filtroContasSchema = z.object({
  status: opcional(z.enum(['active', 'suspended', 'banned'])),
  busca: opcional(z.string().trim().max(120)),
  criado_de: dataIso,
  criado_ate: dataIso,
  incluir_deletados: booleanoDeQuery(false),
  somente_deletados: booleanoDeQuery(false),
  ordenar: z.enum(['created_at', 'updated_at', 'email', 'status', 'last_login_at']).default('created_at'),
  direcao: z.enum(['asc', 'desc']).default('desc'),
  pagina: numeroDeQuery(1, 1, 100_000),
  por_pagina: numeroDeQuery(25, 1, 100),
});

export const acaoContaSchema = z.object({
  motivo: motivoSchema,
});

export const suspenderContaSchema = z.object({
  motivo: motivoSchema,
  horas: z
    .union([z.string(), z.number()])
    .transform((valor) => Number(valor))
    .pipe(z.number().int().min(1, 'prazo minimo de 1 hora').max(24 * 365, 'prazo maximo de 1 ano')),
});

export const deletarContaSchema = z.object({
  motivo: motivoSchema,
  confirmacao: opcional(z.string().trim().max(254)),
});

export const avisoSchema = z.object({
  titulo: z.string().trim().min(2).max(120),
  corpo: z.string().trim().min(2).max(2_000),
  severidade: z.enum(['info', 'warning', 'critical']).default('info'),
});

/* ---------------------------------------------------------------------------
 * Modelos
 * ------------------------------------------------------------------------- */
export const filtroModelosSchema = z.object({
  ativo: opcional(
    z
      .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
      .transform((valor) => valor === '1' || valor === 'true'),
  ),
  busca: opcional(z.string().trim().max(120)),
  incluir_deletados: booleanoDeQuery(false),
  ordenar: z.enum(['sort_order', 'name', 'created_at']).default('sort_order'),
  direcao: z.enum(['asc', 'desc']).default('asc'),
  pagina: numeroDeQuery(1, 1, 100_000),
  por_pagina: numeroDeQuery(25, 1, 100),
});

export const modeloEntradaSchema = z.object({
  slug: opcional(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(45)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'slug aceita apenas letras minusculas, numeros, ponto, hifen e _'),
  ),
  name: z.string().trim().min(2, 'nome curto demais').max(80),
  description: opcional(z.string().trim().max(500)),
  provider: opcional(z.string().trim().max(60)),
  kind: opcional(z.enum(['chat', 'imagem', 'audio', 'embedding', 'ferramenta'])),
  context_window: z
    .union([z.string(), z.number()])
    .optional()
    .transform((valor) => (valor === undefined || valor === '' ? undefined : Number(valor)))
    .pipe(z.number().int().min(128).max(10_000_000).optional()),
  ativo: opcional(booleanoDeTexto),
  sort_order: z
    .union([z.string(), z.number()])
    .optional()
    .transform((valor) => (valor === undefined || valor === '' ? 0 : Number(valor)))
    .pipe(z.number().int().min(-10_000).max(10_000)),
  metadata: z.record(z.string(), z.unknown()).optional(),
  asset_id: opcional(identificadorSchema),
});

export const ativacaoModeloSchema = z.object({
  ativo: booleanoDeTexto,
});

export const overrideSchema = z.object({
  habilitado: z
    .union([z.boolean(), z.literal('herdar'), z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')])
    .transform((valor) => (valor === 'herdar' ? null : valor === true || valor === '1' || valor === 'true')),
});

export const excecaoModeloSchema = z.object({
  user_id: identificadorSchema,
  habilitado: z.union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false'), z.literal('herdar')]),
});

/* ---------------------------------------------------------------------------
 * Releases / atualização
 * ------------------------------------------------------------------------- */
export const releaseEntradaSchema = z.object({
  version: versaoSchema,
  download_url: urlHttpsSchema,
  notes: opcional(z.string().trim().max(4_000)),
  channel: z.enum(['stable', 'beta']).default('stable'),
  mandatory: opcional(booleanoDeTexto),
  min_supported_version: opcional(versaoSchema),
  publicado: opcional(booleanoDeTexto),
});

export const releaseEdicaoSchema = z.object({
  download_url: urlHttpsSchema,
  notes: opcional(z.string().trim().max(4_000)),
  channel: opcional(z.enum(['stable', 'beta'])),
  mandatory: opcional(booleanoDeTexto),
  min_supported_version: opcional(versaoSchema),
});

/** Consulta pública feita pelo app ao abrir. */
export const checarVersaoSchema = z.object({
  versao: versaoSchema,
  canal: z.enum(['stable', 'beta']).default('stable'),
  plataforma: opcional(z.enum(['windows', 'macos', 'linux', 'android', 'ios', 'web'])),
});

export const filtroReleasesSchema = z.object({
  incluir_nao_publicadas: booleanoDeQuery(false),
  pagina: numeroDeQuery(1, 1, 100_000),
  por_pagina: numeroDeQuery(20, 1, 100),
});

/* ---------------------------------------------------------------------------
 * Auditoria
 * ------------------------------------------------------------------------- */
export const filtroAuditoriaSchema = z.object({
  action: opcional(z.string().trim().max(80)),
  actor_id: opcional(identificadorSchema),
  target_id: opcional(identificadorSchema),
  outcome: opcional(z.enum(['success', 'failure'])),
  de: dataIso,
  ate: dataIso,
  pagina: numeroDeQuery(1, 1, 100_000),
  por_pagina: numeroDeQuery(50, 1, 200),
});

export const verificarAuditoriaSchema = z.object({
  limite: numeroDeQuery(500, 1, 1_000),
  deslocamento: numeroDeQuery(0, 0, 1_000_000),
});

/* ---------------------------------------------------------------------------
 * Formulários do painel (application/x-www-form-urlencoded chega como texto)
 * ------------------------------------------------------------------------- */
export const formularioLoginSchema = z.object({
  email: emailSchema,
  senha: z.string().min(1).max(200),
  totp: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((valor) => (valor === '' ? undefined : valor)),
  proximo: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((valor) => (valor && valor.startsWith('/admin') ? valor : '/admin')),
});

export const formularioRefreshSchema = z.object({});

export const formularioContaNovaSchema = z.object({
  email: emailSchema,
  nome: opcional(z.string().trim().max(TEXTO_CURTO)),
  senha: senhaSchema,
});

/** Criação de modelo pelo formulário: slug obrigatório. */
export const formularioModeloNovoSchema = modeloEntradaSchema.extend({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'slug curto demais')
    .max(45, 'slug longo demais')
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'slug aceita apenas letras minusculas, numeros, ponto, hifen e _'),
});

/** Edição pelo formulário: só o que o painel expõe. */
export const formularioModeloEdicaoSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: opcional(z.string().trim().max(500)),
  context_window: z
    .union([z.string(), z.number()])
    .optional()
    .transform((valor) => (valor === undefined || valor === '' ? undefined : Number(valor)))
    .pipe(z.number().int().min(128).max(10_000_000).optional()),
  sort_order: z
    .union([z.string(), z.number()])
    .optional()
    .transform((valor) => (valor === undefined || valor === '' ? 0 : Number(valor)))
    .pipe(z.number().int().min(-10_000).max(10_000)),
  kind: opcional(z.enum(['chat', 'imagem', 'audio', 'embedding', 'ferramenta'])),
  provider: opcional(z.string().trim().max(60)),
});

/** Exceção individual enviada pelo formulário da conta. */
export const formularioOverrideSchema = z.object({
  model_id: identificadorSchema,
  habilitado: z.enum(['1', '0', 'herdar']),
});

export const formularioImagemSchema = z.object({
  model_id: opcional(identificadorSchema),
});

export const identificadorParamSchema = z.object({ id: identificadorSchema });

/**
 * Autorização do host local: a chave que ele recebeu do cliente e está
 * repassando para saber se vale. Não é credencial de conta — é a chave que
 * separa quem pode usar a API de modelos de quem só achou a porta.
 */
export const autorizacaoHostSchema = z.object({
  // O campo carrega duas coisas: a chave de serviço (curta) ou o access token da conta,
  // que é um JWT — por isso o teto é folgado. Um limite justo para chave cortaria a
  // sessão do app, que é o caminho normal.
  chave: z.string().min(1, 'chave ausente').max(4096, 'chave longa demais'),
});
