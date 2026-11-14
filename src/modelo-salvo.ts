import { MODELO_PADRAO } from './models'

/**
 * O modelo escolhido no seletor, lembrado **entre aberturas** do app.
 *
 * Pedido do dono (17/10/2026): «botei e usei a Liz 3 Flash, ela fica selecionada até eu
 * mudar, não importa se fechei ou não». Antes o estado nascia sempre no padrão, então fechar
 * e abrir o Koda devolvia a escolha dele para o modelo de fábrica — e ele tinha de escolher
 * de novo a cada sessão.
 *
 * A chave é **uma só**, global: o modelo não é da conversa, é de quem está usando o app. O
 * `data/` do backend não serve para isto — é configuração do serviço, não preferência de
 * tela, e o app pode rodar sem backend (modo offline) sem perder a escolha.
 */
const CHAVE = 'koda.modelo'

/**
 * Ids da casa antiga que o gateway novo não serve mais.
 *
 * Sem a migração, quem já usava o app abriria com um id que o host recusa (400) e só
 * descobriria isso ao mandar a primeira mensagem. A escolha guardada é da pessoa, mas um id
 * que não existe não é escolha: cai no padrão novo, e o seletor mostra o que está valendo.
 *
 * Só os ids **da casa** entram aqui. Modelo de conta (`provedor:<id>:<modelo>`) é outro
 * caminho e continua valendo — migrar tudo o que não está no catálogo da casa apagaria a
 * escolha de quem usa um provedor logado.
 */
const MODELOS_APOSENTADOS = new Set([
  // Saiu do seletor a pedido do dono (02/11/2026): quem tinha este id salvo cai no padrão
  // novo em vez de abrir com um modelo que o mapa não oferece mais.
  'claude-haiku-5.5',
  'liz-nano',
  'liz-mini-1-3',
  'liz-mini-2',
  'liz-3-flash',
  'liz-4',
  'liz-4-5-super',
  'glm-5.3-flash',
  'qwen-3.8-flash',
  'qwen-3.8-flash-legacy',
  'layze-2',
  'nable-4-mini-preview',
  // Nomes decorativos que o host antigo aceitava e o gateway não conhece.
  'koda-flash',
  'koda-pro',
  'koda-vision',
  'liz-flash',
  'liz-pro',
  'liz-vision',
])

/**
 * O Haiku 5.5 também pode estar salvo como modelo de provedor
 * (`provedor:<id>:claude-haiku-5.5`). Ele saiu do catálogo **da casa**, mas o Accio continua
 * servindo — são catálogos separados. Por isso a migração vale para os outros provedores e
 * **não** para o Accio: lá a escolha antiga continua sendo uma escolha.
 */
const HAIKU_EM_PROVEDOR = /^provedor:(?!accio:)[^:]+:claude-haiku-5\.5$/i

/** O id salvo, já trocado pelo padrão se ele for de um modelo aposentado. */
function migrar(valor: string): string {
  return MODELOS_APOSENTADOS.has(valor) || HAIKU_EM_PROVEDOR.test(valor)
    ? MODELO_PADRAO
    : valor
}

/**
 * O modelo guardado, ou o padrão da casa quando não há nada.
 *
 * Nada aqui pode lançar: sem `localStorage` (janela privada, armazenamento bloqueado) o app
 * tem de abrir normalmente — só que sem lembrar a escolha entre sessões. Valor vazio conta
 * como ausente: string em branco não é um id de modelo.
 */
export function lerModeloSalvo(): string {
  try {
    const salvo = window.localStorage.getItem(CHAVE)
    return salvo && salvo.trim() ? migrar(salvo.trim()) : MODELO_PADRAO
  } catch {
    return MODELO_PADRAO
  }
}

/** Guarda a escolha. Falha em silêncio: sem armazenamento ela vale só nesta sessão. */
export function salvarModelo(valor: string): void {
  try {
    window.localStorage.setItem(CHAVE, valor)
  } catch {
    // Sem localStorage: a escolha vale até fechar a janela.
  }
}
