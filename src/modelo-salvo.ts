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
 * O modelo guardado, ou o padrão da casa quando não há nada.
 *
 * Nada aqui pode lançar: sem `localStorage` (janela privada, armazenamento bloqueado) o app
 * tem de abrir normalmente — só que sem lembrar a escolha entre sessões. Valor vazio conta
 * como ausente: string em branco não é um id de modelo.
 */
export function lerModeloSalvo(): string {
  try {
    const salvo = window.localStorage.getItem(CHAVE)
    return salvo && salvo.trim() ? salvo.trim() : MODELO_PADRAO
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
