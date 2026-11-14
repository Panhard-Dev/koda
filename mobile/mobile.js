/*
 * Compositor do celular.
 *
 * Os controles são os do PC (modelo, esforço, permissão, anexos, reasoning, web,
 * voz e projeto) e a conversa fala com o **backend de verdade**: o mesmo
 * `POST /api/chat` do app de PC, com o mesmo `text/event-stream`. Nada aqui é
 * resposta simulada — raciocínio, ferramentas, cartão de permissão e fala final
 * vêm dos eventos reais do agente.
 */
/* ------------------------------------------------------------------------- */
/* Backend e koda-link                                                       */
/* ------------------------------------------------------------------------- */

import { desenharBloco, desenharInterface, ehBlocoVisual } from './blocos.js'

const ENV = import.meta.env ?? {}

/*
 * Quando a página é aberta pelo koda-link, o `#` traz a sala e o código. Nesse
 * modo tudo passa por um WebSocket até o PC: `127.0.0.1` no celular é o próprio
 * celular, não o computador.
 */
const parametrosDoLink = new URLSearchParams(location.hash.replace(/^#/, ''))

/*
 * A sessão do link vive no `localStorage`, não no `sessionStorage`: o Android
 * mata o processo do WebView quando o app vai para segundo plano, e a sessão
 * precisa sobreviver a isso. Sem ela, reabrir o app caía na entrada e o código
 * do QR já tinha sido queimado no primeiro pareamento.
 */
function lerLinkGuardado() {
  try {
    const salvo = JSON.parse(localStorage.getItem('koda-link:atual') ?? 'null')
    return salvo && typeof salvo.sala === 'string' && salvo.sala ? salvo : null
  } catch {
    return null
  }
}

function sessaoDoLink(sala) {
  try {
    return localStorage.getItem(`koda-link:${sala}`) ?? ''
  } catch {
    return ''
  }
}

const linkGuardado = lerLinkGuardado()
const salaDoLink = parametrosDoLink.get('sala') || linkGuardado?.sala || ''
const LINK = salaDoLink
  ? {
      sala: salaDoLink,
      codigo: parametrosDoLink.get('codigo') ?? '',
      sessao: sessaoDoLink(salaDoLink),
    }
  : null

/*
 * A API pode vir de três lugares, nesta ordem: o que a pessoa salvou na tela
 * de entrada do celular, o que o Vite injetou na build, e o padrão de
 * desenvolvimento. Sem link e sem API configurada, o app pede os dados.
 */
function lerConfigDaApi() {
  try {
    const salvo = JSON.parse(localStorage.getItem('koda-api') ?? 'null')
    if (salvo && typeof salvo.url === 'string' && salvo.url) return salvo
  } catch {
    /* localStorage indisponível (modo privado antigo) */
  }
  return null
}

const CONFIG_API = lerConfigDaApi()
const API = (CONFIG_API?.url ?? ENV.VITE_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const TOKEN = CONFIG_API?.token ?? ENV.VITE_API_TOKEN ?? ''
/*
 * `VITE_API_URL` costuma apontar para 127.0.0.1 — o que só vale quando a
 * página está no próprio PC. No celular, `localhost` é o celular: a porta de
 * entrada precisa aparecer para pedir o endereço de verdade.
 */
const SERVIDOR_LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname)
const PRECISA_ENTRAR = !LINK && !CONFIG_API && !(ENV.VITE_API_URL && SERVIDOR_LOCAL)

const cabecalhos = (json = true) => ({
  ...(json ? { 'content-type': 'application/json' } : {}),
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
  'x-koda-window': 'mobile',
})

const linkEstado = document.getElementById('link-estado')
const linkEstadoTexto = document.getElementById('link-estado-texto')

function mostrarLink(texto) {
  if (!linkEstado || !linkEstadoTexto) return
  linkEstadoTexto.textContent = texto
  linkEstado.hidden = false
}

function esconderLink() {
  if (linkEstado) linkEstado.hidden = true
}

const link = LINK
  ? {
      ws: null,
      aberto: null,
      pareado: false,
      direto: false,
      sessao: LINK.sessao,
      pendentes: new Map(),
      tentativas: 0,
      parado: false,
    }
  : null

/*
 * Instalação na tela inicial (PWA). O Chrome só entrega este evento quando o
 * app cumpre os requisitos (HTTPS do túnel, manifest e service worker); guardar
 * o evento permite oferecer «Instalar o Koda» no menu «+» em vez de esconder a
 * opção no menu do navegador.
 */
let instalacao = null
window.addEventListener('beforeinstallprompt', (evento) => {
  evento.preventDefault()
  instalacao = evento
})
window.addEventListener('appinstalled', () => {
  instalacao = null
})

function urlDoLink() {
  const protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const consulta = new URLSearchParams({ papel: 'convidado' })
  if (link.sessao) consulta.set('sessao', link.sessao)
  else consulta.set('codigo', LINK.codigo)
  return `${protocolo}//${location.host}/ws/${encodeURIComponent(LINK.sala)}?${consulta}`
}

function novoId() {
  // `crypto.randomUUID` só existe em contexto seguro (HTTPS ou localhost). Na
  // Wi-Fi de casa o celular abre `http://192.168…`, então há um fallback — o id
  // só correlaciona pedido e resposta, não é segredo.
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function base64DoBuffer(buffer) {
  const bytes = new Uint8Array(buffer)
  let texto = ''
  const passo = 0x8000
  for (let i = 0; i < bytes.length; i += passo) {
    texto += String.fromCharCode(...bytes.subarray(i, i + passo))
  }
  return btoa(texto)
}

function bytesDoBase64(texto) {
  const bruto = atob(texto)
  const bytes = new Uint8Array(bruto.length)
  for (let i = 0; i < bruto.length; i += 1) bytes[i] = bruto.charCodeAt(i)
  return bytes
}

function receberDoLink(dados) {
  const pendente = link?.pendentes.get(dados.id)
  if (!pendente) return
  if (dados.tipo === 'inicio') {
    pendente.iniciar(dados.status, dados.cabecalhos?.['content-type'] ?? '')
  } else if (dados.tipo === 'pedaco') {
    pendente.pedaco(dados.dados, dados.dados_b64)
  } else if (dados.tipo === 'fim') {
    link.pendentes.delete(dados.id)
    pendente.fim()
  } else if (dados.tipo === 'erro') {
    link.pendentes.delete(dados.id)
    pendente.falhar(new Error(dados.mensagem || 'falha no link'))
  }
}

function atualizarPresenca(dados) {
  if (link?.direto || dados.direto || dados.host) {
    esconderLink()
    return
  }
  mostrarLink('Aguardando o Koda do PC… deixe o app aberto no computador.')
  // O PC caiu no meio de um pedido: não deixa a resposta pendurada para sempre.
  for (const pendente of link.pendentes.values()) {
    pendente.falhar(new Error('o PC desconectou'))
  }
  link.pendentes.clear()
}

function conectarLink() {
  if (!link) return Promise.resolve()
  if (link.pareado && link.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (link.aberto) return link.aberto

  link.aberto = new Promise((resolver, rejeitar) => {
    let liberado = false
    const liberar = (erro) => {
      if (liberado) return
      liberado = true
      link.aberto = null
      if (erro) rejeitar(erro)
      else resolver()
    }

    let ws
    try {
      ws = new WebSocket(urlDoLink())
    } catch (erro) {
      liberar(erro)
      return
    }
    link.ws = ws

    ws.onopen = () => {
      link.tentativas = 0
    }

    ws.onmessage = (evento) => {
      let dados
      try {
        dados = JSON.parse(evento.data)
      } catch {
        return
      }
      if (dados.tipo === 'pareado') {
        link.pareado = true
        link.direto = Boolean(dados.direto)
        if (dados.sessao) {
          link.sessao = dados.sessao
          try {
            localStorage.setItem(`koda-link:${LINK.sala}`, dados.sessao)
            localStorage.setItem(
              'koda-link:atual',
              JSON.stringify({ sala: LINK.sala, sessao: dados.sessao }),
            )
          } catch {
            /* memória cheia: a sessão vale só enquanto o app estiver aberto */
          }
        }
        atualizarPresenca(dados)
        liberar()
        return
      }
      if (dados.tipo === 'presenca') {
        atualizarPresenca(dados)
        return
      }
      if (dados.tipo === 'pong') return
      receberDoLink(dados)
    }

    ws.onclose = (evento) => {
      link.ws = null
      link.pareado = false
      link.direto = false
      for (const pendente of link.pendentes.values()) {
        pendente.falhar(new Error('a conexão com o PC caiu'))
      }
      link.pendentes.clear()

      if (evento.code === 4403) {
        liberar(new Error('código inválido ou já usado'))
        voltarParaEntrada('Código inválido ou já usado. Leia um QR novo no PC.')
        return
      }

      // 4404 = a sala não existe mais (o PC girou o QR ou o link foi desligado).
      // Insistir nela é o que prendia o celular em «Reconectando…» para sempre.
      if (evento.code === 4404) {
        liberar(new Error('sala inexistente ou expirada'))
        voltarParaEntrada('Esta sala não existe mais. Leia um QR novo no PC.')
        return
      }

      if (!link.parado) {
        // Depois de algumas tentativas, o problema não é um soluço: volta para
        // a entrada em vez de girar «Reconectando…» indefinidamente.
        if (link.tentativas >= 7) {
          liberar(new Error('não consegui falar com o PC'))
          voltarParaEntrada(
            'Não consegui falar com o PC. Confira se o Koda está aberto e leia um QR novo.',
          )
          return
        }
        const espera = Math.min(1000 * 2 ** link.tentativas, 10000)
        link.tentativas += 1
        mostrarLink('Reconectando ao seu Koda…')
        setTimeout(() => {
          conectarLink().catch(() => {})
        }, espera)
      }
      liberar(new Error('conexão encerrada'))
    }

    ws.onerror = () => {
      /* o `close` traz o motivo */
    }
  })

  return link.aberto
}

async function pedirPeloLink(caminho, opcoes = {}) {
  await conectarLink()
  if (!link?.ws || link.ws.readyState !== WebSocket.OPEN) {
    throw new Error('sem conexão com o PC')
  }

  const id = novoId()
  const metodo = (opcoes.method ?? 'GET').toUpperCase()
  const cabecalhosDoPedido = { ...(opcoes.headers ?? {}) }
  delete cabecalhosDoPedido.authorization
  delete cabecalhosDoPedido.Authorization

  let corpo = null
  let corpoB64 = null
  if (opcoes.body instanceof FormData) {
    const pedido = new Request('http://koda.local', { method: 'POST', body: opcoes.body })
    corpoB64 = base64DoBuffer(await pedido.arrayBuffer())
    cabecalhosDoPedido['content-type'] = pedido.headers.get('content-type') ?? ''
  } else if (typeof opcoes.body === 'string') {
    corpo = opcoes.body
  } else if (opcoes.body != null) {
    corpo = String(opcoes.body)
  }

  let controle
  const fluxo = new ReadableStream({
    start(c) {
      controle = c
    },
  })

  const resposta = new Promise((resolver, rejeitar) => {
    link.pendentes.set(id, {
      iniciar(status, tipo) {
        // 204/205/304 não aceitam corpo: `new Response(fluxo, {status: 204})` lança,
        // a promessa ficava pendurada e o DELETE do histórico nunca terminava.
        const semCorpo = status === 204 || status === 205 || status === 304
        resolver(
          new Response(semCorpo ? null : fluxo, {
            status,
            headers: tipo ? { 'content-type': tipo } : {},
          }),
        )
      },
      pedaco(texto, b64) {
        if (texto != null) controle.enqueue(new TextEncoder().encode(texto))
        else if (b64) controle.enqueue(bytesDoBase64(b64))
      },
      fim() {
        try {
          controle.close()
        } catch {
          /* já fechado */
        }
      },
      falhar(erro) {
        try {
          controle.error(erro)
        } catch {
          /* já fechado */
        }
        rejeitar(erro)
      },
    })
  })

  link.ws.send(
    JSON.stringify({
      tipo: 'pedido',
      id,
      metodo,
      caminho,
      corpo,
      corpo_b64: corpoB64,
      cabecalhos: cabecalhosDoPedido,
    }),
  )

  if (opcoes.signal) {
    opcoes.signal.addEventListener(
      'abort',
      () => {
        const pendente = link.pendentes.get(id)
        if (!pendente) return
        link.pendentes.delete(id)
        try {
          link.ws?.send(JSON.stringify({ tipo: 'cancelar', id }))
        } catch {
          /* socket já fechou */
        }
        pendente.falhar(new DOMException('Abortado', 'AbortError'))
      },
      { once: true },
    )
  }

  return resposta
}

function abrirFluxo(caminho, opcoes = {}) {
  if (link) return pedirPeloLink(caminho, opcoes)
  return fetch(`${API}${caminho}`, opcoes)
}

async function api(caminho, opcoes = {}) {
  const resposta = await abrirFluxo(caminho, {
    ...opcoes,
    headers: { ...cabecalhos(!(opcoes.body instanceof FormData)), ...(opcoes.headers ?? {}) },
  })
  if (!resposta.ok) {
    let detalhe = ''
    try {
      const corpo = await resposta.json()
      detalhe = corpo?.detail ?? corpo?.message ?? ''
    } catch {
      /* corpo vazio ou não-JSON */
    }
    throw new Error(detalhe || `o backend respondeu ${resposta.status}`)
  }
  return resposta.status === 204 ? null : resposta.json()
}

/* ------------------------------------------------------------------------- */
/* Ícones (os mesmos traços do app de PC)                                    */
/* ------------------------------------------------------------------------- */

const TRACOS = {
  cerebro:
    '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  chave:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  clipboard:
    '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  escudo:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  escudoPergunta:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  escudoAlerta:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  cadeadoAberto:
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  imagem:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  clipe:
    '<path d="M13.234 20.252 21 12.3"/><path d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486"/>',
  pasta:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M8 10v4"/><path d="M12 10v2"/><path d="M16 10v6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alerta:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  // ---- ícones de ferramenta, iguais aos do PC ----
  terminal:
    '<rect x="2.8" y="4.2" width="18.4" height="15.6" rx="3"/><path d="M2.8 9h18.4"/><path d="M6.4 6.6h.01M9 6.6h.01"/><path d="M7 12.6l2.4 2.4L7 17.4"/><path d="M12.6 17.4h4.4"/>',
  rodar:
    '<rect x="3" y="4.4" width="18" height="15.2" rx="4.6"/><path d="M10.4 9.3l4.5 2.7-4.5 2.7z"/>',
  arquivo:
    '<path d="M6.2 3.6h7.2l4.4 4.4v12.4H6.2z"/><path d="M13.2 3.6v4.6h4.6"/><path d="M9.2 13.4h5.6M9.2 16.8h3.6"/>',
  arquivoNovo:
    '<path d="M6.2 3.6h7.2l4.4 4.4v12.4H6.2z"/><path d="M13.2 3.6v4.6h4.6"/><path d="M12 12.6v5.4M9.3 15.3h5.4"/>',
  lapis:
    '<path d="M4.6 19.4l1-3.6L15.9 5.5a2.1 2.1 0 013 3L8.6 18.8z"/><path d="M14.4 7l2.8 2.8"/>',
  lixeira:
    '<path d="M4.4 7.4h15.2"/><path d="M9.4 7.4V5.9a1.5 1.5 0 011.5-1.5h2.2a1.5 1.5 0 011.5 1.5v1.5"/><path d="M6.8 7.4l.8 11a1.6 1.6 0 001.6 1.5h5.6a1.6 1.6 0 001.6-1.5l.8-11"/><path d="M10.6 11.2v5.2M13.4 11.2v5.2"/>',
  lupa: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4l4.2 4.2"/>',
  regex:
    '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4l4.2 4.2"/><path d="M10.6 8v5.2M8 9.5l5.2 2.2M13.2 9.5l-5.2 2.2"/>',
  globo:
    '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6c2.3 2.3 3.5 5.2 3.5 8.4S14.3 18.1 12 20.4C9.7 18.1 8.5 15.2 8.5 12S9.7 5.9 12 3.6z"/>',
  janela:
    '<rect x="3" y="4.4" width="18" height="15.2" rx="3"/><path d="M3 9.2h18"/><path d="M6.6 6.8h.01M9.2 6.8h.01"/>',
  ramo: '<circle cx="7" cy="6.4" r="2.2"/><circle cx="7" cy="17.6" r="2.2"/><circle cx="16.8" cy="9.4" r="2.2"/><path d="M7 8.6v7"/><path d="M16.8 11.6c0 3-2.5 4.6-5.2 4.6H9.2"/>',
  diff: '<rect x="3.2" y="5" width="7.4" height="14" rx="2"/><rect x="13.4" y="5" width="7.4" height="14" rx="2"/><path d="M5.7 9.2h2.4M6.9 8v2.4"/><path d="M15.9 9.2h2.4M15.9 15.2h2.4"/>',
  historico:
    '<path d="M20.4 12a8.4 8.4 0 11-2.7-6.2"/><path d="M20.6 3.6v4.2h-4.2"/><path d="M12 8.4V12l2.9 1.9"/>',
  engrenagem:
    '<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.88.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  atividade: '<path d="M3 12h4l2.5-7 4 14 2.5-7h5"/>',
  seta: '<path d="m9 18 6-6-6-6"/>',
  commit: '<path d="M12 3.6v5M12 15.4v5"/><circle cx="12" cy="12" r="3.4"/>',
  enviar:
    '<path d="M12 19.4V5.6"/><path d="M6.4 11.2L12 5.6l5.6 5.6"/><path d="M4.8 19.4h14.4"/>',
  baixar:
    '<path d="M12 4.6v13.8"/><path d="M6.4 12.8L12 18.4l5.6-5.6"/><path d="M4.8 19.4h14.4"/>',
  pacote:
    '<path d="M12 3.6l7.6 4.2v8.4L12 20.4l-7.6-4.2V7.8z"/><path d="M4.4 7.8L12 12l7.6-4.2M12 12v8.4"/>',
  plano:
    '<path d="M4.6 6.4l1.5 1.5 2.6-2.8"/><path d="M4.6 12.6l1.5 1.5 2.6-2.8"/><path d="M4.6 18.8l1.5 1.5 2.6-2.8"/><path d="M11.6 6.9h7.8M11.6 13.1h7.8M11.6 19.3h5.4"/>',
  retalho:
    '<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="2.6"/><path d="M9.2 9.4h6M9.2 12.2h3.4M9.2 15h6M14.6 12.2h.6"/>',
  quebraCabeca:
    '<path d="M9.4 4.3a2 2 0 0 1 4 0v.9h2.6a1.9 1.9 0 0 1 1.9 1.9v2.6h-.9a2 2 0 0 0 0 4h.9v2.6a1.9 1.9 0 0 1-1.9 1.9h-2.6v-.9a2 2 0 0 0-4 0v.9H6.8a1.9 1.9 0 0 1-1.9-1.9v-2.6h.9a2 2 0 0 0 0-4h-.9V7.1a1.9 1.9 0 0 1 1.9-1.9h2.6z"/>',
  conector:
    '<path d="M8.6 3.4v3.1M15.4 3.4v3.1"/><path d="M6.4 6.5h11.2v2.3a5.6 5.6 0 0 1-11.2 0z"/><path d="M12 14.4v1.9a3.6 3.6 0 0 1-3.6 3.6H6.6"/><circle cx="5.6" cy="19.9" r="1.1"/>',
}

const traco = (nome, tamanho = 16) =>
  `<svg viewBox="0 0 24 24" width="${tamanho}" height="${tamanho}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TRACOS[nome] ?? TRACOS.chave}</svg>`

const COROA =
  '<svg viewBox="0 0 810 580" width="14" height="10" aria-hidden="true"><polygon points="0,520 160,520 60,140 270,310 400,80 530,310 740,140 640,520 800,520" fill="currentColor"/></svg>'

/** A coroa com o brilho atravessando, como a `ThinkingMark` do PC. */
const COROA_TRABALHANDO = `
<svg viewBox="0 0 810 580" width="15" height="11" aria-hidden="true">
  <defs>
    <linearGradient id="koda-mobile-brilho" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--koda-accent)" stop-opacity="0"/>
      <stop offset="0.21" stop-color="var(--koda-accent)" stop-opacity="1"/>
      <stop offset="0.29" stop-color="var(--koda-accent)" stop-opacity="1"/>
      <stop offset="0.5" stop-color="var(--koda-accent)" stop-opacity="0"/>
      <stop offset="0.71" stop-color="var(--koda-accent)" stop-opacity="1"/>
      <stop offset="0.79" stop-color="var(--koda-accent)" stop-opacity="1"/>
      <stop offset="1" stop-color="var(--koda-accent)" stop-opacity="0"/>
    </linearGradient>
    <mask id="koda-mobile-mascara">
      <polygon points="0,520 160,520 60,140 270,310 400,80 530,310 740,140 640,520 800,520" fill="#fff"/>
    </mask>
  </defs>
  <polygon points="0,520 160,520 60,140 270,310 400,80 530,310 740,140 640,520 800,520" fill="currentColor" opacity="0.25"/>
  <g mask="url(#koda-mobile-mascara)">
    <rect class="thinking-shine" x="0" y="0" width="1620" height="580" fill="url(#koda-mobile-brilho)"/>
  </g>
</svg>`

const CHEVRON =
  '<svg class="bloco__chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'

/** O arco girando, igual ao `ToolSpinner` do PC. */
const GIRADOR = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.4" stroke="currentColor" stroke-width="1.7" opacity="0.22"/><path d="M20.4 12a8.4 8.4 0 00-8.4-8.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" class="girador__arco"/></svg>`

/* ------------------------------------------------------------------------- */
/* Ferramentas: rótulos e ícones do PC                                       */
/* ------------------------------------------------------------------------- */

const ROTULOS = {
  code_interpreter: 'Rodar Python',
  shell: 'Rodar comando',
  terminal: 'Rodar comando',
  read_file: 'Ler arquivo',
  write_file: 'Escrever arquivo',
  edit_file: 'Editar arquivo',
  str_replace_editor: 'Editar arquivo',
  list_dir: 'Listar pasta',
  delete_file: 'Apagar arquivo',
  create_directory: 'Criar pasta',
  delete_directory: 'Apagar pasta',
  move_file: 'Mover arquivo',
  copy_file: 'Copiar arquivo',
  rename_file: 'Renomear arquivo',
  get_environment: 'Ver ambiente',
  update_todos: 'Registrar plano',
  search_files: 'Procurar arquivo',
  apply_patch: 'Aplicar patch',
  search_codebase: 'Buscar no código',
  vector_search: 'Buscar no código',
  grep: 'Buscar com regex',
  regex_search: 'Buscar com regex',
  get_problems: 'Conferir arquivo',
  linter: 'Conferir arquivo',
  web_search: 'Buscar na web',
  url_reader: 'Abrir página',
  browser: 'Abrir página',
  git_status: 'Status do git',
  git_diff: 'Diff do git',
  git_log: 'Histórico do git',
  git_commit: 'Commit no git',
  git_push: 'Enviar para o git',
  git_pull: 'Baixar do git',
  install_package: 'Instalar dependência',
  uninstall_package: 'Remover dependência',
  download_file: 'Baixar arquivo',
  upload_file: 'Enviar arquivo',
  read_attachment: 'Ler anexo',
  save_attachment: 'Salvar anexo no PC',
  send_to_phone: 'Enviar para o celular',
  use_skill: 'Usar skill',
}

const APELIDOS = {
  run_command: 'shell',
  execute_command: 'shell',
  run_code: 'code_interpreter',
  list_directory: 'list_dir',
  listdir: 'list_dir',
  ls: 'list_dir',
  mkdir: 'create_directory',
  rmdir: 'delete_directory',
  search_code: 'search_codebase',
  glob: 'search_files',
  find_files: 'search_files',
  open_url: 'url_reader',
  fetch_url: 'url_reader',
  read_url: 'url_reader',
  create_file: 'write_file',
  update_plan: 'update_todos',
  plan: 'update_todos',
  todos: 'update_todos',
  todo_write: 'update_todos',
  set_todos: 'update_todos',
  apply_diff: 'apply_patch',
  patch: 'apply_patch',
  install: 'install_package',
  uninstall: 'uninstall_package',
  status: 'git_status',
  commit: 'git_commit',
  push: 'git_push',
  pull: 'git_pull',
  download: 'download_file',
  upload: 'upload_file',
}

const POR_NOME = {
  code_interpreter: 'rodar',
  shell: 'terminal',
  terminal: 'terminal',
  read_file: 'arquivo',
  write_file: 'arquivoNovo',
  edit_file: 'lapis',
  str_replace_editor: 'lapis',
  list_dir: 'pasta',
  delete_file: 'lixeira',
  create_directory: 'pasta',
  delete_directory: 'lixeira',
  move_file: 'arquivo',
  copy_file: 'arquivoNovo',
  rename_file: 'lapis',
  get_environment: 'escudo',
  search_files: 'lupa',
  update_todos: 'plano',
  apply_patch: 'retalho',
  download_file: 'baixar',
  upload_file: 'enviar',
  read_attachment: 'arquivo',
  save_attachment: 'arquivoNovo',
  send_to_phone: 'enviar',
  install_package: 'pacote',
  uninstall_package: 'pacote',
  git_push: 'enviar',
  git_pull: 'baixar',
  search_codebase: 'lupa',
  vector_search: 'lupa',
  grep: 'regex',
  regex_search: 'regex',
  get_problems: 'escudo',
  linter: 'escudo',
  web_search: 'globo',
  url_reader: 'janela',
  browser: 'janela',
  git_status: 'ramo',
  git_diff: 'diff',
  git_log: 'historico',
  git_commit: 'commit',
  use_skill: 'quebraCabeca',
}

const ferramentaCanonica = (nome) => APELIDOS[nome] ?? nome
const eFerramentaMcp = (nome) => nome.startsWith('mcp__')
const ferramentaDoNomeMcp = (nome) =>
  nome.replace(/^mcp__/, '').split('__').slice(1).join('__') || nome
const rotuloFerramenta = (nome) => ROTULOS[ferramentaCanonica(nome)] ?? nome
const rotuloDoPasso = (passo) => {
  if (passo.mcp) return passo.mcp.ferramenta
  if (eFerramentaMcp(passo.name)) return ferramentaDoNomeMcp(passo.name)
  return rotuloFerramenta(passo.name)
}

const CHAVES_DE_CONTEUDO = new Set(['conteudo', 'old_string', 'new_string', 'diff'])

const caminhosDoDiff = (diff) =>
  diff
    .split('\n')
    .filter((linha) => linha.startsWith('+++ '))
    .map((linha) => linha.slice(4).trim().replace(/^[ab]\//, ''))
    .filter((caminho) => caminho && caminho !== '/dev/null')

const resumoArgumentos = (argumentos = {}, limite = 96) => {
  if (argumentos.continuar) return `acompanhando o comando ${argumentos.continuar}`
  if (argumentos.parar) return `parando o comando ${argumentos.parar}`

  let entradas = Object.entries(argumentos).filter(([chave]) => !CHAVES_DE_CONTEUDO.has(chave))
  if (entradas.length === 0 && typeof argumentos.diff === 'string') {
    const caminhos = caminhosDoDiff(argumentos.diff)
    entradas = caminhos.length ? [['arquivos', caminhos.join(', ')]] : []
  }

  const partes = entradas.map(([chave, valor]) => {
    const texto = typeof valor === 'string' ? valor : JSON.stringify(valor)
    const curto = (texto ?? '').replace(/\s+/g, ' ').slice(0, 44)
    return `${chave}: ${curto}${(texto ?? '').length > 44 ? '…' : ''}`
  })
  const resumo = partes.join(' · ')
  return resumo.length > limite ? `${resumo.slice(0, limite)}…` : resumo
}

const recursoDoPasso = (passo) => {
  if (passo.mcp) {
    const args = resumoArgumentos(passo.arguments)
    return args ? `MCP ${passo.mcp.servidor} · ${args}` : `MCP ${passo.mcp.servidor}`
  }
  if (ferramentaCanonica(passo.name) === 'use_skill') {
    const nome = String(passo.arguments?.nome ?? '').trim()
    return nome ? `skill ${nome}` : 'skill'
  }
  return resumoArgumentos(passo.arguments)
}

const iconeDaFerramenta = (nome) =>
  eFerramentaMcp(nome) ? 'conector' : (POR_NOME[ferramentaCanonica(nome)] ?? 'chave')

/** `940 ms` → `1,4 s` → `1,2 min`, como a `formatarDuracao` do PC. */
function formatarDuracao(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  const numero = (valor) =>
    valor.toLocaleString('pt-BR', {
      minimumFractionDigits: valor < 10 ? 1 : 0,
      maximumFractionDigits: valor < 10 ? 1 : 0,
    })
  if (ms < 1000) return `${Math.round(ms)} ms`
  const segundos = ms / 1000
  if (segundos < 60) return `${numero(segundos)} s`
  const minutos = segundos / 60
  if (minutos < 60) return `${numero(minutos)} min`
  const horas = minutos / 60
  if (horas < 24) return `${numero(horas)} h`
  return `${numero(horas / 24)} d`
}

/** `2,3 MB` — o tamanho do arquivo que o PC preparou para o celular. */
function formatarTamanhoDeArquivo(total) {
  const bytes = Number(total)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

function formatarCaracteres(total) {
  if (!Number.isFinite(total) || total < 0) return '0 caracteres'
  const numero = (valor) =>
    valor.toLocaleString('pt-BR', {
      minimumFractionDigits: valor < 10 ? 1 : 0,
      maximumFractionDigits: valor < 10 ? 1 : 0,
    })
  if (total < 1000) return `${Math.round(total)} caracteres`
  if (total < 1_000_000) return `${numero(total / 1000)} mil caracteres`
  return `${numero(total / 1_000_000)} mi caracteres`
}

/* ------------------------------------------------------------------------- */
/* Markdown mínimo para as respostas (negrito, código, listas, títulos)      */
/* ------------------------------------------------------------------------- */

function inlineMarkdown(texto) {
  const fragmento = document.createDocumentFragment()
  const padrao = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g
  let ultimo = 0
  for (const achado of texto.matchAll(padrao)) {
    if (achado.index > ultimo) {
      fragmento.append(document.createTextNode(texto.slice(ultimo, achado.index)))
    }
    const trecho = achado[0]
    if (trecho.startsWith('`')) {
      const codigo = document.createElement('code')
      codigo.textContent = trecho.slice(1, -1)
      fragmento.append(codigo)
    } else if (trecho.startsWith('**')) {
      const forte = document.createElement('strong')
      forte.textContent = trecho.slice(2, -2)
      fragmento.append(forte)
    } else {
      const enfase = document.createElement('em')
      enfase.textContent = trecho.slice(1, -1)
      fragmento.append(enfase)
    }
    ultimo = achado.index + trecho.length
  }
  if (ultimo < texto.length) fragmento.append(document.createTextNode(texto.slice(ultimo)))
  return fragmento
}

function renderizarMarkdown(texto, destino) {
  destino.replaceChildren()
  const linhas = texto.split('\n')
  let i = 0
  let lista = null

  const fecharLista = () => {
    if (lista) destino.append(lista)
    lista = null
  }

  while (i < linhas.length) {
    const linha = linhas[i]

    // A cerca pode vir colada no fim de uma frase ("Posso executar?```koda-visual"):
    // alguns modelos emendam o bloco sem quebrar a linha. O texto antes dela continua
    // sendo parágrafo; o bloco começa no ``` onde ele estiver.
    const cerca = linha.indexOf('```')
    if (cerca !== -1) {
      fecharLista()
      const antes = linha.slice(0, cerca).trim()
      if (antes) {
        const paragrafo = document.createElement('p')
        paragrafo.append(inlineMarkdown(antes))
        destino.append(paragrafo)
      }
      const idioma = linha.slice(cerca + 3).trim()
      const codigo = []
      i += 1
      while (i < linhas.length && !linhas[i].trimStart().startsWith('```')) {
        codigo.push(linhas[i])
        i += 1
      }
      // `fechou` separa bloco completo de bloco ainda chegando pelo stream. Sem isso,
      // o JSON pela metade aparecia como código e piscava na tela antes de virar desenho.
      const fechou = i < linhas.length
      if (fechou) i += 1
      const corpo = codigo.join('\n')

      if (ehBlocoVisual(idioma)) {
        if (!fechou) {
          // Bloco em construção: nada de JSON cru. O desenho entra quando a cerca fecha.
          const construindo = document.createElement('div')
          construindo.className = 'kb-construindo'
          construindo.textContent = 'desenhando…'
          destino.append(construindo)
          continue
        }
        destino.append(desenharBloco(idioma, corpo, { decidirPlano }))
        continue
      }

      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (idioma) code.dataset.idioma = idioma
      code.textContent = corpo
      pre.append(code)
      destino.append(pre)
      continue
    }

    const titulo = linha.match(/^(#{1,4})\s+(.*)$/)
    if (titulo) {
      fecharLista()
      const h = document.createElement('h3')
      h.textContent = titulo[2]
      destino.append(h)
      i += 1
      continue
    }

    const item = linha.match(/^\s*[-*+]\s+(.*)$/)
    if (item) {
      if (!lista) {
        lista = document.createElement('ul')
      }
      const li = document.createElement('li')
      li.append(inlineMarkdown(item[1]))
      lista.append(li)
      i += 1
      continue
    }

    const numerado = linha.match(/^\s*\d+[.)]\s+(.*)$/)
    if (numerado) {
      if (!lista || lista.tagName !== 'OL') {
        fecharLista()
        lista = document.createElement('ol')
      }
      const li = document.createElement('li')
      li.append(inlineMarkdown(numerado[1]))
      lista.append(li)
      i += 1
      continue
    }

    if (linha.startsWith('> ')) {
      fecharLista()
      const citacao = document.createElement('blockquote')
      citacao.append(inlineMarkdown(linha.slice(2)))
      destino.append(citacao)
      i += 1
      continue
    }

    if (/^\s*---+\s*$/.test(linha)) {
      fecharLista()
      destino.append(document.createElement('hr'))
      i += 1
      continue
    }

    if (linha.trim() === '') {
      fecharLista()
      i += 1
      continue
    }

    fecharLista()
    const paragrafo = document.createElement('p')
    paragrafo.append(inlineMarkdown(linha))
    destino.append(paragrafo)
    i += 1
  }

  fecharLista()
}

/* ------------------------------------------------------------------------- */
/* Opções dos menus                                                          */
/* ------------------------------------------------------------------------- */

const ESFORCOS = [
  { id: 'auto', nome: 'Automático', dica: 'Quem decide é o Reasoning' },
  { id: 'minimal', nome: 'Mínimo', dica: 'Responde rápido, pensa pouco' },
  { id: 'low', nome: 'Baixo', dica: 'Pensa um pouco mais antes de responder' },
  { id: 'medium', nome: 'Médio', dica: 'Equilíbrio entre tempo e profundidade' },
  { id: 'high', nome: 'Alto', dica: 'Pensa mais — a resposta demora mais' },
  { id: 'xhigh', nome: 'Muito alto', dica: 'Pensa muito — a resposta demora bem mais' },
  { id: 'max', nome: 'Máximo', dica: 'O máximo que o modelo permite' },
]

const PERMISSOES = [
  {
    id: 'plan',
    curto: 'Plan',
    nome: 'Plan — planejar antes de fazer',
    dica: 'Divide o pedido em itens e mostra o plano para você aprovar; não mexe em nada até você mandar seguir',
    icone: 'clipboard',
    cor: 'cor-sky',
  },
  {
    id: 'manual',
    curto: 'Manual',
    nome: 'Perguntar sempre',
    dica: 'Pede antes de rodar comando, escrever, apagar ou sair da pasta',
    icone: 'hand',
    cor: 'cor-emerald',
  },
  {
    id: 'default',
    curto: 'Padrão',
    nome: 'Padrão',
    dica: 'Trabalha no projeto e pede aprovação para comandos e ações importantes',
    icone: 'escudo',
    cor: 'cor-amber',
  },
  {
    id: 'auto',
    curto: 'Automático',
    nome: 'Auto',
    dica: 'Executa comandos com acesso da sua conta ao computador; o limite ao projeto vale para as ferramentas de arquivo',
    icone: 'escudoAlerta',
    cor: 'cor-red',
  },
  {
    id: 'livre',
    curto: 'Livre',
    nome: 'Livre — arquivos no computador inteiro',
    dica: 'Executa comandos e acessa arquivos no computador com as permissões da sua conta; sem pedir aprovação',
    icone: 'cadeadoAberto',
    cor: 'cor-red-forte',
  },
]

/* O catálogo real chega do backend; este é o ponto de partida até ele responder. */
let MODELOS = [
  {
    grupo: 'OpenAI Codex',
    provedorId: 'openai',
    apelido: 'OpenAI',
    sigla: 'OP',
    conectado: true,
    itens: [
      {
        id: 'provedor:openai:gpt-6-luna',
        nome: 'GPT-6-Luna',
        provedorId: 'openai',
        provedorNome: 'OpenAI Codex',
        apelido: 'OpenAI',
        sigla: 'OP',
      },
    ],
  },
]

/** Todos os provedores que o PC conhece, conectados ou não (a tela de configuração usa). */
let PROVEDORES = []
let PROJETOS = []

const PREFERENCIAS = 'koda-mobile:prefs'
const ULTIMA_CONVERSA = 'koda-mobile:ultima-conversa'
const CACHE_CONVERSAS = 'koda-mobile:cache:conversas'
const CACHE_CONVERSA = 'koda-mobile:cache:conversa:'
const CACHE_MODELOS = 'koda-mobile:cache:modelos'
const CACHE_LIMITE = 8

const estado = {
  modelo: 'provedor:openai:gpt-6-luna',
  esforco: 'auto',
  permissao: 'default',
  projeto: 'sem-projeto',
  projetoCaminho: null,
  reasoning: true,
  web: false,
  anexos: [],
}

/* O que a pessoa escolheu no celular fica neste aparelho; o projeto também vai para o PC. */
function lerJson(chave, padrao) {
  try {
    const bruto = localStorage.getItem(chave)
    return bruto ? JSON.parse(bruto) : padrao
  } catch {
    return padrao
  }
}

function salvarJson(chave, valor) {
  try {
    localStorage.setItem(chave, JSON.stringify(valor))
  } catch {
    /* memória cheia ou modo privado: a tela continua funcionando */
  }
}

function salvarPreferencias() {
  salvarJson(PREFERENCIAS, {
    modelo: estado.modelo,
    esforco: estado.esforco,
    projeto: estado.projeto,
    projetoCaminho: estado.projetoCaminho,
    reasoning: estado.reasoning,
    web: estado.web,
  })
}

const guardadas = lerJson(PREFERENCIAS, null)
if (guardadas && typeof guardadas === 'object') {
  for (const chave of ['modelo', 'esforco', 'projeto', 'projetoCaminho', 'reasoning', 'web']) {
    if (guardadas[chave] !== undefined && guardadas[chave] !== null) estado[chave] = guardadas[chave]
  }
}

/*
 * O catálogo de modelos é grande e o PC demora para listar todos os provedores.
 * A cópia local pinta o modelo escolhido já no primeiro quadro; a lista de verdade
 * substitui esta assim que chega.
 */
const catalogoGuardado = lerJson(CACHE_MODELOS, null)
if (catalogoGuardado && Array.isArray(catalogoGuardado.modelos) && catalogoGuardado.modelos.length > 0) {
  MODELOS = catalogoGuardado.modelos
  if (Array.isArray(catalogoGuardado.provedores)) PROVEDORES = catalogoGuardado.provedores
}

/* Nome curto do provedor para o chip e para o seletor — «OP» sozinho não diz nada. */
const APELIDOS_DE_PROVEDOR = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  'gemini-cli': 'Gemini',
  github: 'GitHub',
  gitlab: 'GitLab',
  glm: 'GLM',
  kimi: 'Kimi',
  xai: 'xAI',
  cline: 'Cline',
  clinepass: 'ClinePass',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed',
  qoder: 'Qoder',
  'qoder-cn': 'Qoder CN',
  trae: 'Trae',
  kiro: 'Kiro',
  kilocode: 'Kilo',
  iflow: 'iFlow',
  nous: 'Nous',
  accio: 'Accio',
  'grok-cli': 'Grok',
  'codebuddy-intl': 'CodeBuddy',
  'codebuddy-cn': 'CodeBuddy CN',
  'minimax-code': 'MiniMax',
  'minimax-code-global': 'MiniMax Global',
  antigravity: 'Antigravity',
  muse: 'Muse',
  kimchi: 'Kimchi',
  'xiaomi-mimo': 'MiMo',
}

function apelidoDoProvedor(provedor) {
  return (
    APELIDOS_DE_PROVEDOR[provedor?.id] ??
    String(provedor?.nome ?? '').split(' ')[0] ??
    ''
  )
}

/*
 * As mesmas marcas que o seletor do PC usa (`src/logos-provedores.ts`). Ficam
 * em `mobile/provedores/` para o celular não depender do servidor do Vite nem
 * de rede: o APK leva os arquivos junto.
 */
const LOGO_DO_PROVEDOR = {
  anthropic: 'provedores/anthropic.svg',
  openai: 'provedores/openai.svg',
  google: 'provedores/google.svg',
  github: 'provedores/github.svg',
  xai: 'provedores/xai.svg',
  cursor: 'provedores/cursor.svg',
  devin: 'provedores/devin.svg',
  qoder: 'provedores/qoder.svg',
  kiro: 'provedores/kiro.svg',
  factory: 'provedores/factory.svg',
  zcode: 'provedores/zcode.png',
  xiaomi: 'provedores/xiaomi.svg',
  'xiaomi-mimo': 'provedores/xiaomi.svg',
  antigravity: 'provedores/google.svg',
  cline: 'provedores/cline.svg',
  clinepass: 'provedores/cline.svg',
  'codebuddy-intl': 'provedores/codebuddy.svg',
  'codebuddy-cn': 'provedores/codebuddy.svg',
  'gemini-cli': 'provedores/gemini.svg',
  gitlab: 'provedores/gitlab.svg',
  'grok-cli': 'provedores/xai.svg',
  iflow: 'provedores/iflow.svg',
  kilocode: 'provedores/kilocode.svg',
  kimchi: 'provedores/kimchi.svg',
  kimi: 'provedores/kimi.svg',
  'minimax-code': 'provedores/minimax.svg',
  'minimax-code-global': 'provedores/minimax.svg',
  muse: 'provedores/muse.svg',
  nous: 'provedores/nous.svg',
  'qoder-cn': 'provedores/qoder.svg',
  trae: 'provedores/trae.svg',
  windsurf: 'provedores/windsurf.svg',
  glm: 'provedores/zcode.png',
  zed: 'provedores/zed.svg',
  accio: 'provedores/accio.svg',
}

const logoDoProvedor = (id) => LOGO_DO_PROVEDOR[id] ?? ''

let conversaId = null
let conversas = []
let conversasDoCache = false
/** Cada carga do histórico ganha um número; resposta velha não pisa numa lista nova. */
let historicoVersao = 0
let ocupado = false
let controlador = null

/* ------------------------------------------------------------------------- */
/* Elementos                                                                 */
/* ------------------------------------------------------------------------- */

const caixa = document.querySelector('#caixa')
const campo = document.querySelector('#mensagem')
const menu = document.querySelector('#menu')
const enviar = document.querySelector('.caixa__enviar')
const anexos = document.querySelector('#anexos')
const conversa = document.querySelector('#conversa')
const listaMensagens = document.querySelector('#mensagens')
const compositor = document.querySelector('.compositor')
const pedido = document.querySelector('#pedido')

const rotuloModelo = document.querySelector('#rotulo-modelo')
const gatilhoEsforco = document.querySelector('.chip--esforco')
const rotuloEsforco = document.querySelector('#rotulo-esforco')
const gatilhoPermissao = document.querySelector('.chip--permissao')
const rotuloPermissao = document.querySelector('#rotulo-permissao')
const iconePermissao = document.querySelector('#icone-permissao')
const rotuloProjeto = document.querySelector('#rotulo-projeto')

const arquivoImagem = document.querySelector('#arquivo-imagem')
const arquivo = document.querySelector('#arquivo')

const rotuloProvedor = document.querySelector('#rotulo-provedor')

const telaHistorico = document.querySelector('#tela-historico')
const telaConfig = document.querySelector('#tela-config')
const telaPastas = document.querySelector('#tela-pastas')
const telaNavegador = document.querySelector('#tela-navegador')
const folha = document.querySelector('#folha')
const folhaTitulo = document.querySelector('#folha-titulo')
const folhaCorpo = document.querySelector('#folha-corpo')
const folhaVoltar = document.querySelector('#folha-voltar')
const historicoLista = document.querySelector('#historico-lista')
const historicoBusca = document.querySelector('#historico-busca')
const historicoAviso = document.querySelector('#historico-aviso')
const historicoEstado = document.querySelector('#historico-estado')
const configCorpo = document.querySelector('#config-corpo')
const pastasLista = document.querySelector('#pastas-lista')
const pastasAtalhos = document.querySelector('#pastas-atalhos')
const pastasCaminho = document.querySelector('#pastas-caminho')
const pastasUsar = document.querySelector('#pastas-usar')

let menuAberto = null

/* ------------------------------------------------------------------------- */
/* Estado na tela                                                            */
/* ------------------------------------------------------------------------- */

const todosOsModelos = () => MODELOS.flatMap((grupo) => grupo.itens)
const modeloAtual = () => todosOsModelos().find((item) => item.id === estado.modelo)
const projetoAtual = () => PROJETOS.find((item) => item.id === estado.projeto)

function atualizarGatilhos() {
  const modelo = modeloAtual()
  rotuloModelo.textContent = modelo?.nome ?? 'Carregando modelos…'
  // O nome do modelo sozinho não diz de quem ele é; o selo ao lado diz.
  if (rotuloProvedor) {
    rotuloProvedor.textContent = modelo?.apelido ?? ''
    rotuloProvedor.hidden = !modelo?.apelido
  }

  const esforco = ESFORCOS.find((item) => item.id === estado.esforco) ?? ESFORCOS[0]
  rotuloEsforco.textContent = esforco.nome
  // Como no PC: no celular o rótulo só aparece quando o esforço não é o padrão.
  rotuloEsforco.hidden = estado.esforco === 'auto'
  gatilhoEsforco.classList.toggle('fora-do-padrao', estado.esforco !== 'auto')
  gatilhoEsforco.setAttribute(
    'aria-label',
    `Esforço de raciocínio (${esforco.nome.toLowerCase()})`,
  )

  const permissao = PERMISSOES.find((item) => item.id === estado.permissao) ?? PERMISSOES[2]
  rotuloPermissao.textContent = permissao.curto
  iconePermissao.className = `icone ${permissao.cor}`
  iconePermissao.innerHTML = traco(permissao.icone, 15)
  gatilhoPermissao.setAttribute('aria-label', `Permissão: ${permissao.curto}`)
  gatilhoPermissao.title = `Permissão: ${permissao.curto}`

  rotuloProjeto.textContent = projetoAtual()?.nome ?? 'Sem projeto'
}

function atualizarEnviar() {
  if (ocupado) {
    enviar.disabled = false
    return
  }
  enviar.disabled = campo.value.trim() === '' && estado.anexos.length === 0
}

function renderizarAnexos() {
  anexos.innerHTML = ''
  estado.anexos.forEach((anexo, indice) => {
    const chip = document.createElement('span')
    chip.className = 'anexo'

    const nome = document.createElement('span')
    nome.className = 'anexo__nome'
    nome.textContent = anexo.enviando ? `${anexo.nome} — enviando…` : anexo.nome
    if (anexo.erro) nome.textContent = `${anexo.nome} — falhou`

    const remover = document.createElement('button')
    remover.type = 'button'
    remover.className = 'anexo__remover'
    remover.dataset.indice = String(indice)
    remover.setAttribute('aria-label', `Remover ${anexo.nome}`)
    remover.innerHTML = traco('x', 12)

    chip.append(nome, remover)
    anexos.append(chip)
  })
  anexos.hidden = estado.anexos.length === 0
}

/* ------------------------------------------------------------------------- */
/* Carregar o que é real                                                     */
/* ------------------------------------------------------------------------- */

const FAMILIAS_DO_HOST = [
  { chave: 'glm', nome: 'GLM' },
  { chave: 'qwen', nome: 'Qwen' },
]

let catalogoEm = 0

function familiaDoModelo(id) {
  const curto = String(id ?? '').split('/').pop() ?? ''
  return FAMILIAS_DO_HOST.find((familia) => curto.startsWith(`${familia.chave}-`))?.chave ?? 'outros'
}

/** Os modelos do próprio Koda (GLM, Qwen), como as famílias do topo do PC. */
function agruparModelosDoHost(lista) {
  const grupos = new Map()
  for (const item of lista) {
    const valor = typeof item === 'string' ? item : item?.value
    if (!valor) continue
    const chave = familiaDoModelo(valor)
    const nome = FAMILIAS_DO_HOST.find((familia) => familia.chave === chave)?.nome ?? 'Outros'
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        tipo: 'host',
        chave,
        grupo: nome,
        apelido: 'Koda',
        sigla: nome,
        logo: '',
        itens: [],
      })
    }
    grupos.get(chave).itens.push({
      id: valor,
      nome: (typeof item === 'object' && (item.label ?? item.nome)) || valor,
      apelido: 'Koda',
      host: true,
    })
  }
  const ordem = [...FAMILIAS_DO_HOST.map((familia) => familia.chave), 'outros']
  return [...grupos.values()].sort((a, b) => ordem.indexOf(a.chave) - ordem.indexOf(b.chave))
}

/** Roda as tarefas com no máximo `limite` em andamento. */
async function emLotes(itens, limite, tarefa) {
  const resultados = new Array(itens.length)
  let proximo = 0
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (true) {
      const indice = proximo
      proximo += 1
      if (indice >= itens.length) return
      resultados[indice] = await tarefa(itens[indice], indice)
    }
  })
  await Promise.all(trabalhadores)
  return resultados
}

/*
 * O link recusa quando há mais de 4 pedidos vivos na sala. O celular disparava
 * os 18 provedores de uma vez: só os 4 primeiros voltavam, e o seletor mostrava
 * um terço da conta. Duas vagas por vez + uma nova tentativa resolvem sem
 * encostar no freio do PC.
 */
async function modelosDoProvedor(id) {
  let ultimoErro = null
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    try {
      return await api(`/api/provedores/${encodeURIComponent(id)}/modelos`)
    } catch (erro) {
      ultimoErro = erro
      await new Promise((resolver) => setTimeout(resolver, 300 * (tentativa + 1)))
    }
  }
  throw ultimoErro
}

async function carregarModelos() {
  try {
    const [provedores, host] = await Promise.all([
      api('/api/provedores'),
      api('/api/models').catch(() => []),
    ])
    PROVEDORES = Array.isArray(provedores) ? provedores : []
    const gruposDoHost = agruparModelosDoHost(Array.isArray(host) ? host : [])
    // O PC mostra todo provedor conectado, inclusive os que não são de chat
    // (Kiro AI, por exemplo). Filtrar por `capacidades.chat` sumia com eles.
    const conectados = PROVEDORES.filter((item) => item.conectado)
    const anteriores = new Map(
      MODELOS.filter((grupo) => tipoDoGrupo(grupo) === 'provedor').map((grupo) => [
        grupo.provedorId,
        grupo,
      ]),
    )
    // A lista de provedores já basta para pintar o seletor: cada linha aparece com o
    // nome, a logo e «lendo modelos…». Antes a folha ficava vazia até o último dos 17
    // provedores responder — a espera de 5 a 10 segundos que a pessoa via.
    const grupos = conectados.map((provedor) => {
      const antigo = anteriores.get(provedor.id)
      return {
        tipo: 'provedor',
        grupo: provedor.nome,
        provedorId: provedor.id,
        apelido: provedor.nome,
        sigla: provedor.sigla ?? '',
        logo: logoDoProvedor(provedor.id),
        conectado: true,
        itens: antigo?.itens ?? [],
        carregando: !antigo,
      }
    })
    MODELOS = [...gruposDoHost, ...grupos]
    catalogoEm = Date.now()
    atualizarGatilhos()
    atualizarFolhaDeModelos()

    // O catálogo de cada provedor chega em segundo plano, dois por vez (o link recusa
    // rajadas). Cada resposta atualiza a folha aberta na hora.
    await emLotes(conectados, 2, async (provedor) => {
      const grupo = MODELOS.find(
        (item) => tipoDoGrupo(item) === 'provedor' && item.provedorId === provedor.id,
      )
      if (!grupo) return
      try {
        const dados = await modelosDoProvedor(provedor.id)
        grupo.itens = (dados.modelos ?? []).map((id) => ({
          id: `provedor:${provedor.id}:${id}`,
          nome: dados.nomes?.[id] ?? id,
          provedorId: provedor.id,
          provedorNome: provedor.nome,
          apelido: provedor.nome,
          sigla: provedor.sigla ?? '',
          logo: grupo.logo,
          multiplo: dados.multiplos?.[id],
        }))
      } catch {
        // Falha passageira: mantém o que já estava no cache em vez de sumir com o
        // provedor da lista até a próxima atualização.
      }
      grupo.carregando = false
      atualizarFolhaDeModelos()
    })

    MODELOS = MODELOS.filter(
      (grupo) => tipoDoGrupo(grupo) === 'host' || grupo.itens.length > 0,
    )
    if (MODELOS.length > 0) {
      salvarJson(CACHE_MODELOS, { em: catalogoEm, modelos: MODELOS, provedores: PROVEDORES })
      // Mantém o modelo salvo quando ele ainda existe; senão cai no GPT Luna ou no
      // primeiro modelo real. Só depois de todos os provedores carregarem: antes, o
      // catálogo parcial não tinha o modelo escolhido e o trocava por um do host.
      if (!modeloAtual()) {
        const luna = todosOsModelos().find((item) => item.id === 'provedor:openai:gpt-6-luna')
        estado.modelo = luna?.id ?? todosOsModelos()[0].id
        salvarPreferencias()
      }
      atualizarGatilhos()
      atualizarFolhaDeModelos()
      if (menuAberto === 'modelo') abrirMenu('modelo', document.querySelector('[data-menu="modelo"]'))
      if (telaConfig && !telaConfig.hidden) renderizarConfig()
    }
  } catch {
    /* Backend fora do ar: o envio mostra o erro de verdade em vez de inventar resposta. */
  }
}

async function carregarPermissoes() {
  try {
    const dados = await api('/api/permissions')
    if (dados?.modo) {
      estado.permissao = dados.modo
      atualizarGatilhos()
    }
  } catch {
    /* mantém o padrão até o backend responder */
  }
}

/** O estado de projetos que o backend devolve vale para o PC e para o celular. */
function aplicarEstadoDeProjetos(dados) {
  if (!dados || !Array.isArray(dados.projetos)) return
  PROJETOS = dados.projetos.filter((item) => item.existe)
  const ativo = PROJETOS.find((item) => item.id === dados.ativo_id)
  estado.projeto = ativo?.id ?? 'sem-projeto'
  estado.projetoCaminho = ativo?.caminho ?? null
  salvarPreferencias()
  atualizarGatilhos()
  if (telaConfig && !telaConfig.hidden) renderizarConfig()
}

async function carregarProjetos() {
  try {
    const dados = await api('/api/projects')
    aplicarEstadoDeProjetos(dados)
  } catch {
    /* sem rede: continua com a pasta salva neste celular */
  }
}

/**
 * Escolher projeto é uma decisão dos dois lados: o celular guarda a escolha e o PC
 * passa a abrir a mesma pasta. Se o PC recusar, a tela volta para o que era antes.
 */
async function definirProjeto(valor) {
  const anterior = { projeto: estado.projeto, caminho: estado.projetoCaminho }
  if (valor === 'sem-projeto') {
    estado.projeto = 'sem-projeto'
    estado.projetoCaminho = null
  } else {
    const projeto = PROJETOS.find((item) => item.id === valor)
    if (!projeto) return
    estado.projeto = projeto.id
    estado.projetoCaminho = projeto.caminho
  }
  salvarPreferencias()
  atualizarGatilhos()
  try {
    const resposta = await abrirFluxo(
      valor === 'sem-projeto'
        ? '/api/projects/soltar'
        : `/api/projects/${encodeURIComponent(valor)}/ativo`,
      { method: 'POST', headers: cabecalhos() },
    )
    if (!resposta.ok) throw new Error(`o PC respondeu ${resposta.status}`)
    aplicarEstadoDeProjetos(await resposta.json())
  } catch {
    estado.projeto = anterior.projeto
    estado.projetoCaminho = anterior.caminho
    salvarPreferencias()
    atualizarGatilhos()
  }
}

async function definirPermissao(modo) {
  const anterior = estado.permissao
  estado.permissao = modo
  atualizarGatilhos()
  try {
    await api('/api/permissions', {
      method: 'PUT',
      body: JSON.stringify({ modo }),
    })
  } catch {
    estado.permissao = anterior
    atualizarGatilhos()
  }
}

/* ------------------------------------------------------------------------- */
/* Conversa                                                                  */
/* ------------------------------------------------------------------------- */

/** A bolha do que a pessoa escreveu — a mesma forma da bolha do PC. */
function criarBolha({ texto, anexos: anexosDaMensagem }) {
  const linha = document.createElement('div')
  linha.className = 'conversa__linha msg-in'

  const bolha = document.createElement('div')
  bolha.className = 'bolha'
  bolha.textContent = texto

  if (anexosDaMensagem.length > 0) {
    const lista = document.createElement('ul')
    lista.className = 'bolha__anexos'
    for (const anexo of anexosDaMensagem) {
      const item = document.createElement('li')
      item.textContent = anexo.nome
      lista.append(item)
    }
    bolha.append(lista)
  }

  linha.append(bolha)
  return linha
}

/** A fala do Koda: coroa à esquerda e texto (markdown) ao lado. */
function criarFalaDoKoda() {
  const linha = document.createElement('div')
  linha.className = 'fala__linha'

  const coroa = document.createElement('span')
  coroa.className = 'fala__coroa'
  coroa.innerHTML = COROA

  const fala = document.createElement('div')
  fala.className = 'fala'

  linha.append(coroa, fala)
  return { linha, fala }
}

/** A linha viva: coroa com brilho (ou arco girando) + o que está rodando + segundos. */
function criarLinhaTrabalhando() {
  const linha = document.createElement('div')
  linha.className = 'trabalhando'
  linha.innerHTML = `
    <span class="trabalhando__marca">${COROA_TRABALHANDO}</span>
    <span class="trabalhando__texto">Trabalhando…</span>
    <span class="trabalhando__meta"></span>`
  return linha
}

function textoDoTrabalho(linha, passo) {
  const texto = linha.querySelector('.trabalhando__texto')
  const marca = linha.querySelector('.trabalhando__marca')
  if (!passo) {
    marca.innerHTML = COROA_TRABALHANDO
    texto.textContent = 'Trabalhando…'
    return
  }
  marca.innerHTML = GIRADOR
  const rotulo = document.createElement('span')
  rotulo.className = 'trabalhando__rotulo'
  rotulo.textContent = rotuloDoPasso(passo)
  const recurso = document.createElement('span')
  recurso.className = 'trabalhando__recurso'
  recurso.textContent = resumoArgumentos(passo.arguments, 56)
  texto.replaceChildren('Rodando ', rotulo, ' ', recurso)
}

/** O bloco de raciocínio: aberto enquanto pensa, fechado quando a fala começa. */
function criarRaciocinio() {
  const bloco = document.createElement('details')
  bloco.className = 'bloco'
  bloco.open = true
  bloco.innerHTML = `
    <summary>
      <span class="bloco__icone">${GIRADOR}</span>
      <span class="bloco__titulo">Raciocínio</span>
      <span class="bloco__meta"><span class="bloco__estado">pensando</span>${CHEVRON}</span>
    </summary>
    <div class="bloco__corpo bloco__corpo--raciocinio"></div>`
  return bloco
}

function concluirRaciocinio(bloco, texto) {
  if (!bloco || !bloco.isConnected) return
  bloco.open = false
  bloco.querySelector('.bloco__icone').innerHTML = traco('cerebro', 14)
  bloco.querySelector('.bloco__estado').textContent = formatarCaracteres(texto.length)
}

/** O grupo de ferramentas, resumido numa linha que abre no clique — igual ao PC. */
function criarGrupoDeFerramentas() {
  const bloco = document.createElement('details')
  bloco.className = 'bloco ferramentas'
  bloco.innerHTML = `
    <summary>
      <span class="bloco__icone">${GIRADOR}</span>
      <span class="bloco__titulo">1 ferramenta</span>
      <span class="bloco__meta"><span class="bloco__estado">rodando</span>${CHEVRON}</span>
    </summary>
    <div class="bloco__corpo bloco__corpo--passos"></div>`
  return bloco
}

/** Uma chamada de ferramenta: linha seca + saída atrás do clique, como no PC. */
function criarPasso(data) {
  const passo = document.createElement('details')
  passo.className = 'passo'
  passo.dataset.id = data.id
  passo.innerHTML = `
    <summary>
      <span class="passo__icone">${GIRADOR}</span>
      <span class="passo__nome"></span>
      <span class="passo__recurso"></span>
      <span class="passo__meta"><span class="passo__estado">rodando</span>${CHEVRON}</span>
    </summary>
    <div class="passo__detalhe">
      <p class="passo__tecnico"></p>
      <p class="passo__mcp" hidden></p>
      <pre class="passo__saida"></pre>
    </div>`

  passo.querySelector('.passo__nome').textContent = rotuloDoPasso(data)
  passo.querySelector('.passo__recurso').textContent = recursoDoPasso(data)
  passo.querySelector('.passo__tecnico').textContent = data.name
  passo.querySelector('.passo__saida').textContent = 'sem saída'
  passo.title = `${data.name}(${resumoArgumentos(data.arguments)})`
  return passo
}

function concluirPasso(passo, data) {
  const icone = passo.querySelector('.passo__icone')
  icone.innerHTML = data.ok
    ? traco(iconeDaFerramenta(data.name), 14)
    : traco('alerta', 14)
  const estadoPasso = passo.querySelector('.passo__estado')
  estadoPasso.textContent = data.ok ? formatarDuracao(data.duration_ms) : 'falhou'
  passo.querySelector('.passo__saida').textContent = data.output || 'sem saída'

  if (data.mcp) {
    const mcp = passo.querySelector('.passo__mcp')
    mcp.hidden = false
    mcp.textContent = `servidor MCP ${data.mcp.servidor} · ferramenta ${data.mcp.ferramenta}`
  }
}

function atualizarResumoDoGrupo(grupo) {
  const passos = [...grupo.querySelectorAll('.passo')]
  const rodando = passos.some((item) => item.querySelector('.passo__estado')?.textContent === 'rodando')
  const total = passos.reduce((soma, item) => {
    const texto = item.querySelector('.passo__estado')?.textContent ?? ''
    const ms = texto.endsWith(' ms')
      ? Number(texto.replace(' ms', ''))
      : texto.endsWith(' s')
        ? Number(texto.replace(' s', '').replace(',', '.')) * 1000
        : 0
    return soma + ms
  }, 0)

  grupo.querySelector('.bloco__titulo').textContent =
    passos.length === 1 ? '1 ferramenta' : `${passos.length} ferramentas`
  grupo.querySelector('.bloco__icone').innerHTML = rodando ? GIRADOR : traco('chave', 14)
  grupo.querySelector('.bloco__estado').textContent = rodando
    ? 'rodando'
    : total > 0
      ? formatarDuracao(total)
      : ''
}

/**
 * O cartão de um arquivo que o PC preparou para o celular.
 *
 * O agente roda no PC; quando ele usa `send_to_phone`, o backend manda este evento
 * com um id aleatório. O botão baixa por `/api/transfer/<id>` (no link, o túnel
 * repassa para o PC) e, no APK, entrega os bytes ao Android para salvar em
 * Downloads/Koda — fora do APK, o navegador baixa como qualquer arquivo.
 */
const TRANSFERENCIAS_SALVAS = 'koda.mobile.transferencias.'
const TRANSFERENCIA_VALIDADE = 3600 * 1000

function criarCartaoDeTransferencia(dados) {
  const linha = document.createElement('div')
  linha.className = 'transferencia'
  linha.dataset.transferencia = dados.id
  linha.innerHTML = `
    <div class="transferencia__topo">
      <span class="transferencia__icone">${traco('arquivo', 18)}</span>
      <span class="transferencia__texto">
        <span class="transferencia__nome"></span>
        <span class="transferencia__meta"></span>
      </span>
    </div>
    <button type="button" class="transferencia__baixar">Salvar no celular</button>
    <p class="transferencia__estado" hidden></p>`
  linha.querySelector('.transferencia__nome').textContent = dados.nome ?? 'arquivo'
  const tamanho = formatarTamanhoDeArquivo(dados.tamanho)
  linha.querySelector('.transferencia__meta').textContent =
    tamanho ? `Arquivo do PC · ${tamanho}` : 'Arquivo do PC'
  const botao = linha.querySelector('.transferencia__baixar')
  botao.addEventListener('click', () => void baixarTransferencia(dados, linha, botao))
  return linha
}

/**
 * Os cartões ficam guardados neste celular por uma hora (a mesma validade do
 * arquivo no PC). Sem isso, recarregar a conversa apagava o botão de salvar,
 * porque o histórico do PC só guarda texto — o evento `transfer` é ao vivo.
 */
function lerTransferenciasSalvas(id) {
  if (!id) return []
  const lista = lerJson(TRANSFERENCIAS_SALVAS + id, [])
  if (!Array.isArray(lista)) return []
  const agora = Date.now()
  return lista.filter(
    (item) => item?.id && agora - Number(item.em ?? 0) < TRANSFERENCIA_VALIDADE,
  )
}

function guardarTransferenciaSalva(dados, depoisDe) {
  if (!conversaId) return
  const lista = lerTransferenciasSalvas(conversaId).filter((item) => item.id !== dados.id)
  lista.push({
    id: dados.id,
    nome: dados.nome ?? 'arquivo',
    tamanho: dados.tamanho ?? 0,
    mime: dados.mime ?? '',
    em: Date.now(),
    depoisDe,
  })
  salvarJson(TRANSFERENCIAS_SALVAS + conversaId, lista)
}

function mostrarTransferencia(dados) {
  if (!dados?.id) return
  const lista = document.getElementById('mensagens')
  if (!lista) return
  const linha = criarCartaoDeTransferencia(dados)
  const viva = lista.querySelector('.trabalhando')
  // Quantas mensagens já estão na conversa: é a âncora para o cartão voltar ao
  // mesmo lugar quando a conversa for redesenhada do histórico.
  const depoisDe = [...lista.children].filter(
    (filho) => !filho.classList.contains('transferencia'),
  ).length
  if (viva?.parentElement) viva.parentElement.insertBefore(linha, viva)
  else lista.append(linha)
  guardarTransferenciaSalva(dados, depoisDe)
  rolarParaOFim()
}

/** Devolve o filho que hoje ocupa a posição `n`, ignorando os próprios cartões. */
function filhoDaConversa(n) {
  let vistos = 0
  for (const filho of listaMensagens.children) {
    if (filho.classList.contains('transferencia')) continue
    if (vistos === n) return filho
    vistos += 1
  }
  return null
}

function desenharTransferenciasSalvas(id) {
  const salvas = lerTransferenciasSalvas(id).sort((a, b) => a.em - b.em)
  for (const dados of salvas) {
    listaMensagens.insertBefore(
      criarCartaoDeTransferencia(dados),
      filhoDaConversa(Number(dados.depoisDe ?? listaMensagens.children.length)),
    )
  }
}

function urlDaTransferencia(id) {
  // No link, o endereço é o do próprio túnel (ele repassa ao PC); na API direta, o
  // endereço configurado na entrada.
  const base = link ? location.origin : API
  return new URL(`/api/transfer/${encodeURIComponent(id)}`, base).href
}

function blobParaBase64(blob) {
  return new Promise((resolver, rejeitar) => {
    const leitor = new FileReader()
    leitor.onload = () => {
      const texto = String(leitor.result ?? '')
      resolver(texto.slice(texto.indexOf(',') + 1))
    }
    leitor.onerror = () => rejeitar(leitor.error ?? new Error('não consegui ler o arquivo'))
    leitor.readAsDataURL(blob)
  })
}

async function baixarTransferencia(dados, linha, botao) {
  const estado = linha.querySelector('.transferencia__estado')
  estado.hidden = true
  botao.disabled = true
  botao.textContent = 'Baixando…'
  try {
    const resposta = await fetch(urlDaTransferencia(dados.id), {
      headers: link ? {} : cabecalhos(false),
    })
    if (!resposta.ok) {
      throw new Error(
        resposta.status === 404
          ? 'esse arquivo expirou; peça de novo ao Koda'
          : `o PC respondeu ${resposta.status}`,
      )
    }
    const blob = await resposta.blob()
    if (window.KodaAndroid?.salvarArquivo) {
      const base64 = await blobParaBase64(blob)
      window.KodaAndroid.salvarArquivo(
        dados.id,
        dados.nome ?? 'arquivo',
        base64,
        dados.mime ?? blob.type ?? 'application/octet-stream',
      )
      botao.textContent = 'Salvando…'
      return
    }
    const endereco = URL.createObjectURL(blob)
    const ancora = document.createElement('a')
    ancora.href = endereco
    ancora.download = dados.nome ?? 'arquivo'
    ancora.rel = 'noopener'
    document.body.append(ancora)
    ancora.click()
    ancora.remove()
    setTimeout(() => URL.revokeObjectURL(endereco), 10000)
    botao.disabled = false
    botao.textContent = 'Baixar de novo'
  } catch (erro) {
    estado.hidden = false
    estado.textContent = erro instanceof Error ? erro.message : 'não consegui baixar'
    botao.disabled = false
    botao.textContent = 'Tentar de novo'
  }
}

/* O APK avisa quando terminou de gravar em Downloads/Koda. */
window.kodaArquivoSalvo = (id, ok, mensagem) => {
  const linha = document.querySelector(
    `.transferencia[data-transferencia="${CSS.escape(String(id))}"]`,
  )
  if (!linha) return
  const botao = linha.querySelector('.transferencia__baixar')
  const estado = linha.querySelector('.transferencia__estado')
  botao.disabled = Boolean(ok)
  botao.textContent = ok ? 'Salvo' : 'Tentar de novo'
  estado.hidden = false
  estado.textContent = mensagem ?? ''
}

/** O cartão de permissão, com os dados reais do backend. */
function mostrarPedido(dados) {
  pedido.innerHTML = ''
  pedido.hidden = false

  const risco = ['baixo', 'medio', 'alto'].includes(dados.risco) ? dados.risco : 'medio'
  const alto = risco === 'alto'
  const cartao = document.createElement('div')
  cartao.className = 'permissoes msg-in'
  cartao.innerHTML = `
    <div class="permissoes__topo">
      <span class="permissoes__icone${alto ? ' permissoes__icone--alto' : ''}">${traco(alto ? 'alerta' : 'escudoPergunta', 16)}</span>
      <div class="permissoes__conteudo">
        <div class="permissoes__cabeca">
          <span class="permissoes__titulo"></span>
          <span class="permissoes__risco permissoes__risco--${risco}"></span>
        </div>
        <p class="permissoes__explicacao"></p>
      </div>
    </div>
    ${dados.resumo ? '<div class="permissoes__resumo"></div>' : ''}
    <div class="permissoes__acoes">
      <button type="button" class="botao botao--primario" data-decisao="sim">Sim</button>
      <button type="button" class="botao" data-decisao="sempre">Sempre permitir</button>
      <button type="button" class="botao botao--neutro" data-decisao="nao">Não</button>
      <button type="button" class="botao botao--perigo" data-decisao="nunca">Nunca permitir</button>
    </div>
    <p class="permissoes__dica"></p>`

  cartao.querySelector('.permissoes__titulo').textContent = dados.titulo ?? 'Permissão'
  cartao.querySelector('.permissoes__risco').textContent = `risco ${risco === 'medio' ? 'médio' : risco}`
  cartao.querySelector('.permissoes__explicacao').textContent = dados.explicacao ?? ''
  const resumo = cartao.querySelector('.permissoes__resumo')
  if (resumo) resumo.textContent = dados.resumo
  cartao.querySelector('.permissoes__dica').textContent = dados.lembrar
    ? `«Sempre» e «nunca» lembram para ${dados.lembrar}.`
    : '«Sempre» e «nunca» lembram para este comando.'

  cartao.querySelectorAll('[data-decisao]').forEach((botao) => {
    botao.addEventListener('click', async () => {
      const decisao = botao.dataset.decisao
      cartao.querySelectorAll('[data-decisao]').forEach((item) => {
        item.disabled = true
      })
      const acoes = cartao.querySelector('.permissoes__acoes')
      acoes.classList.add('permissoes__acoes--respondendo')
      acoes.innerHTML = `<span class="permissoes__respondendo">${GIRADOR}Respondendo…</span>`
      cartao.querySelector('.permissoes__dica')?.remove()

      try {
        await api('/api/chat/approval', {
          method: 'POST',
          body: JSON.stringify({ id: dados.id, decisao }),
        })
        pedido.hidden = true
        pedido.innerHTML = ''
      } catch (erro) {
        acoes.classList.remove('permissoes__acoes--respondendo')
        acoes.innerHTML = `<span class="permissoes__respondendo">${traco('alerta', 14)}${erro.message}</span>`
      }
    })
  })

  pedido.append(cartao)
  medirCompositor()
}

/* ------------------------------------------------------------------------- */
/* Rodada real                                                               */
/* ------------------------------------------------------------------------- */

/**
 * A conversa termina onde o compositor começa. O compositor cresce quando o
 * texto ocupa mais linhas, quando entra um anexo ou quando o cartão de
 * permissão aparece, então a altura é medida — e não fixada no CSS.
 */
function medirCompositor() {
  document.documentElement.style.setProperty(
    '--compositor-altura',
    `${compositor.offsetHeight}px`,
  )
}

function rolarParaOFim() {
  requestAnimationFrame(() => {
    conversa.scrollTop = conversa.scrollHeight
  })
}

/**
 * Agrupa os desenhos do fluxo por quadro (`requestAnimationFrame`): a cada `delta`
 * o texto inteiro é re-parseado e re-desenhado (`renderizarMarkdown` começa do zero),
 * e num texto longo isso vira O(n²) — era o «travado» da resposta no celular. Com o
 * lote, deltas que chegam juntos custam um desenho só, e a rolagem acontece uma vez
 * por quadro em vez de uma por evento.
 *
 * Uso numa rodada: os deltas acumulam o texto e chamam `agendar()`; `fn` (o desenho)
 * roda imediatamente na primeira chegada (a resposta aparece na hora) e depois no
 * máximo uma vez por quadro enquanto outros deltas entram.
 */
function criarLote(fn) {
  let pendente = false
  const rodar = () => {
    pendente = false
    fn()
  }
  return {
    /** Roda `fn` agora; se já houver quadro marcado, deixa para ele. */
    agora: () => {
      if (pendente) return
      fn()
    },
    /** Marca `fn` para o próximo quadro, se ainda não estiver marcado. */
    agendar: () => {
      if (pendente) return
      pendente = true
      requestAnimationFrame(rodar)
    },
    /** Desfaz um quadro marcado (fim da rodada, troca de bloco). */
    cancelar: () => {
      pendente = false
    },
  }
}

/**
 * Consome o `text/event-stream` do backend, do mesmo jeito que o cliente do PC:
 * blocos separados por linha vazia, `event:` e `data:` em JSON.
 */
async function lerFluxo(resposta, aoEvento) {
  const leitor = resposta.body.getReader()
  const decodificador = new TextDecoder()
  let buffer = ''

  const despachar = (bloco) => {
    let evento = 'message'
    let dados = ''
    for (const linha of bloco.split('\n')) {
      if (linha.startsWith('event:')) evento = linha.slice(6).trim()
      else if (linha.startsWith('data:')) dados += linha.slice(5).trim()
    }
    if (!dados) return
    try {
      aoEvento(evento, JSON.parse(dados))
    } catch {
      /* JSON inválido: ignora, como o cliente do PC */
    }
  }

  while (true) {
    const { value, done } = await leitor.read()
    if (done) break
    buffer += decodificador.decode(value, { stream: true })
    const blocos = buffer.split('\n\n')
    buffer = blocos.pop() ?? ''
    blocos.forEach(despachar)
  }
  if (buffer.trim()) despachar(buffer)
}

/**
 * A rodada de verdade: envia para `/api/chat` e desenha o que o backend mandar.
 *
 * Cada evento tem um lugar certo na conversa, na mesma ordem do PC: raciocínio,
 * ferramentas, fala — e a linha viva sempre no fim.
 */
async function rodar(mensagem, idsDosAnexos, extra = {}) {
  const coluna = document.createElement('div')
  coluna.className = 'resposta msg-in'
  listaMensagens.append(coluna)

  const trabalhando = criarLinhaTrabalhando()
  coluna.append(trabalhando)

  let raciocinio = null
  let textoDoRaciocinio = ''
  let grupo = null
  let fala = null
  let textoDaFala = ''
  let recebeuTerminal = false
  let interrompido = false

  // A fala em construção é redesenhada por lote (ver `criarLote`): os deltas só
  // acumulam, e o `renderizarMarkdown` (caro, refaz tudo) roda uma vez por quadro.
  let loteFala = null
  const redesenharFala = () => {
    if (!fala) return
    renderizarMarkdown(textoDaFala, fala)
    if (/\[(?:erro do provedor|o provedor caiu)/i.test(textoDaFala)) {
      fala.classList.add('fala--erro')
    }
    rolarParaOFim()
  }
  const agendarFala = () => {
    if (!loteFala) loteFala = criarLote(redesenharFala)
    loteFala.agendar()
  }
  const agoraFala = () => {
    if (!loteFala) loteFala = criarLote(redesenharFala)
    loteFala.agora()
  }

  const inicio = Date.now()
  const relogio = window.setInterval(() => {
    const meta = trabalhando.querySelector('.trabalhando__meta')
    if (meta && trabalhando.isConnected) meta.textContent = formatarDuracao(Date.now() - inicio)
  }, 1000)

  const pararRelogio = () => window.clearInterval(relogio)

  const inserirBloco = (elemento) => {
    // A linha viva sai no `finally`; depois disso o lugar de qualquer bloco novo é o
    // fim da coluna — `insertBefore` num nó já removido derrubava a rodada.
    if (trabalhando.isConnected) coluna.insertBefore(elemento, trabalhando)
    else coluna.append(elemento)
    rolarParaOFim()
  }

  const fecharRaciocinio = () => {
    if (raciocinio) {
      concluirRaciocinio(raciocinio, textoDoRaciocinio)
      raciocinio = null
    }
  }

  const fecharFala = () => {
    fala = null
    textoDaFala = ''
  }

  const fecharGrupo = () => {
    if (grupo) atualizarResumoDoGrupo(grupo)
    grupo = null
  }

  controlador = new AbortController()

  try {
    const corpoDoPedido = {
      text: mensagem.texto,
      model: estado.modelo,
      reasoning: estado.reasoning,
      effort: estado.esforco,
      web: estado.web,
      project_path: estado.projetoCaminho,
      attachments: idsDosAnexos,
      conversation_id: conversaId,
      // O modo ao vivo usa isto para dizer no PC que quem trabalha é o celular.
      origem: 'celular',
      tz_offset_minutes: new Date().getTimezoneOffset(),
      ...extra,
    }
    const enviar = () =>
      abrirFluxo('/api/chat', {
        method: 'POST',
        headers: cabecalhos(),
        signal: controlador.signal,
        body: JSON.stringify(corpoDoPedido),
      })

    let resposta = await enviar()
    if (resposta.status === 404 && conversaId) {
      // A conversa restaurada do cache foi apagada no PC (ou nunca chegou lá).
      // Continuar mandando o id antigo travava o envio para sempre; começa uma
      // conversa nova e a lista do PC ganha essa também.
      conversaId = null
      try {
        localStorage.removeItem(ULTIMA_CONVERSA)
      } catch {
        /* nada guardado */
      }
      corpoDoPedido.conversation_id = null
      resposta = await enviar()
    }

    if (!resposta.ok || !resposta.body) {
      let detalhe = ''
      try {
        const corpo = await resposta.json()
        detalhe = corpo?.detail ?? corpo?.message ?? ''
      } catch {
        /* corpo vazio */
      }
      throw new Error(detalhe || `o backend respondeu ${resposta.status}`)
    }

    await lerFluxo(resposta, (evento, dados) => {
      if (evento === 'start') {
        conversaId = dados.conversation_id
        // A conversa fica marcada como a última também neste celular: fechar o app
        // e voltar cai nela de novo, como no PC.
        salvarJson(ULTIMA_CONVERSA, conversaId)
        return
      }

      if (evento === 'reasoning') {
        textoDoRaciocinio += dados.text ?? ''
        if (!raciocinio) {
          raciocinio = criarRaciocinio()
          inserirBloco(raciocinio)
        }
        const corpo = raciocinio.querySelector('.bloco__corpo')
        corpo.textContent = textoDoRaciocinio
        corpo.scrollTop = corpo.scrollHeight
        rolarParaOFim()
        return
      }

      if (evento === 'delta') {
        fecharRaciocinio()
        if (!fala) {
          const criada = criarFalaDoKoda()
          fala = criada.fala
          inserirBloco(criada.linha)
          // O primeiro desenho sai na hora (a resposta não espera o quadro).
          agoraFala()
        }
        textoDaFala += dados.text ?? ''
        agendarFala()
        return
      }

      // A interface inteligente chega ao vivo pelo evento `ui` — o mesmo documento que
      // fica gravado na conversa como cerca `koda-ui-doc`.
      if (evento === 'ui') {
        fecharRaciocinio()
        fecharFala()
        loteFala?.cancelar()
        if (!dados?.documento) return
        const { linha, fala: novaFala } = criarFalaDoKoda()
        novaFala.append(desenharInterface(JSON.stringify(dados.documento)))
        inserirBloco(linha)
        rolarParaOFim()
        return
      }

      if (evento === 'tool_call') {
        fecharRaciocinio()
        fecharFala()
        loteFala?.cancelar()
        if (!grupo) {
          grupo = criarGrupoDeFerramentas()
          inserirBloco(grupo)
        }
        const passo = criarPasso(dados)
        grupo.querySelector('.bloco__corpo').append(passo)
        textoDoTrabalho(trabalhando, dados)
        atualizarResumoDoGrupo(grupo)
        rolarParaOFim()
        return
      }

      if (evento === 'tool_result') {
        loteFala?.cancelar()
        let passo = grupo?.querySelector(`.passo[data-id="${CSS.escape(dados.id)}"]`)
        if (!passo) {
          if (!grupo) {
            grupo = criarGrupoDeFerramentas()
            inserirBloco(grupo)
          }
          passo = criarPasso(dados)
          grupo.querySelector('.bloco__corpo').append(passo)
        }
        concluirPasso(passo, dados)
        textoDoTrabalho(trabalhando, null)
        atualizarResumoDoGrupo(grupo)
        rolarParaOFim()
        return
      }

      if (evento === 'transfer') {
        mostrarTransferencia(dados)
        return
      }

      if (evento === 'approval_request') {
        textoDoTrabalho(trabalhando, null)
        mostrarPedido(dados)
        return
      }

      if (evento === 'aviso') {
        if (dados.tentativa != null) {
          const meta = trabalhando.querySelector('.trabalhando__texto')
          meta.textContent = `Reconectando… ${String(dados.tentativa).padStart(2, '0')}/${String(dados.total ?? 0).padStart(2, '0')}`
        }
        return
      }

      if (evento === 'done') {
        recebeuTerminal = true
        return
      }

      if (evento === 'error') {
        recebeuTerminal = true
        throw new Error(dados.message ?? 'erro no backend')
      }
    })
  } catch (erro) {
    interrompido = erro?.name === 'AbortError'
    if (interrompido) {
      const { linha, fala: falaErro } = criarFalaDoKoda()
      falaErro.textContent = 'Resposta interrompida.'
      falaErro.classList.add('fala--aviso')
      inserirBloco(linha)
    } else {
      const { linha, fala: falaErro } = criarFalaDoKoda()
      falaErro.textContent = `Não consegui falar com o backend: ${erro.message}`
      falaErro.classList.add('fala--erro')
      inserirBloco(linha)
    }
  } finally {
    // Desenho final da fala: qualquer quadro agendado que ainda não rodou não pode
    // perder o último pedaço do texto.
    loteFala?.cancelar()
    redesenharFala()
    fecharRaciocinio()
    // Ferramenta que ainda estava girando quando a resposta morreu não pode ficar
    // «rodando» para sempre: o passo passa a dizer que foi interrompido.
    for (const passo of coluna.querySelectorAll('.passo')) {
      const estadoPasso = passo.querySelector('.passo__estado')
      if (estadoPasso?.textContent === 'rodando') {
        estadoPasso.textContent = 'interrompido'
        passo.querySelector('.passo__icone').innerHTML = traco('alerta', 14)
      }
    }
    for (const bloco of coluna.querySelectorAll('.ferramentas')) {
      atualizarResumoDoGrupo(bloco)
    }
    fecharGrupo()
    pararRelogio()
    trabalhando.remove()
    controlador = null
    ocupado = false
    atualizarEnviar()
    rolarParaOFim()
  }

  if (!recebeuTerminal && !interrompido) {
    // O fluxo fechou sem `done`: a rodada não terminou, e a tela diz isso em vez de
    // fingir que a resposta acabou. Quem parou no botão já recebeu «Resposta
    // interrompida.» — não ganha uma segunda linha dizendo a mesma coisa.
    const { linha, fala: falaErro } = criarFalaDoKoda()
    falaErro.textContent = 'A conexão caiu antes do fim da resposta.'
    falaErro.classList.add('fala--aviso')
    inserirBloco(linha)
  }

  // Guarda a conversa no celular e atualiza a lista do histórico — sem segurar o
  // botão de enviar: a tela já pode receber a próxima mensagem.
  void sincronizarConversa()
}

/* ------------------------------------------------------------------------- */
/* Modo ao vivo                                                              */
/* ------------------------------------------------------------------------- */

let sessaoAcompanhada = null

/** Para a rodada de verdade no PC. Fechar a conexão não para mais o trabalho. */
async function pararRodadaNoPc() {
  if (!conversaId) return
  try {
    await abrirFluxo('/api/live/parar', {
      method: 'POST',
      headers: cabecalhos(),
      body: JSON.stringify({ conversa: conversaId }),
    })
  } catch {
    /* sem rede: o abort local ainda fecha a tela */
  }
}

/**
 * Desenha neste celular uma rodada que já está rodando no PC — a que o PC mandou,
 * ou a que continuou quando este app saiu de frente.
 */
async function acompanharAoVivo(conversa, desde = 0) {
  if (!conversa || ocupado) return
  if (conversaId !== conversa) {
    await abrirConversa(conversa)
    if (conversaId !== conversa) return
  }
  // Relê o histórico antes de desenhar a rodada: é por esta leitura que a mensagem
  // que o PC acabou de mandar aparece aqui, ao lado da resposta que está começando.
  try {
    const registro = await api(`/api/conversations/${encodeURIComponent(conversa)}`)
    if (registro?.id) desenharConversa(registro)
  } catch {
    /* sem rede: segue com o que já está na tela */
  }
  // O app voltou do segundo plano: a resposta parcial da conexão que morreu sai de
  // cena — o diário do backend vai redesenhá-la inteira.
  for (const antiga of listaMensagens.querySelectorAll('[data-ao-vivo="parcial"]')) {
    antiga.remove()
  }

  const coluna = document.createElement('div')
  coluna.className = 'resposta msg-in'
  coluna.dataset.aoVivo = 'parcial'
  listaMensagens.append(coluna)
  const trabalhando = criarLinhaTrabalhando()
  coluna.append(trabalhando)

  let raciocinio = null
  let textoDoRaciocinio = ''
  let grupo = null
  let fala = null
  let textoDaFala = ''
  let recebeuTerminal = false
  let interrompido = false

  // Mesmo lote da rodada direta: deltas acumulam, o desenho roda uma vez por quadro.
  let loteFala = null
  const redesenharFala = () => {
    if (!fala) return
    renderizarMarkdown(textoDaFala, fala)
    if (/\[(?:erro do provedor|o provedor caiu)/i.test(textoDaFala)) {
      fala.classList.add('fala--erro')
    }
    rolarParaOFim()
  }
  const agendarFala = () => {
    if (!loteFala) loteFala = criarLote(redesenharFala)
    loteFala.agendar()
  }
  const agoraFala = () => {
    if (!loteFala) loteFala = criarLote(redesenharFala)
    loteFala.agora()
  }
  const inicio = Date.now()
  const relogio = window.setInterval(() => {
    const meta = trabalhando.querySelector('.trabalhando__meta')
    if (meta && trabalhando.isConnected) {
      meta.textContent = formatarDuracao(Date.now() - inicio)
    }
  }, 1000)

  const inserirBloco = (elemento) => {
    if (trabalhando.isConnected) coluna.insertBefore(elemento, trabalhando)
    else coluna.append(elemento)
    rolarParaOFim()
  }
  const fecharRaciocinio = () => {
    if (raciocinio) {
      concluirRaciocinio(raciocinio, textoDoRaciocinio)
      raciocinio = null
    }
  }
  const fecharFala = () => {
    fala = null
    textoDaFala = ''
  }
  const fecharGrupo = () => {
    if (grupo) atualizarResumoDoGrupo(grupo)
    grupo = null
  }

  controlador = new AbortController()
  ocupado = true
  comecarRodada()
  try {
    const resposta = await abrirFluxo(
      `/api/live/${encodeURIComponent(conversa)}/eventos?desde=${Math.max(0, desde)}`,
      { headers: cabecalhos(), signal: controlador.signal },
    )
    if (!resposta.ok || !resposta.body) {
      throw new Error(
        resposta.status === 404
          ? 'a rodada terminou'
          : `o backend respondeu ${resposta.status}`,
      )
    }
    await lerFluxo(resposta, (evento, dados) => {
      if (evento === 'start') {
        conversaId = dados.conversation_id || conversaId
        salvarJson(ULTIMA_CONVERSA, conversaId)
        return
      }

      if (evento === 'reasoning') {
        textoDoRaciocinio += dados.text ?? ''
        if (!raciocinio) {
          raciocinio = criarRaciocinio()
          inserirBloco(raciocinio)
        }
        const corpo = raciocinio.querySelector('.bloco__corpo')
        corpo.textContent = textoDoRaciocinio
        corpo.scrollTop = corpo.scrollHeight
        rolarParaOFim()
        return
      }

      if (evento === 'delta') {
        fecharRaciocinio()
        if (!fala) {
          const criada = criarFalaDoKoda()
          fala = criada.fala
          inserirBloco(criada.linha)
          agoraFala()
        }
        textoDaFala += dados.text ?? ''
        agendarFala()
        return
      }

      // A interface chega pelo evento `ui` também na rodada acompanhada do PC.
      if (evento === 'ui') {
        fecharRaciocinio()
        fecharFala()
        loteFala?.cancelar()
        if (!dados?.documento) return
        const { linha, fala: novaFala } = criarFalaDoKoda()
        novaFala.append(desenharInterface(JSON.stringify(dados.documento)))
        inserirBloco(linha)
        rolarParaOFim()
        return
      }

      if (evento === 'tool_call') {
        fecharRaciocinio()
        fecharFala()
        loteFala?.cancelar()
        if (!grupo) {
          grupo = criarGrupoDeFerramentas()
          inserirBloco(grupo)
        }
        const passo = criarPasso(dados)
        grupo.querySelector('.bloco__corpo').append(passo)
        textoDoTrabalho(trabalhando, dados)
        atualizarResumoDoGrupo(grupo)
        rolarParaOFim()
        return
      }

      if (evento === 'tool_result') {
        loteFala?.cancelar()
        let passo = grupo?.querySelector(`.passo[data-id="${CSS.escape(dados.id)}"]`)
        if (!passo) {
          if (!grupo) {
            grupo = criarGrupoDeFerramentas()
            inserirBloco(grupo)
          }
          passo = criarPasso(dados)
          grupo.querySelector('.bloco__corpo').append(passo)
        }
        concluirPasso(passo, dados)
        textoDoTrabalho(trabalhando, null)
        atualizarResumoDoGrupo(grupo)
        rolarParaOFim()
        return
      }

      if (evento === 'approval_request') {
        textoDoTrabalho(trabalhando, null)
        mostrarPedido(dados)
        return
      }

      if (evento === 'done') {
        recebeuTerminal = true
        return
      }

      if (evento === 'error') {
        recebeuTerminal = true
        throw new Error(dados.message ?? 'erro no backend')
      }
    })
  } catch (erro) {
    interrompido = erro?.name === 'AbortError'
    const { linha, fala: falaErro } = criarFalaDoKoda()
    if (interrompido) {
      falaErro.textContent = 'Resposta interrompida.'
      falaErro.classList.add('fala--aviso')
    } else {
      falaErro.textContent = `Não consegui acompanhar a rodada: ${erro.message}`
      falaErro.classList.add('fala--erro')
    }
    inserirBloco(linha)
  } finally {
    loteFala?.cancelar()
    redesenharFala()
    fecharRaciocinio()
    // Ferramenta que ainda estava girando quando a conexão morreu não pode ficar
    // «rodando» para sempre: o passo passa a dizer que foi interrompido.
    for (const passo of coluna.querySelectorAll('.passo')) {
      const estadoPasso = passo.querySelector('.passo__estado')
      if (estadoPasso?.textContent === 'rodando') {
        estadoPasso.textContent = 'interrompido'
        passo.querySelector('.passo__icone').innerHTML = traco('alerta', 14)
      }
    }
    for (const bloco of coluna.querySelectorAll('.ferramentas')) {
      atualizarResumoDoGrupo(bloco)
    }
    fecharGrupo()
    window.clearInterval(relogio)
    trabalhando.remove()
    coluna.removeAttribute('data-ao-vivo')
    controlador = null
    ocupado = false
    terminarRodada()
    atualizarEnviar()
    rolarParaOFim()
  }

  if (!recebeuTerminal && !interrompido) {
    const { linha, fala: falaErro } = criarFalaDoKoda()
    falaErro.textContent = 'A conexão caiu antes do fim da resposta.'
    falaErro.classList.add('fala--aviso')
    inserirBloco(linha)
  }
  void sincronizarConversa()
}

/**
 * O PC está trabalhando? Se estiver na conversa aberta, este celular entra junto —
 * é o «ver no celular o que o PC está fazendo». A rodada do próprio celular que
 * continuou depois de o app sair também volta por aqui.
 */
async function consultarAoVivo() {
  if (document.visibilityState !== 'visible') return
  if (ocupado || !conversaId || !document.body.dataset.tela) return
  try {
    const dados = await api('/api/live')
    const sessoes = Array.isArray(dados?.sessoes) ? dados.sessoes : []
    const daqui = sessoes.find((item) => item.rodando && item.conversa === conversaId)
    if (!daqui) {
      sessaoAcompanhada = null
      return
    }
    if (sessaoAcompanhada === daqui.sessao) return
    sessaoAcompanhada = daqui.sessao
    await acompanharAoVivo(conversaId, 0)
  } catch {
    /* sem rede: a próxima consulta tenta */
  }
}

window.setInterval(() => void consultarAoVivo(), 3000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void consultarAoVivo()
})

/* ------------------------------------------------------------------------- */
/* Menu                                                                      */
/* ------------------------------------------------------------------------- */

function itemDeOpcao({ valor, titulo, dica, icone, selecionado, tipo }) {
  // `data-tipo` deixa o mesmo item funcionar no menu do compositor e na folha da
  // configuração: quem trata o clique não precisa adivinhar de onde ele veio.
  return `<button type="button" class="menu__item" role="menuitemradio" aria-checked="${selecionado}" data-valor="${valor}"${tipo ? ` data-tipo="${tipo}"` : ''}>
    ${icone ? `<span class="menu__icone">${icone}</span>` : ''}
    <span class="menu__texto"><span class="menu__titulo">${titulo}</span>${dica ? `<span class="menu__dica">${dica}</span>` : ''}</span>
    <span class="menu__check">${traco('check', 15)}</span>
  </button>`
}

function itemDeAcao({ acao, titulo, dica, icone }) {
  return `<button type="button" class="menu__item" role="menuitem" data-acao="${acao}">
    ${icone ? `<span class="menu__icone">${icone}</span>` : ''}
    <span class="menu__texto"><span class="menu__titulo">${titulo}</span>${dica ? `<span class="menu__dica">${dica}</span>` : ''}</span>
  </button>`
}

function montarMenu(nome) {
  if (nome === 'modelo') {
    if (MODELOS.every((grupo) => grupo.itens.length === 0)) {
      return '<div class="menu__grupo" role="presentation">Carregando modelos…</div>'
    }
    return MODELOS.map(
      (grupo) =>
        `<div class="menu__grupo" role="presentation">${escaparHtml(grupo.apelido ?? grupo.grupo)}</div>` +
        grupo.itens
          .map((item) =>
            itemDeOpcao({
              valor: item.id,
              titulo: escaparHtml(item.nome),
              dica: escaparHtml(grupo.grupo),
              icone: COROA,
              selecionado: estado.modelo === item.id,
              tipo: 'modelo',
            }),
          )
          .join(''),
    ).join('')
  }

  if (nome === 'esforco') {
    return ESFORCOS.map((item) =>
      itemDeOpcao({
        valor: item.id,
        titulo: item.nome,
        dica: item.dica,
        selecionado: estado.esforco === item.id,
        tipo: 'esforco',
      }),
    ).join('')
  }

  if (nome === 'permissao') {
    return PERMISSOES.map((item) =>
      itemDeOpcao({
        valor: item.id,
        titulo: item.nome,
        dica: item.dica,
        icone: `<span class="${item.cor}">${traco(item.icone, 16)}</span>`,
        selecionado: estado.permissao === item.id,
        tipo: 'permissao',
      }),
    ).join('')
  }

  if (nome === 'projeto') {
    return (
      itemDeOpcao({
        valor: 'sem-projeto',
        titulo: 'Sem projeto',
        dica: 'O agente trabalha na pasta padrão do Koda',
        icone: traco('pasta', 16),
        selecionado: estado.projeto === 'sem-projeto',
        tipo: 'projeto',
      }) +
      PROJETOS.map((projeto) =>
        itemDeOpcao({
          valor: projeto.id,
          titulo: escaparHtml(projeto.nome),
          dica: escaparHtml(projeto.caminho),
          icone: traco('pasta', 16),
          selecionado: estado.projeto === projeto.id,
          tipo: 'projeto',
        }),
      ).join('') +
      itemDeAcao({
        acao: 'pastas',
        titulo: 'Escolher outra pasta…',
        dica: 'Navegar pelas pastas deste PC',
        icone: traco('lupa', 16),
      })
    )
  }

  if (nome === 'mais') {
    return (
      itemDeAcao({
        acao: 'imagem',
        titulo: 'Enviar imagem',
        dica: 'PNG, JPG ou captura de tela',
        icone: traco('imagem', 16),
      }) +
      itemDeAcao({
        acao: 'arquivo',
        titulo: 'Anexar arquivo',
        dica: 'Código, PDF, planilha ou texto',
        icone: traco('clipe', 16),
      }) +
      (instalacao
        ? itemDeAcao({
            acao: 'instalar',
            titulo: 'Instalar o Koda',
            dica: 'Abrir como app na tela inicial',
            icone: traco('baixar', 16),
          })
        : '')
    )
  }

  return ''
}

function fecharMenu() {
  menu.hidden = true
  menu.innerHTML = ''
  menuAberto = null
  document.querySelectorAll('[data-menu]').forEach((botao) => {
    botao.setAttribute('aria-expanded', 'false')
  })
}

function abrirMenu(nome, gatilho) {
  if (menuAberto === nome) {
    fecharMenu()
    return
  }
  menu.innerHTML = montarMenu(nome)
  menu.hidden = false
  menuAberto = nome
  document.querySelectorAll('[data-menu]').forEach((botao) => {
    botao.setAttribute('aria-expanded', String(botao === gatilho))
  })
}

/* ------------------------------------------------------------------------- */
/* Interações                                                                */
/* ------------------------------------------------------------------------- */

document.addEventListener('click', (evento) => {
  const gatilho = evento.target.closest('[data-menu]')
  if (gatilho) {
    // O modelo tem uma folha própria, com busca e o provedor de cada um — é o
    // seletor do PC. Os outros chips continuam no menu curto.
    if (gatilho.dataset.menu === 'modelo') abrirFolhaModelo()
    else abrirMenu(gatilho.dataset.menu, gatilho)
    return
  }

  const grupo = evento.target.closest('[data-abrir-grupo]')
  if (grupo) {
    abrirGrupoDeModelos(grupo.dataset.grupoTipo, grupo.dataset.abrirGrupo)
    return
  }

  const item = evento.target.closest('.menu__item')
  if (item) {
    const naFolha = Boolean(item.closest('.folha'))
    if (item.dataset.acao === 'imagem') arquivoImagem.click()
    else if (item.dataset.acao === 'arquivo') arquivo.click()
    else if (item.dataset.acao === 'pastas') {
      fecharMenu()
      fecharFolha()
      void abrirPastas()
      return
    } else if (item.dataset.acao === 'instalar') {
      const pedido = instalacao
      instalacao = null
      void pedido?.prompt()
    } else if (item.dataset.tipo === 'modelo' || (!item.dataset.tipo && menuAberto === 'modelo')) {
      estado.modelo = item.dataset.valor
      salvarPreferencias()
    } else if (item.dataset.tipo === 'esforco' || (!item.dataset.tipo && menuAberto === 'esforco')) {
      estado.esforco = item.dataset.valor
      salvarPreferencias()
    } else if (item.dataset.tipo === 'permissao' || (!item.dataset.tipo && menuAberto === 'permissao')) {
      void definirPermissao(item.dataset.valor)
    } else if (item.dataset.tipo === 'projeto' || (!item.dataset.tipo && menuAberto === 'projeto')) {
      void definirProjeto(item.dataset.valor)
    }
    atualizarGatilhos()
    if (naFolha) fecharFolha()
    else fecharMenu()
    return
  }

  if (menuAberto && !evento.target.closest('.menu')) fecharMenu()
})

document.addEventListener('keydown', (evento) => {
  if (evento.key === 'Escape' && menuAberto) fecharMenu()
})

/* Reasoning e Web: o mesmo alternador do PC. */
document.querySelectorAll('[data-toggle]').forEach((botao) => {
  if (botao.dataset.toggle === 'mic') return
  botao.addEventListener('click', () => {
    const chave = botao.dataset.toggle
    const ativo = botao.getAttribute('aria-pressed') === 'true'
    botao.setAttribute('aria-pressed', String(!ativo))
    if (chave === 'reasoning' || chave === 'web') {
      estado[chave] = !ativo
      salvarPreferencias()
    }
  })
})

campo.addEventListener('input', atualizarEnviar)

// Como no PC: Enter manda, Shift+Enter quebra a linha.
campo.addEventListener('keydown', (evento) => {
  if (evento.key === 'Enter' && !evento.shiftKey) {
    evento.preventDefault()
    caixa.requestSubmit()
  }
})

const ICONE_PARAR =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
const ICONE_ENVIAR =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>'

/** O mesmo botão vira Parar enquanto a resposta está viva. */
function comecarRodada() {
  ocupado = true
  enviar.disabled = false
  enviar.innerHTML = ICONE_PARAR
  enviar.setAttribute('aria-label', 'Parar resposta')
  medirCompositor()
}

function terminarRodada() {
  enviar.innerHTML = ICONE_ENVIAR
  enviar.setAttribute('aria-label', 'Enviar mensagem')
  atualizarEnviar()
}

enviar.addEventListener('click', (evento) => {
  if (!ocupado) return
  evento.preventDefault()
  // Fechar a conexão não para mais a rodada: o trabalho é do backend. O Parar de
  // verdade é o pedido abaixo; o abort só fecha o desenho local na hora.
  void pararRodadaNoPc()
  controlador?.abort()
})

/**
 * A interface inteligente pode pedir um turno novo (`issueNewTurn`). O caminho é o mesmo
 * do compositor — escreve e envia —, sem duplicar aqui a lógica de anexos e stream.
 */
window.addEventListener('koda:enviar', (evento) => {
  const texto = String(evento.detail?.texto ?? '').trim()
  if (!texto || ocupado) return
  campo.value = texto
  caixa.requestSubmit()
})

caixa.addEventListener('submit', (evento) => {
  evento.preventDefault()
  if (ocupado) return
  const texto = campo.value.trim()
  if (!texto && estado.anexos.length === 0) return

  // A primeira mensagem tira o KODA do meio: ele sobe e encolhe para o topo.
  const anexosDaMensagem = estado.anexos.slice()
  const mensagem = { texto, anexos: anexosDaMensagem }
  listaMensagens.append(criarBolha(mensagem))
  document.body.dataset.tela = 'conversa'

  campo.value = ''
  estado.anexos = []
  renderizarAnexos()

  comecarRodada()
  campo.focus()

  void (async () => {
    const ids = (
      await Promise.all(
        anexosDaMensagem.map((anexo) => anexo.promessa ?? Promise.resolve(anexo.id ?? null)),
      )
    ).filter(Boolean)
    await rodar(mensagem, ids)
    terminarRodada()
  })()
})

/**
 * A decisão do cartão de plano (`Fazer` / `Desistir`) — o mesmo caminho do PC.
 *
 * O desenho do plano não sabe enviar nada: ele chama esta função. O POST marca o plano
 * como aprovado ou recusado e, quando aceito, a rodada seguinte retoma exatamente de onde
 * o agente parou (`approved_plan_id`). Sem isso, o modo Plan mostrava o plano e não tinha
 * como seguir — o celular ficava sem a única ação que o cartão oferece.
 */
async function decidirPlano(planId, aceito, aoTerminar) {
  try {
    const resposta = await abrirFluxo('/api/chat/plan/decision', {
      method: 'POST',
      headers: cabecalhos(),
      body: JSON.stringify({ id: planId, decision: aceito ? 'approve' : 'reject' }),
    })
    if (!resposta.ok) {
      let detalhe = ''
      try {
        const corpo = await resposta.json()
        detalhe = corpo?.detail ?? ''
      } catch {
        /* corpo vazio */
      }
      throw new Error(detalhe || `o backend respondeu ${resposta.status}`)
    }
    if (!aceito) {
      aoTerminar?.(true)
      return
    }
    document.body.dataset.tela = 'conversa'
    comecarRodada()
    try {
      await rodar({ texto: '', anexos: [] }, [], {
        resume: true,
        approved_plan_id: planId,
      })
    } finally {
      terminarRodada()
    }
    aoTerminar?.(true)
  } catch (erro) {
    console.warn('[koda] decisão do plano recusada', erro)
    aoTerminar?.(false)
  }
}

function adicionarAnexos(lista) {
  for (const item of lista) {
    const anexo = { nome: item.name, id: null, enviando: true, erro: false }
    anexo.promessa = (async () => {
      try {
        const dados = new FormData()
        dados.append('arquivo', item, item.name)
        const resposta = await abrirFluxo('/api/attachments', {
          method: 'POST',
          headers: cabecalhos(false),
          body: dados,
        })
        if (!resposta.ok) throw new Error(`o backend respondeu ${resposta.status}`)
        const enviado = await resposta.json()
        anexo.id = enviado.id
        anexo.enviando = false
        anexo.nome = enviado.nome ?? anexo.nome
        return enviado.id
      } catch {
        anexo.enviando = false
        anexo.erro = true
        return null
      } finally {
        renderizarAnexos()
      }
    })()
    estado.anexos.push(anexo)
  }
  renderizarAnexos()
  atualizarEnviar()
}

arquivoImagem.addEventListener('change', (evento) => {
  adicionarAnexos(evento.target.files)
  evento.target.value = ''
})

arquivo.addEventListener('change', (evento) => {
  adicionarAnexos(evento.target.files)
  evento.target.value = ''
})

anexos.addEventListener('click', (evento) => {
  const remover = evento.target.closest('[data-indice]')
  if (!remover) return
  estado.anexos.splice(Number(remover.dataset.indice), 1)
  renderizarAnexos()
  atualizarEnviar()
})

/* ------------------------------------------------------------------------- */
/* Voz                                                                       */
/* ------------------------------------------------------------------------- */

const botaoMic = document.querySelector('[data-toggle="mic"]')
/** @type {any} — a API de voz não está na tipagem padrão do DOM. */
const janelaDeVoz = window
const Reconhecimento = janelaDeVoz.SpeechRecognition ?? janelaDeVoz.webkitSpeechRecognition
let reconhecimento = null

if (!Reconhecimento) {
  botaoMic.disabled = true
  botaoMic.title = 'Entrada de voz indisponível neste navegador'
  botaoMic.setAttribute('aria-label', 'Entrada de voz indisponível neste navegador')
}

botaoMic.addEventListener('click', () => {
  if (!Reconhecimento) return
  if (reconhecimento) {
    reconhecimento.stop()
    return
  }

  const escuta = new Reconhecimento()
  escuta.lang = 'pt-BR'
  escuta.interimResults = false
  escuta.continuous = false

  escuta.onresult = (evento) => {
    let texto = ''
    for (let i = evento.resultIndex; i < evento.results.length; i += 1) {
      if (evento.results[i].isFinal) texto += evento.results[i][0].transcript
    }
    const limpo = texto.trim()
    if (!limpo) return
    campo.value = campo.value.trim() ? `${campo.value.trimEnd()} ${limpo}` : limpo
    atualizarEnviar()
  }
  escuta.onend = () => {
    reconhecimento = null
    botaoMic.setAttribute('aria-pressed', 'false')
  }
  escuta.onerror = () => {
    reconhecimento = null
    botaoMic.setAttribute('aria-pressed', 'false')
  }

  try {
    escuta.start()
    reconhecimento = escuta
    botaoMic.setAttribute('aria-pressed', 'true')
  } catch {
    reconhecimento = null
  }
})

/* ------------------------------------------------------------------------- */
/* Histórico, configuração, folhas e pastas                                  */
/* ------------------------------------------------------------------------- */

function escaparHtml(valor) {
  return String(valor ?? '').replace(
    /[&<>"']/g,
    (caractere) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[caractere],
  )
}

/** «hoje, 14:32», «ontem, 09:10», «12 de mar.» — o mesmo jeito de ler do PC. */
function quando(ms) {
  const valor = Number(ms)
  if (!Number.isFinite(valor) || valor <= 0) return ''
  const data = new Date(valor)
  if (Number.isNaN(data.getTime())) return ''
  const agora = new Date()
  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (data.toDateString() === agora.toDateString()) return `hoje, ${hora}`
  const ontem = new Date(agora)
  ontem.setDate(agora.getDate() - 1)
  if (data.toDateString() === ontem.toDateString()) return `ontem, ${hora}`
  return data.toLocaleDateString(
    'pt-BR',
    data.getFullYear() === agora.getFullYear()
      ? { day: '2-digit', month: 'short' }
      : { day: '2-digit', month: 'short', year: 'numeric' },
  )
}

function formatarTokens(total) {
  if (!Number.isFinite(total) || total <= 0) return '0'
  if (total < 1000) return String(Math.round(total))
  const numero = (valor) =>
    valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  if (total < 1_000_000) return `${numero(total / 1000)} mil`
  return `${numero(total / 1_000_000)} mi`
}

function somarTokens(janela) {
  return Object.values(janela?.tokens_por_modelo ?? {}).reduce(
    (total, valor) => total + (Number(valor) || 0),
    0,
  )
}

function textoDoProvedor(provedor) {
  if (!provedor) return ''
  if (!provedor.conectado) return 'não conectado'
  const conta = provedor.conta ? String(provedor.conta) : 'conta conectada'
  return provedor.plano ? `${conta} · ${provedor.plano}` : conta
}

/* --- telas cheias -------------------------------------------------------- */

function abrirTela(elemento) {
  for (const tela of [telaHistorico, telaConfig, telaPastas, telaNavegador]) {
    if (tela) tela.hidden = tela !== elemento
  }
}

function fecharTelas() {
  for (const tela of [telaHistorico, telaConfig, telaPastas, telaNavegador]) {
    if (tela) tela.hidden = true
  }
}

/* --- folha inferior ------------------------------------------------------ */

let folhaVoltarAcao = null
let grupoDeModeloAberto = null

function abrirFolha(titulo, html, aoMontar, aoVoltar) {
  if (!folha) return
  fecharMenu()
  folhaTitulo.textContent = titulo
  folhaCorpo.innerHTML = html
  folhaVoltarAcao = aoVoltar ?? null
  if (folhaVoltar) folhaVoltar.hidden = !folhaVoltarAcao
  folha.hidden = false
  aoMontar?.(folhaCorpo)
}

function fecharFolha() {
  if (!folha || folha.hidden) return
  folha.hidden = true
  folhaCorpo.innerHTML = ''
  folhaTitulo.textContent = ''
  folhaVoltarAcao = null
  grupoDeModeloAberto = null
  if (folhaVoltar) folhaVoltar.hidden = true
}

/*
 * O botão de voltar do Android chama esta função antes de sair do app. Ela
 * fecha o que estiver por cima e devolve `true`; se não houver nada aberto,
 * devolve `false` e o APK manda o app para segundo plano — nunca para a tela
 * de entrada, que era o que parecia «sair da conta».
 */
window.kodaVoltar = () => {
  if (folha && !folha.hidden) {
    if (folhaVoltarAcao) folhaVoltarAcao()
    else fecharFolha()
    return true
  }
  if (menuAberto) {
    fecharMenu()
    return true
  }
  if (telaNavegador && !telaNavegador.hidden && navegadorTemPagina) {
    irParaInicioDoNavegador()
    return true
  }
  if (
    [telaHistorico, telaConfig, telaPastas, telaNavegador].some(
      (tela) => tela && !tela.hidden,
    )
  ) {
    fecharTelas()
    return true
  }
  return false
}

function abrirFolhaOpcoes(titulo, tipo) {
  abrirFolha(titulo, montarMenu(tipo))
}

/* --- seletor de modelos: provedores primeiro, como no PC ----------------- */

let buscaDeModelo = ''

function tipoDoGrupo(grupo) {
  return grupo.tipo ?? (grupo.provedorId ? 'provedor' : 'host')
}

function gruposDeHost() {
  return MODELOS.filter((grupo) => tipoDoGrupo(grupo) === 'host')
}

function gruposDeProvedor() {
  return MODELOS.filter((grupo) => tipoDoGrupo(grupo) === 'provedor')
}

function grupoPorChave(tipo, chave) {
  return MODELOS.find(
    (grupo) =>
      tipoDoGrupo(grupo) === tipo &&
      (tipo === 'host' ? (grupo.chave ?? grupo.grupo) === chave : grupo.provedorId === chave),
  )
}

function nomeDoGrupo(grupo) {
  // As famílias do Koda aparecem pelo nome delas (GLM, Qwen), não por «Koda»:
  // é o mesmo cabeçalho do seletor do PC.
  return tipoDoGrupo(grupo) === 'host' ? grupo.grupo : (grupo.apelido ?? grupo.grupo)
}

function iconeDoGrupo(grupo, tamanho = 24) {
  if (tipoDoGrupo(grupo) === 'host') {
    return `<span class="grupo-icone grupo-icone--host" style="width:${tamanho}px;height:${tamanho}px">${COROA}</span>`
  }
  if (grupo.logo) {
    return `<span class="grupo-icone" style="width:${tamanho}px;height:${tamanho}px"><img src="${escaparHtml(grupo.logo)}" alt="" loading="lazy" /></span>`
  }
  return `<span class="grupo-icone grupo-icone--sigla" style="width:${tamanho}px;height:${tamanho}px">${escaparHtml(grupo.sigla ?? '')}</span>`
}

/** A linha de estado do grupo: contagem, «lendo…» ou o modelo em uso. */
function metaDoGrupo(grupo) {
  if (grupo.carregando) return 'lendo modelos…'
  const emUso = grupo.itens.some((item) => item.id === estado.modelo)
  return `${grupo.itens.length} ${grupo.itens.length === 1 ? 'modelo' : 'modelos'}${emUso ? ' · em uso' : ''}`
}

/** Uma linha de primeiro nível: o provedor (ou a família do Koda), com a marca. */
function htmlLinhaDeGrupo(grupo) {
  const tipo = tipoDoGrupo(grupo)
  const chave = tipo === 'host' ? (grupo.chave ?? grupo.grupo) : grupo.provedorId
  return `<button type="button" class="provedor-linha" data-abrir-grupo="${escaparHtml(chave)}" data-grupo-tipo="${tipo}">
    ${iconeDoGrupo(grupo, 34)}
    <span class="provedor-linha__texto">
      <span class="provedor-linha__nome">${escaparHtml(nomeDoGrupo(grupo))}</span>
      <span class="provedor-linha__meta">${metaDoGrupo(grupo)}</span>
    </span>
    <span class="provedor-linha__seta">${traco('seta', 16)}</span>
  </button>`
}

/** Os itens de um grupo — o mesmo desenho na folha aberta e na atualização em lote. */
function htmlDosItensDoGrupo(grupo) {
  if (grupo.carregando) return '<p class="folha__vazio">Lendo os modelos deste provedor…</p>'
  return grupo.itens
    .map((item) =>
      itemDeOpcao({
        valor: item.id,
        tipo: 'modelo',
        titulo: escaparHtml(item.nome),
        dica: escaparHtml(grupo.grupo),
        icone: tipoDoGrupo(grupo) === 'host' ? COROA : '',
        selecionado: estado.modelo === item.id,
      }),
    )
    .join('')
}

/** A busca mostra os modelos direto, com o cabeçalho do dono de cada um. */
function htmlDaBusca(termo) {
  const grupos = MODELOS.map((grupo) => ({
    ...grupo,
    itens: grupo.itens.filter((item) =>
      `${item.nome} ${grupo.grupo} ${grupo.apelido ?? ''}`.toLowerCase().includes(termo),
    ),
  })).filter((grupo) => grupo.itens.length > 0)
  if (grupos.length === 0) return '<p class="folha__vazio">Nenhum modelo com esse nome.</p>'
  return grupos
    .map(
      (grupo) => `<div class="modelo-grupo">
        <div class="modelo-grupo__topo">
          ${iconeDoGrupo(grupo, 22)}
          <span class="modelo-grupo__nome">${escaparHtml(nomeDoGrupo(grupo))}</span>
          <span class="modelo-grupo__contagem">${grupo.itens.length}</span>
        </div>
        ${grupo.itens
          .map((item) =>
            itemDeOpcao({
              valor: item.id,
              tipo: 'modelo',
              titulo: escaparHtml(item.nome),
              dica: escaparHtml(grupo.grupo),
              icone: tipoDoGrupo(grupo) === 'host' ? COROA : '',
              selecionado: estado.modelo === item.id,
            }),
          )
          .join('')}
      </div>`,
    )
    .join('')
}

function htmlDosModelos() {
  const termo = buscaDeModelo.trim().toLowerCase()
  if (termo) return htmlDaBusca(termo)
  const host = gruposDeHost()
  const provedores = gruposDeProvedor()
  if (host.length === 0 && provedores.length === 0) {
    return `<p class="folha__vazio">${
      catalogoEm === 0
        ? 'Lendo os modelos do PC…'
        : 'Nenhum provedor conectado. Entre em um provedor no PC para os modelos aparecerem aqui.'
    }</p>`
  }
  return `
    ${host.length > 0 ? `<div class="folha__secao">Modelos do Koda</div>${host.map(htmlLinhaDeGrupo).join('')}` : ''}
    ${
      provedores.length > 0
        ? `<div class="folha__secao">Provedores conectados<span>${provedores.length}</span></div>${provedores
            .map(htmlLinhaDeGrupo)
            .join('')}`
        : ''
    }
  `
}

function abrirFolhaModelo() {
  buscaDeModelo = ''
  grupoDeModeloAberto = null
  const desatualizado = !catalogoEm || Date.now() - catalogoEm > 60_000
  abrirFolha(
    'Modelo',
    `<div class="folha__busca">
      <label class="busca">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m16.5 16.5 4 4" />
        </svg>
        <input id="folha-busca-modelo" type="search" placeholder="Buscar provedor ou modelo" autocomplete="off" spellcheck="false" />
      </label>
    </div>
    <div id="folha-modelos">${htmlDosModelos()}</div>`,
    (corpo) => {
      const entrada = corpo.querySelector('#folha-busca-modelo')
      entrada?.addEventListener('input', () => {
        buscaDeModelo = entrada.value
        const lista = corpo.querySelector('#folha-modelos')
        if (lista) lista.innerHTML = htmlDosModelos()
      })
    },
  )
  // A lista guardada pinta na hora; o catálogo de verdade chega em segundo
  // plano e substitui a folha aberta quando terminar.
  if (desatualizado) void carregarModelos()
}

function abrirGrupoDeModelos(tipo, chave) {
  const grupo = grupoPorChave(tipo, chave)
  if (!grupo) return
  grupoDeModeloAberto = { tipo, chave }
  abrirFolha(
    nomeDoGrupo(grupo),
    `<div class="folha__grupo-topo">
      ${iconeDoGrupo(grupo, 40)}
      <div>
        <div class="folha__grupo-nome">${escaparHtml(grupo.grupo)}</div>
        <div class="folha__grupo-meta">${metaDoGrupo(grupo)}</div>
      </div>
    </div>
    <div class="folha__modelos">${htmlDosItensDoGrupo(grupo)}</div>`,
    undefined,
    () => abrirFolhaModelo(),
  )
}

/**
 * Repinta a folha de modelos aberta sem fechar, sem perder a busca e sem pular o
 * scroll. O catálogo chega provedor por provedor; cada lote que termina atualiza a
 * lista na hora, em vez de esperar os 17.
 */
function atualizarFolhaDeModelos() {
  if (!folha || folha.hidden) return
  if (grupoDeModeloAberto) {
    const grupo = grupoPorChave(grupoDeModeloAberto.tipo, grupoDeModeloAberto.chave)
    if (!grupo) return
    const lista = folha.querySelector('.folha__modelos')
    const meta = folha.querySelector('.folha__grupo-meta')
    if (lista) lista.innerHTML = htmlDosItensDoGrupo(grupo)
    if (meta) meta.textContent = metaDoGrupo(grupo)
    return
  }
  const lista = folha.querySelector('#folha-modelos')
  if (lista) lista.innerHTML = htmlDosModelos()
}

/* --- provedores ---------------------------------------------------------- */

function abrirFolhaProvedores() {
  if (PROVEDORES.length === 0) {
    abrirFolha(
      'Provedores',
      '<p class="folha__vazio">Não consegui ler os provedores do PC agora. Confira a conexão e tente de novo.</p>',
    )
    return
  }
  abrirFolha(
    'Provedores',
    `<div class="provedores">${PROVEDORES.map(
      (provedor) => `<button type="button" class="provedor" data-provedor="${escaparHtml(provedor.id)}">
        <span class="provedor__sigla ${provedor.conectado ? 'provedor__sigla--on' : ''}">${escaparHtml(provedor.sigla ?? '')}</span>
        <span class="provedor__texto">
          <span class="provedor__nome">${escaparHtml(apelidoDoProvedor(provedor))}</span>
          <span class="provedor__meta">${escaparHtml(textoDoProvedor(provedor))}</span>
        </span>
        <span class="provedor__ponto ${provedor.conectado ? 'provedor__ponto--on' : ''}"></span>
      </button>`,
    ).join('')}</div>`,
  )
}

async function abrirProvedorDetalhe(id) {
  const provedor = PROVEDORES.find((item) => item.id === id)
  if (!provedor) return
  const apelido = apelidoDoProvedor(provedor)
  abrirFolha(apelido, '<p class="folha__vazio">Lendo os modelos…</p>')

  let modelos = []
  let motivo = ''
  if (provedor.conectado) {
    try {
      const dados = await modelosDoProvedor(id)
      modelos = (dados.modelos ?? []).map((modelo) => ({
        id: modelo,
        nome: dados.nomes?.[modelo] ?? modelo,
      }))
      motivo = dados.motivo ?? ''
    } catch {
      motivo = 'Não consegui listar os modelos deste provedor agora.'
    }
  } else {
    motivo =
      'Este provedor ainda não está conectado no Koda. Entre por ele no PC; o login vale aqui também.'
  }

  // A pessoa pode ter fechado a folha enquanto os modelos chegavam.
  if (!folha || folha.hidden) return
  folhaTitulo.textContent = apelido
  folhaCorpo.innerHTML = `<div class="provedor-detalhe">
    <div class="provedor-detalhe__topo">
      <span class="provedor-detalhe__sigla">${escaparHtml(provedor.sigla ?? '')}</span>
      <div>
        <div class="provedor-detalhe__nome">${escaparHtml(provedor.nome)}</div>
        <div class="provedor-detalhe__meta">${escaparHtml(textoDoProvedor(provedor))}</div>
      </div>
    </div>
    ${
      provedor.conectado
        ? `<button type="button" class="botao botao--neutro" data-testar-provedor="${escaparHtml(id)}">Testar login</button>
           <p class="folha__vazio" id="teste-provedor" hidden></p>`
        : ''
    }
    ${
      modelos.length > 0
        ? `<div class="modelo-grupo">
             <div class="modelo-grupo__topo">
               <span class="modelo-grupo__nome">Modelos</span>
               <span class="modelo-grupo__contagem">${modelos.length}</span>
             </div>
             ${modelos
               .map((modelo) =>
                 itemDeOpcao({
                   valor: `provedor:${id}:${modelo.id}`,
                   tipo: 'modelo',
                   titulo: escaparHtml(modelo.nome),
                   dica: escaparHtml(provedor.nome),
                   icone: COROA,
                   selecionado: estado.modelo === `provedor:${id}:${modelo.id}`,
                 }),
               )
               .join('')}
           </div>`
        : ''
    }
    ${motivo ? `<p class="folha__vazio">${escaparHtml(motivo)}</p>` : ''}
  </div>`
}

async function testarProvedor(id, botao) {
  const aviso = document.querySelector('#teste-provedor')
  const rotulo = botao.textContent
  botao.disabled = true
  botao.textContent = 'Testando…'
  if (aviso) {
    aviso.hidden = false
    aviso.textContent = 'Falando com o provedor…'
  }
  try {
    const resultado = await api(`/api/provedores/${encodeURIComponent(id)}/testar`, {
      method: 'POST',
    })
    if (aviso) {
      aviso.hidden = false
      aviso.textContent =
        resultado?.detalhe ||
        (resultado?.ok ? 'login válido' : 'não consegui validar o login')
    }
  } catch (erro) {
    if (aviso) {
      aviso.hidden = false
      aviso.textContent = `Falhou: ${erro.message}`
    }
  } finally {
    botao.disabled = false
    botao.textContent = rotulo
  }
}

/* --- histórico ----------------------------------------------------------- */

function lerCacheConversas() {
  return lerJson(CACHE_CONVERSAS, null)
}

function guardarCacheConversas(lista) {
  if (!Array.isArray(lista)) return
  salvarJson(CACHE_CONVERSAS, { em: Date.now(), itens: lista.slice(0, 50) })
}

/**
 * Guarda a conversa inteira no celular e mantém só as mais recentes.
 *
 * O histórico de verdade mora no PC; esta cópia existe para abrir a conversa quando
 * o link cai — e para o app não parecer vazio no metrô.
 */
function guardarConversaNoCache(registro) {
  if (!registro?.id) return
  const indice = lerJson(`${CACHE_CONVERSA}indice`, [])
  const novo = [
    registro.id,
    ...(Array.isArray(indice) ? indice : []).filter((id) => id !== registro.id),
  ]
  for (const id of novo.slice(CACHE_LIMITE)) {
    try {
      localStorage.removeItem(CACHE_CONVERSA + id)
    } catch {
      /* nada a limpar */
    }
  }
  salvarJson(`${CACHE_CONVERSA}indice`, novo.slice(0, CACHE_LIMITE))
  salvarJson(CACHE_CONVERSA + registro.id, { em: Date.now(), conversa: registro })
}

/** Depois de cada resposta: a conversa e a lista do histórico ficam iguais às do PC. */
async function sincronizarConversa() {
  if (!conversaId) return
  try {
    const registro = await api(`/api/conversations/${encodeURIComponent(conversaId)}`)
    if (!registro?.id) return
    guardarConversaNoCache(registro)
    const resumo = {
      id: registro.id,
      title: registro.title,
      preview: registro.preview,
      message_count: registro.message_count,
      updated_at: registro.updated_at,
    }
    const base = lerCacheConversas()?.itens ?? conversas
    conversas = [resumo, ...base.filter((item) => item.id !== resumo.id)].slice(0, 50)
    guardarCacheConversas(conversas)
    if (telaHistorico && !telaHistorico.hidden) renderizarHistorico()
  } catch {
    /* sem rede: a próxima abertura tenta de novo */
  }
}

function desenharConversa(registro) {
  listaMensagens.innerHTML = ''
  for (const mensagem of registro.messages ?? []) {
    if (mensagem.role === 'user') {
      listaMensagens.append(
        criarBolha({
          texto: mensagem.text ?? '',
          anexos: (mensagem.attachments ?? []).map((anexo) => ({
            nome: anexo.nome ?? 'anexo',
          })),
        }),
      )
    } else if (mensagem.role === 'assistant' && (mensagem.text ?? '').trim()) {
      const { linha, fala } = criarFalaDoKoda()
      renderizarMarkdown(mensagem.text, fala)
      listaMensagens.append(linha)
    }
  }
  desenharTransferenciasSalvas(registro.id)
  rolarParaOFim()
}

/**
 * Ao abrir o app, volta para a conversa em que a pessoa estava.
 *
 * O id é do PC; a cópia local cobre o caso de abrir sem rede. Se a conversa foi
 * apagada no PC, a tela fica na inicial em vez de mostrar um erro.
 */
async function restaurarUltimaConversa() {
  const guardada = lerJson(ULTIMA_CONVERSA, null)
  if (typeof guardada !== 'string' || !guardada) return
  if (conversaId || listaMensagens.children.length > 0) return
  if (document.body.dataset.tela === 'conversa') return

  // A pessoa pode ter começado a escrever enquanto a conversa vinha do PC.
  const aindaVale = () =>
    !conversaId && listaMensagens.children.length === 0

  try {
    const registro = await api(`/api/conversations/${encodeURIComponent(guardada)}`)
    if (!registro?.messages?.length || !aindaVale()) return
    desenharConversa(registro)
    conversaId = registro.id
    document.body.dataset.tela = 'conversa'
  } catch {
    const cache = lerJson(CACHE_CONVERSA + guardada, null)?.conversa
    if (!cache?.messages?.length || !aindaVale()) return
    desenharConversa(cache)
    conversaId = cache.id
    document.body.dataset.tela = 'conversa'
  }
}

function abrirHistorico() {
  if (!telaHistorico) return
  abrirTela(telaHistorico)
  if (historicoBusca) historicoBusca.value = ''
  renderizarHistorico()
  void carregarHistorico()
}

async function carregarHistorico() {
  if (!historicoLista) return
  const versao = ++historicoVersao
  if (historicoEstado) historicoEstado.textContent = 'Lendo as conversas do seu PC…'
  try {
    const lista = await api('/api/conversations?limit=50')
    // Uma conversa apagada enquanto esta lista vinha do PC não pode reaparecer.
    if (versao !== historicoVersao) return
    conversas = Array.isArray(lista) ? lista : []
    conversasDoCache = false
    guardarCacheConversas(conversas)
    if (historicoAviso) historicoAviso.hidden = true
  } catch {
    if (versao !== historicoVersao) return
    const cache = lerCacheConversas()
    conversas = Array.isArray(cache?.itens) ? cache.itens : []
    conversasDoCache = true
    if (conversas.length === 0) {
      if (historicoEstado) historicoEstado.textContent = 'Sem conexão com o PC'
      historicoLista.innerHTML =
        '<p class="historico__vazio">Sem conexão com o PC e sem conversas guardadas neste celular.</p>'
      return
    }
    if (historicoAviso) {
      historicoAviso.hidden = false
      historicoAviso.textContent =
        'Sem conexão com o PC agora: mostrando a cópia guardada neste celular.'
    }
  }
  renderizarHistorico()
}

function renderizarHistorico() {
  if (!historicoLista) return
  const termo = (historicoBusca?.value ?? '').trim().toLowerCase()
  const lista = conversas.filter((item) => {
    if (!termo) return true
    return `${item.title ?? ''} ${item.preview ?? ''}`.toLowerCase().includes(termo)
  })

  if (historicoEstado) {
    historicoEstado.textContent = conversasDoCache
      ? 'Cópia guardada neste celular'
      : `${conversas.length} ${conversas.length === 1 ? 'conversa' : 'conversas'} no seu PC`
  }

  if (lista.length === 0) {
    historicoLista.innerHTML = `<p class="historico__vazio">${
      termo
        ? 'Nenhuma conversa com esse texto.'
        : 'Nenhuma conversa ainda. A primeira mensagem cria uma.'
    }</p>`
    return
  }

  historicoLista.innerHTML = lista
    .map((item) => {
      const titulo = (item.title ?? '').trim() || 'Conversa sem título'
      const previa = (item.preview ?? '').trim() || 'Sem prévia'
      const contagem = Number(item.message_count) || 0
      const aberta = item.id === conversaId
      return `<div class="historico__item" role="button" tabindex="0" data-conversa="${escaparHtml(item.id)}">
        <span class="historico__corpo">
          <span class="historico__titulo">${escaparHtml(titulo)}</span>
          <span class="historico__previa">${escaparHtml(previa)}</span>
          <span class="historico__meta">
            <span>${escaparHtml(quando(item.updated_at))}</span>
            <span>${contagem} ${contagem === 1 ? 'mensagem' : 'mensagens'}</span>
            ${aberta ? '<span>aberta agora</span>' : ''}
          </span>
        </span>
        <button type="button" class="historico__lixeira" data-apagar-conversa="${escaparHtml(item.id)}" aria-label="Apagar ${escaparHtml(titulo)}">${traco('lixeira', 15)}</button>
      </div>`
    })
    .join('')
}

async function abrirConversa(id) {
  if (ocupado) return
  let registro = null
  try {
    registro = await api(`/api/conversations/${encodeURIComponent(id)}`)
    guardarConversaNoCache(registro)
  } catch {
    registro = lerJson(CACHE_CONVERSA + id, null)?.conversa ?? null
    if (!registro) {
      if (historicoAviso) {
        historicoAviso.hidden = false
        historicoAviso.textContent = 'Não consegui abrir esta conversa no PC.'
      }
      return
    }
  }
  if (!registro) return
  desenharConversa(registro)
  conversaId = registro.id
  salvarJson(ULTIMA_CONVERSA, conversaId)
  fecharTelas()
  document.body.dataset.tela = 'conversa'
  campo.focus()
}

function novaConversa() {
  if (ocupado) return
  conversaId = null
  try {
    localStorage.removeItem(ULTIMA_CONVERSA)
  } catch {
    /* nada guardado */
  }
  listaMensagens.innerHTML = ''
  fecharTelas()
  delete document.body.dataset.tela
  campo.value = ''
  estado.anexos = []
  renderizarAnexos()
  atualizarEnviar()
  campo.focus()
}

async function apagarConversa(id) {
  const alvo = conversas.find((item) => item.id === id)
  const titulo = (alvo?.title ?? '').trim() || 'esta conversa'
  if (!window.confirm(`Apagar «${titulo}» do seu PC? Não dá para desfazer.`)) return
  try {
    await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (erro) {
    if (historicoAviso) {
      historicoAviso.hidden = false
      historicoAviso.textContent = `Não apaguei: ${erro.message}`
    }
    return
  }
  // Invalida qualquer lista que ainda esteja vindo do PC.
  historicoVersao += 1
  try {
    localStorage.removeItem(CACHE_CONVERSA + id)
  } catch {
    /* nada guardado */
  }
  const indice = lerJson(`${CACHE_CONVERSA}indice`, [])
  salvarJson(
    `${CACHE_CONVERSA}indice`,
    (Array.isArray(indice) ? indice : []).filter((item) => item !== id),
  )
  conversas = conversas.filter((item) => item.id !== id)
  guardarCacheConversas(conversas)
  if (conversaId === id) {
    conversaId = null
    try {
      localStorage.removeItem(ULTIMA_CONVERSA)
    } catch {
      /* nada guardado */
    }
    listaMensagens.innerHTML = ''
    delete document.body.dataset.tela
  }
  if (historicoAviso) historicoAviso.hidden = true
  renderizarHistorico()
}

/* --- configuração -------------------------------------------------------- */

function linhaDeConfig({ chave, titulo, dica, valor, icone }) {
  return `<button type="button" class="config-linha" data-config="${chave}">
    <span class="config-linha__icone">${traco(icone, 15)}</span>
    <span class="config-linha__texto">
      <span class="config-linha__titulo">${escaparHtml(titulo)}</span>
      ${dica ? `<span class="config-linha__dica">${escaparHtml(dica)}</span>` : ''}
    </span>
    ${valor ? `<span class="config-linha__valor">${escaparHtml(valor)}</span>` : ''}
    <span class="chevron">${traco('seta', 14)}</span>
  </button>`
}

function linhaDeInterruptor({ chave, titulo, dica, ligado, icone }) {
  return `<div class="config-linha">
    <span class="config-linha__icone">${traco(icone, 15)}</span>
    <span class="config-linha__texto">
      <span class="config-linha__titulo">${escaparHtml(titulo)}</span>
      <span class="config-linha__dica">${escaparHtml(dica)}</span>
    </span>
    <button type="button" class="interruptor" role="switch" aria-pressed="${Boolean(ligado)}" aria-label="${escaparHtml(titulo)}" data-toggle-config="${chave}"></button>
  </div>`
}

function htmlDoUso(uso) {
  const janelas = [
    { rotulo: 'Hoje', dados: uso?.daily },
    { rotulo: 'Semana', dados: uso?.weekly },
    { rotulo: 'Mês', dados: uso?.monthly },
  ]
  return `<div class="uso-grid" id="config-uso">${janelas
    .map(({ rotulo, dados }) => {
      const tokens = dados ? somarTokens(dados) : null
      return `<div class="uso-cartao">
        <div class="uso-cartao__rotulo">${rotulo}</div>
        <div class="uso-cartao__valor">${dados ? formatarDuracao(dados.tempo_ms ?? 0) : '…'}</div>
        <div class="uso-cartao__dica">${tokens == null ? 'tempo trabalhado' : `${formatarTokens(tokens)} tokens`}</div>
      </div>`
    })
    .join('')}</div>`
}

async function carregarUso() {
  if (!document.querySelector('#config-uso')) return
  try {
    const uso = await api(`/api/usage?tz_offset_minutes=${new Date().getTimezoneOffset()}`)
    const alvo = document.querySelector('#config-uso')
    if (alvo) alvo.outerHTML = htmlDoUso(uso)
  } catch {
    const alvo = document.querySelector('#config-uso')
    if (alvo) alvo.outerHTML = '<p class="folha__vazio">Não consegui ler o uso agora.</p>'
  }
}

function textoDaConexao() {
  return link ? 'Link direto com o seu PC' : 'API direta do Koda'
}

function textoDaConexaoDetalhe() {
  if (link) {
    return LINK?.sala ? `Sala ${String(LINK.sala).slice(0, 6)}…` : 'Pareado pelo QR do PC'
  }
  return API
}

function renderizarConfig() {
  if (!configCorpo) return
  const modelo = modeloAtual()
  const projeto = projetoAtual()
  const permissao = PERMISSOES.find((item) => item.id === estado.permissao) ?? PERMISSOES[2]
  const esforco = ESFORCOS.find((item) => item.id === estado.esforco) ?? ESFORCOS[0]
  const conectados = PROVEDORES.filter((item) => item.conectado).length

  configCorpo.innerHTML = `
    <section class="config-secao">
      <h3 class="config-secao__titulo">Modelo</h3>
      <div class="config-cartao">
        ${linhaDeConfig({
          chave: 'modelo',
          titulo: modelo?.nome ?? 'Carregando modelos…',
          dica: modelo ? `de ${modelo.apelido}` : 'toque para escolher',
          valor: 'Trocar',
          icone: 'cerebro',
        })}
        ${linhaDeConfig({
          chave: 'provedores',
          titulo: 'Provedores',
          dica: `${conectados} de ${PROVEDORES.length} conectados neste PC`,
          valor: 'Ver',
          icone: 'chave',
        })}
        ${linhaDeConfig({
          chave: 'esforco',
          titulo: 'Esforço',
          dica: esforco.dica,
          valor: esforco.nome,
          icone: 'atividade',
        })}
      </div>
    </section>

    <section class="config-secao">
      <h3 class="config-secao__titulo">Trabalho</h3>
      <div class="config-cartao">
        ${linhaDeConfig({
          chave: 'projeto',
          titulo: projeto?.nome ?? 'Sem projeto',
          dica: projeto?.caminho ?? 'O agente trabalha na pasta padrão do Koda',
          valor: 'Trocar',
          icone: 'pasta',
        })}
        ${linhaDeConfig({
          chave: 'pastas',
          titulo: 'Escolher pasta no PC',
          dica: 'Navegue pelas pastas e abra uma como projeto',
          valor: 'Abrir',
          icone: 'lupa',
        })}
        ${linhaDeConfig({
          chave: 'permissao',
          titulo: 'Permissão',
          dica: permissao.dica,
          valor: permissao.curto,
          icone: permissao.icone,
        })}
        ${linhaDeInterruptor({
          chave: 'reasoning',
          titulo: 'Reasoning',
          dica: 'Mostrar o raciocínio do modelo',
          ligado: estado.reasoning,
          icone: 'cerebro',
        })}
        ${linhaDeInterruptor({
          chave: 'web',
          titulo: 'Web',
          dica: 'Deixar o agente pesquisar na internet',
          ligado: estado.web,
          icone: 'globo',
        })}
      </div>
    </section>

    <section class="config-secao">
      <h3 class="config-secao__titulo">Uso</h3>
      ${htmlDoUso(null)}
    </section>

    <section class="config-secao">
      <h3 class="config-secao__titulo">Conexão</h3>
      <div class="config-cartao">
        <div class="config-linha">
          <span class="config-linha__icone">${traco('conector', 15)}</span>
          <span class="config-linha__texto">
            <span class="config-linha__titulo">${escaparHtml(textoDaConexao())}</span>
            <span class="config-linha__dica">${escaparHtml(textoDaConexaoDetalhe())}</span>
          </span>
        </div>
        ${linhaDeConfig({
          chave: 'sair',
          titulo: 'Sair do Koda',
          dica: 'O histórico e as preferências ficam guardados',
          valor: '',
          icone: 'x',
        })}
      </div>
    </section>`
}

function abrirConfig() {
  if (!telaConfig) return
  abrirTela(telaConfig)
  renderizarConfig()
  void carregarUso()
}

function abrirConfigOpcao(chave) {
  if (chave === 'modelo') abrirFolhaModelo()
  else if (chave === 'provedores') abrirFolhaProvedores()
  else if (chave === 'projeto') abrirFolhaOpcoes('Projeto', 'projeto')
  else if (chave === 'permissao') abrirFolhaOpcoes('Permissão', 'permissao')
  else if (chave === 'esforco') abrirFolhaOpcoes('Esforço', 'esforco')
  else if (chave === 'pastas') void abrirPastas()
  else if (chave === 'sair') sairDoKoda()
}

function alternarConfig(botao) {
  const chave = botao.dataset.toggleConfig
  if (chave !== 'reasoning' && chave !== 'web') return
  const ativo = botao.getAttribute('aria-pressed') === 'true'
  botao.setAttribute('aria-pressed', String(!ativo))
  estado[chave] = !ativo
  salvarPreferencias()
  // O compositor tem o mesmo alternador; os dois precisam dizer a mesma coisa.
  document
    .querySelector(`[data-toggle="${chave}"]`)
    ?.setAttribute('aria-pressed', String(!ativo))
}

function sairDoKoda() {
  if (!window.confirm('Sair do Koda neste celular? O histórico e as preferências ficam guardados.')) {
    return
  }
  if (link) {
    voltarParaEntrada('Você saiu. Leia o QR do PC para entrar de novo.')
    return
  }
  try {
    localStorage.removeItem('koda-api')
  } catch {
    /* nada guardado */
  }
  location.reload()
}

/* --- navegador de pastas ------------------------------------------------- */

let pastaAtual = null

async function abrirPastas() {
  if (!telaPastas) return
  fecharFolha()
  abrirTela(telaPastas)
  await carregarPastas(estado.projetoCaminho ?? null)
}

async function carregarPastas(caminho) {
  if (!pastasLista) return
  pastasLista.innerHTML = '<p class="folha__vazio">Lendo as pastas do PC…</p>'
  if (pastasAtalhos) pastasAtalhos.innerHTML = ''
  try {
    const consulta = caminho ? `?caminho=${encodeURIComponent(caminho)}` : ''
    const dados = await api(`/api/fs/pastas${consulta}`)
    pastaAtual = dados.caminho ?? null
    if (pastasCaminho) pastasCaminho.textContent = pastaAtual ?? '…'

    const atalhos = [...(dados.atalhos ?? []), ...(dados.unidades ?? [])]
    const vistos = new Set()
    if (pastasAtalhos) {
      pastasAtalhos.innerHTML = atalhos
        .filter((item) => {
          if (!item?.caminho || vistos.has(item.caminho)) return false
          vistos.add(item.caminho)
          return true
        })
        .map(
          (item) =>
            `<button type="button" class="pastas__atalho" data-pasta="${escaparHtml(item.caminho)}">${escaparHtml(item.nome)}</button>`,
        )
        .join('')
    }

    const linhas = []
    if (dados.pai) {
      linhas.push(
        `<button type="button" class="pastas__item" data-pasta="${escaparHtml(dados.pai)}">${traco('seta', 15)}<span>Subir um nível</span></button>`,
      )
    }
    for (const pasta of dados.pastas ?? []) {
      linhas.push(
        `<button type="button" class="pastas__item" data-pasta="${escaparHtml(pasta.caminho)}">${traco('pasta', 15)}<span>${escaparHtml(pasta.nome)}</span></button>`,
      )
    }
    pastasLista.innerHTML =
      linhas.join('') || '<p class="folha__vazio">Esta pasta não tem subpastas.</p>'
  } catch {
    pastasLista.innerHTML =
      '<p class="folha__vazio">Não consegui ler as pastas do PC. Confira a conexão.</p>'
  }
}

async function usarPastaAtual() {
  if (!pastaAtual || !pastasUsar) return
  const rotulo = pastasUsar.textContent
  pastasUsar.disabled = true
  pastasUsar.textContent = 'Abrindo…'
  try {
    const resposta = await abrirFluxo('/api/projects', {
      method: 'POST',
      headers: cabecalhos(),
      body: JSON.stringify({ caminho: pastaAtual }),
    })
    if (!resposta.ok) {
      let detalhe = ''
      try {
        const corpo = await resposta.json()
        detalhe = corpo?.detail ?? ''
      } catch {
        /* corpo vazio */
      }
      throw new Error(detalhe || `o PC respondeu ${resposta.status}`)
    }
    aplicarEstadoDeProjetos(await resposta.json())
    fecharTelas()
    renderizarConfig()
  } catch (erro) {
    pastasLista?.insertAdjacentHTML(
      'afterbegin',
      `<p class="aviso-cache">${escaparHtml(erro.message)}</p>`,
    )
  } finally {
    pastasUsar.disabled = false
    pastasUsar.textContent = rotulo
  }
}

/* --- cliques das telas novas --------------------------------------------- */

document.addEventListener('click', (evento) => {
  const apagar = evento.target.closest('[data-apagar-conversa]')
  if (apagar) {
    void apagarConversa(apagar.dataset.apagarConversa)
    return
  }

  const conversaAlvo = evento.target.closest('[data-conversa]')
  if (conversaAlvo) {
    void abrirConversa(conversaAlvo.dataset.conversa)
    return
  }

  const config = evento.target.closest('[data-config]')
  if (config) {
    abrirConfigOpcao(config.dataset.config)
    return
  }

  const interruptor = evento.target.closest('[data-toggle-config]')
  if (interruptor) {
    alternarConfig(interruptor)
    return
  }

  const testar = evento.target.closest('[data-testar-provedor]')
  if (testar) {
    void testarProvedor(testar.dataset.testarProvedor, testar)
    return
  }

  const provedor = evento.target.closest('[data-provedor]')
  if (provedor) {
    void abrirProvedorDetalhe(provedor.dataset.provedor)
    return
  }

  const pasta = evento.target.closest('[data-pasta]')
  if (pasta) {
    void carregarPastas(pasta.dataset.pasta)
  }
})

/* ------------------------------------------------------------------------- */
/* Entrada: ler o QR ou digitar endereço/código                              */
/* ------------------------------------------------------------------------- */

const entrada = document.getElementById('entrada')
const entradaErro = document.getElementById('entrada-erro')
const entradaCamera = document.getElementById('entrada-camera')
const entradaVideo = document.getElementById('entrada-video')
const entradaLerQr = document.getElementById('entrada-ler-qr')
const entradaRede = document.getElementById('entrada-rede')
const entradaCancelar = document.getElementById('entrada-cancelar')
const entradaUrl = document.getElementById('entrada-url')
const entradaCodigo = document.getElementById('entrada-codigo')
const entradaApiUrl = document.getElementById('entrada-api-url')
const entradaApiToken = document.getElementById('entrada-api-token')
let entradaIniciada = false

/*
 * O APK abre esta página com `#pc=<endereço que falhou>` quando a sala não
 * carrega (túnel caído). A entrada já vem com o endereço preenchido — antes,
 * o app mostrava uma tela nativa vazia e a pessoa tinha de colar tudo de novo.
 */
const enderecoQueFalhou = parametrosDoLink.get('pc') ?? ''

function erroDaEntrada(mensagem) {
  if (!entradaErro) return
  entradaErro.textContent = mensagem ?? ''
  entradaErro.hidden = !mensagem
}

function navegarPara(alvo) {
  const destino = new URL(alvo, location.href)
  // O APK guarda o último endereço para reabrir a sala sozinho. A troca de
  // `#`/`reload` não passa pelo `shouldOverrideUrlLoading`, então avisa aqui.
  if (destino.hash.includes('sala=')) {
    try {
      window.KodaAndroid?.guardarEndereco?.(destino.href)
    } catch {
      /* não é o APK */
    }
  }
  const mesmaPagina =
    destino.origin === location.origin && destino.pathname === location.pathname
  if (mesmaPagina) {
    // Trocar só o `#` não recarrega a página, e o link é lido no carregamento.
    location.hash = destino.hash
    location.reload()
  } else {
    location.assign(destino.href)
  }
}

/**
 * Sala morta ou PC inalcançável: para de insistir e devolve a tela de entrada.
 *
 * Sem isto, o `onclose` reabria a conexão para sempre e o celular ficava em
 * «Reconectando ao seu Koda…», sem renovar o código nem voltar para o login.
 * O `#` sai da URL para um recarregamento não tentar entrar na sala morta.
 */
function voltarParaEntrada(mensagem) {
  if (!entrada) return
  if (link) {
    link.parado = true
    try {
      link.ws?.close()
    } catch {
      /* socket já fechou */
    }
    link.ws = null
    link.pareado = false
    link.aberto = null
    for (const pendente of link.pendentes.values()) {
      pendente.falhar(new Error('a conexão com o PC foi encerrada'))
    }
    link.pendentes.clear()
    if (LINK?.sala) {
      try {
        localStorage.removeItem(`koda-link:${LINK.sala}`)
        localStorage.removeItem('koda-link:atual')
      } catch {
        /* nada guardado */
      }
    }
  }
  // O APK guarda o último endereço para reabrir sozinho. Ao sair, ele precisa
  // esquecer esse endereço — senão o próximo abrir voltava para a sala morta.
  try {
    window.KodaAndroid?.esquecerEndereco?.()
  } catch {
    /* não é o APK */
  }
  try {
    controlador?.abort()
  } catch {
    /* nenhuma rodada em andamento */
  }
  history.replaceState(null, '', location.pathname)
  // Histórico, configuração ou folha abertas não podem ficar por baixo da entrada.
  fecharFolha()
  fecharTelas()
  document.body.dataset.tela = 'entrada'
  esconderLink()
  iniciarEntrada()
  erroDaEntrada(mensagem)
}

/**
 * Aceita `host`, `host:porta`, `http://host` e o link inteiro do QR. Sem
 * esquema, IP de casa vira `http://` e o resto vira `https://`.
 */
function interpretarEndereco(texto) {
  let bruto = String(texto ?? '').trim()
  if (!bruto) throw new Error('Informe o endereço.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(bruto)) {
    const local = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(bruto)
    bruto = `${local ? 'http' : 'https'}://${bruto}`
  }
  let url
  try {
    url = new URL(bruto)
  } catch {
    throw new Error('Endereço inválido. Confira o que veio depois do QR.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Use um endereço http:// ou https://.')
  }
  const parametros = new URLSearchParams(url.hash.replace(/^#/, ''))
  const sala = parametros.get('sala')
  if (sala) {
    return {
      link: `${url.origin}${url.pathname}#sala=${encodeURIComponent(sala)}&codigo=${encodeURIComponent(parametros.get('codigo') ?? '')}`,
      sala,
      codigo: parametros.get('codigo') ?? '',
    }
  }
  let base = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  base = base.replace(/\/mobile$/i, '')
  return { base, sala: null, codigo: null }
}

function entrarPeloLink() {
  const dados = interpretarEndereco(entradaUrl?.value)
  if (dados.sala) {
    if (!dados.codigo) throw new Error('O link não tem o código do QR.')
    navegarPara(dados.link)
    return
  }
  const codigo = String(entradaCodigo?.value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
  const partes = codigo.match(/^([0-9A-F]{12})[-_]([0-9A-Z]{8})$/)
  if (!partes) {
    throw new Error('No código, use sala-código, como aparece embaixo do QR no PC.')
  }
  navegarPara(
    `${dados.base}/mobile/#sala=${partes[1].toLowerCase()}&codigo=${partes[2]}`,
  )
}

function entrarPelaApi() {
  const dados = interpretarEndereco(entradaApiUrl?.value)
  const token = String(entradaApiToken?.value ?? '').trim()
  if (dados.sala) throw new Error('Na API direta, informe só o endereço do backend.')
  if (!token) throw new Error('Informe o token da API deste PC.')
  try {
    localStorage.setItem('koda-api', JSON.stringify({ url: dados.base, token }))
    // A API direta substitui o link: a sala antiga não pode voltar no próximo abrir.
    localStorage.removeItem('koda-link:atual')
    try {
      window.KodaAndroid?.esquecerEndereco?.()
    } catch {
      /* não é o APK */
    }
  } catch {
    throw new Error('Não consegui salvar os dados neste navegador.')
  }
  location.reload()
}

let cameraDaEntrada = null

function pararCameraDaEntrada() {
  if (!cameraDaEntrada) return
  for (const trilha of cameraDaEntrada.getTracks()) trilha.stop()
  cameraDaEntrada = null
  if (entradaVideo) entradaVideo.srcObject = null
  if (entradaCamera) entradaCamera.hidden = true
}

/*
 * O APK do Android injeta `window.KodaAndroid`; quando o WebView não tem o
 * BarcodeDetector, o botão «Ler QR» abre o leitor nativo e volta por aqui.
 */
window.kodaQrLido = (texto) => {
  erroDaEntrada('')
  try {
    navegarPara(String(texto ?? '').trim())
  } catch {
    erroDaEntrada('O QR não tem um endereço válido do Koda.')
  }
}

async function lerQrDaEntrada() {
  erroDaEntrada('')
  if (window.KodaAndroid?.lerQr) {
    window.KodaAndroid.lerQr()
    return
  }
  const Detector = window.BarcodeDetector
  if (!Detector || !navigator.mediaDevices?.getUserMedia) {
    erroDaEntrada(
      'Este navegador não lê QR pela câmera. Cole o endereço e o código abaixo.',
    )
    return
  }
  try {
    cameraDaEntrada = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
    entradaVideo.srcObject = cameraDaEntrada
    entradaCamera.hidden = false
    await entradaVideo.play()
  } catch {
    pararCameraDaEntrada()
    erroDaEntrada('Não consegui abrir a câmera. Dê permissão ou cole o código abaixo.')
    return
  }

  const detector = new Detector({ formats: ['qr_code'] })
  const procurar = async () => {
    if (!cameraDaEntrada) return
    try {
      const achados = await detector.detect(entradaVideo)
      const achado = achados.find((item) => item.rawValue)
      if (achado) {
        pararCameraDaEntrada()
        try {
          navegarPara(achado.rawValue)
        } catch {
          erroDaEntrada('Esse QR não parece um link do Koda. Tente o do PC de novo.')
        }
        return
      }
    } catch {
      /* o vídeo ainda não tem um quadro legível */
    }
    setTimeout(procurar, 250)
  }
  setTimeout(procurar, 250)
}

/* ------------------------------------------------------------------------- */
/* Rede local: achar o PC sem QR, URL ou chave                               */
/* ------------------------------------------------------------------------- */

/**
 * Os endereços desta rede que o WebView consegue enxergar.
 *
 * O WebRTC entrega o IP local em muitas versões do Android; quando ele esconde o
 * IP atrás de um nome `.local`, o nome também serve. Sem nenhum dos dois, a busca
 * cai no próprio host da página (quando ela veio do PC).
 */
function candidatosDaRede() {
  return new Promise((resolve) => {
    const vistos = new Set()
    let fechado = false
    let conexao = null
    const terminar = () => {
      if (fechado) return
      fechado = true
      try {
        conexao?.close()
      } catch {
        /* já fechou */
      }
      resolve([...vistos])
    }
    try {
      conexao = new RTCPeerConnection({ iceServers: [] })
    } catch {
      terminar()
      return
    }
    conexao.createDataChannel('koda')
    conexao.onicecandidate = (evento) => {
      const texto = evento?.candidate?.candidate ?? ''
      const ip = texto.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
      const nome = texto.match(/([a-z0-9-]+\.local)/i)
      if (ip) vistos.add(ip[1])
      else if (nome) vistos.add(nome[1])
    }
    conexao
      .createOffer()
      .then((oferta) => conexao.setLocalDescription(oferta))
      .catch(terminar)
    setTimeout(terminar, 1500)
  })
}

function comPrazo(promessa, ms) {
  return Promise.race([
    promessa,
    new Promise((_, rejeitar) => {
      setTimeout(() => rejeitar(new Error('tempo esgotado')), ms)
    }),
  ])
}

async function sondarKoda(host, porta = 8798, prazo = 900) {
  try {
    const resposta = await comPrazo(
      fetch(`http://${host}:${porta}/api/rede`, {
        headers: { 'x-koda-rede': '1' },
        cache: 'no-store',
      }),
      prazo,
    )
    if (!resposta.ok) return null
    const dados = await resposta.json()
    if (!dados?.koda) return null
    // A porta real vem na resposta: se a 8798 estava ocupada no PC, o link
    // subiu numa vizinha e é este número que vale daqui para a frente.
    const real = Number(dados?.porta)
    return { host, porta: Number.isFinite(real) && real > 0 ? real : porta, dados }
  } catch {
    return null
  }
}

/** As faixas domésticas mais comuns, para quando o WebView esconde o IPv4 local. */
const FAIXAS_COMUNS = ['192.168.1', '192.168.0', '192.168.2', '10.0.0', '10.0.1']

async function procurarKodaNaRede() {
  const candidatos = new Set()
  if (location.protocol === 'http:' && location.hostname) {
    candidatos.add(location.hostname)
  }
  for (const achado of await candidatosDaRede()) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(achado)) {
      const prefixo = achado.split('.').slice(0, 3).join('.')
      for (let n = 1; n <= 254; n += 1) candidatos.add(`${prefixo}.${n}`)
    } else {
      candidatos.add(achado)
    }
  }
  const principais = [...candidatos]

  // O Chrome esconde o IPv4 local atrás de um nome `.local` (mDNS) ou entrega
  // só IPv6. Aí a varredura ficava sem nenhum endereço e não achava o PC nem na
  // mesma rede — o caso do PC no cabo, que continua na mesma rede do Wi-Fi.
  // As faixas comuns entram como plano B, sem repetir os hosts já conhecidos.
  const comuns = []
  for (const faixa of FAIXAS_COMUNS) {
    for (let n = 1; n <= 254; n += 1) {
      const ip = `${faixa}.${n}`
      if (!candidatos.has(ip)) comuns.push(ip)
    }
  }

  /** Uma passada por uma lista de hosts, tentando as portas na ordem. */
  const varrer = async (lista, portas, prazo) => {
    const achados = []
    let proximo = 0
    const trabalhadores = Array.from(
      { length: Math.min(64, lista.length) },
      async () => {
        while (proximo < lista.length) {
          const host = lista[proximo]
          proximo += 1
          for (const porta of portas) {
            const achado = await sondarKoda(host, porta, prazo)
            if (achado) {
              achados.push(achado)
              break
            }
          }
        }
      },
    )
    await Promise.all(trabalhadores)
    return achados
  }

  /**
   * Completa os achados com a porta vizinha que estiver com a entrada ligada.
   *
   * A 8798 pode ser uma execução anterior do Koda (o app antigo ainda aberto)
   * enquanto a versão nova subiu o link na 8799. A tela do celular escolhe o
   * achado com `rede_local` ligado, mas para isso ele precisa estar na lista.
   */
  const comVizinhosLigados = async (achados) => {
    const resultado = [...achados]
    for (const achado of achados) {
      if (achado.dados?.rede_local) continue
      const vizinhos = await varrer(
        [achado.host],
        [8799, 8800, 8801, 8802, 8803],
        450,
      )
      for (const vizinho of vizinhos) {
        if (
          !resultado.some(
            (item) => item.host === vizinho.host && item.porta === vizinho.porta,
          )
        ) {
          resultado.push(vizinho)
        }
      }
    }
    return resultado
  }

  // 1) A rede do próprio celular (quando o WebRTC entrega o IP) e o host da página.
  const achados = await varrer(principais, [8798], 800)
  if (achados.length > 0) return comVizinhosLigados(achados)
  // 2) As faixas domésticas comuns. O PC no cabo está na mesma rede do Wi-Fi;
  //    o que faltava era um endereço para procurar. Prazo curto: na LAN quem
  //    responde leva poucos milissegundos, e quem não existe estoura rápido.
  const achadosComuns = await varrer(comuns, [8798], 300)
  if (achadosComuns.length > 0) return comVizinhosLigados(achadosComuns)
  // 3) A 8798 podia estar ocupada no PC (outra execução, outro programa): o link
  //    sobe numa vizinha livre. Procura nessas portas na rede do celular.
  return varrer(principais, [8799, 8800, 8801, 8802, 8803], 450)
}

async function entrarPelaRedeLocal() {
  erroDaEntrada('')
  if (!entradaRede) return
  // A página do APK é servida em `https://appassets.androidplatform.net`, mas o
  // WebView libera conteúdo misto — e a ponte nativa existe. Só o navegador
  // aberto num link https (túnel) não consegue varrer a rede local.
  if (location.protocol === 'https:' && !window.KodaAndroid) {
    erroDaEntrada(
      'A busca na rede local precisa da página do PC na Wi-Fi ou do APK. Abra o Koda pelo endereço da rede local.',
    )
    return
  }
  const rotulo = entradaRede.querySelector('span')
  const antes = rotulo?.textContent ?? ''
  entradaRede.disabled = true
  if (rotulo) rotulo.textContent = 'Procurando o Koda nesta rede…'
  try {
    const achados = await procurarKodaNaRede()
    const ligado = achados.find((item) => item.dados.rede_local)
    if (!ligado) {
      throw new Error(
        achados.length
          ? 'Achei o PC, mas a entrada pela rede local está desligada nele. No Koda do PC, abra Celular → Mesma Wi-Fi e ligue «Entrada pela rede local».'
          : 'Não achei o Koda nesta rede. Confira se o PC está na mesma rede (Wi-Fi ou cabo) e se a entrada pela rede local está ligada no Koda do PC.',
      )
    }
    const resposta = await comPrazo(
      fetch(`http://${ligado.host}:${ligado.porta}/api/rede/entrar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-koda-rede': '1' },
      }),
      8000,
    )
    let corpo = null
    try {
      corpo = await resposta.json()
    } catch {
      /* sem JSON */
    }
    if (!resposta.ok) {
      throw new Error(corpo?.detail || `o PC recusou a entrada (${resposta.status})`)
    }
    if (!corpo?.url) throw new Error('O PC não devolveu o endereço da sala.')
    navegarPara(corpo.url)
  } catch (erro) {
    erroDaEntrada(
      erro instanceof Error ? erro.message : 'Não consegui entrar pela rede local.',
    )
  } finally {
    entradaRede.disabled = false
    if (rotulo) rotulo.textContent = antes
  }
}

function trocarAbaDaEntrada(qual) {
  for (const aba of document.querySelectorAll('[data-entrada-aba]')) {
    const ativa = aba.dataset.entradaAba === qual
    aba.classList.toggle('entrada__aba--ativa', ativa)
    aba.setAttribute('aria-selected', String(ativa))
  }
  for (const painel of document.querySelectorAll('[data-entrada-painel]')) {
    painel.hidden = painel.dataset.entradaPainel !== qual
  }
  erroDaEntrada('')
}

function iniciarEntrada() {
  if (!entrada) return
  entrada.hidden = false
  // Pode ser chamada de novo quando uma sala morre; os ouvintes entram uma vez.
  if (entradaIniciada) return
  entradaIniciada = true
  entradaLerQr?.addEventListener('click', () => void lerQrDaEntrada())
  entradaRede?.addEventListener('click', () => void entrarPelaRedeLocal())
  entradaCancelar?.addEventListener('click', pararCameraDaEntrada)
  for (const aba of document.querySelectorAll('[data-entrada-aba]')) {
    aba.addEventListener('click', () => trocarAbaDaEntrada(aba.dataset.entradaAba))
  }
  document.getElementById('entrada-link')?.addEventListener('submit', (evento) => {
    evento.preventDefault()
    try {
      entrarPeloLink()
      erroDaEntrada('')
    } catch (erro) {
      erroDaEntrada(erro instanceof Error ? erro.message : 'Não consegui entrar.')
    }
  })
  document.getElementById('entrada-api')?.addEventListener('submit', (evento) => {
    evento.preventDefault()
    try {
      entrarPelaApi()
      erroDaEntrada('')
    } catch (erro) {
      erroDaEntrada(erro instanceof Error ? erro.message : 'Não consegui entrar.')
    }
  })
  if (enderecoQueFalhou && entradaUrl && !entradaUrl.value) {
    entradaUrl.value = enderecoQueFalhou
    erroDaEntrada(
      'Não consegui abrir essa sala. Confira se o túnel do PC ainda está aberto e tente de novo, ou leia um QR novo.',
    )
  }
}

/* ------------------------------------------------------------------------- */
/* Navegador: sites, arquivos e hosts do PC                                  */
/* ------------------------------------------------------------------------- */

const navegadorUrl = document.querySelector('#navegador-url')
const navegadorForm = document.querySelector('#navegador-form')
const navegadorEstado = document.querySelector('#navegador-estado')
const navegadorTela = document.querySelector('#navegador-tela')
const navegadorQuadro = document.querySelector('#navegador-quadro')
const navegadorEscala = document.querySelector('#navegador-escala')
const navegadorPalco = document.querySelector('#navegador-palco')
const navegadorEscalaTexto = document.querySelector('#navegador-escala-texto')
const navegadorInicio = document.querySelector('#navegador-inicio')
const navegadorHosts = document.querySelector('#navegador-hosts')
const navegadorArquivos = document.querySelector('#navegador-arquivos')
const navegadorCaminho = document.querySelector('#navegador-caminho')
const navegadorSubir = document.querySelector('#navegador-subir')
const navegadorAtualizar = document.querySelector('#navegador-atualizar')
const navegadorRecarregar = document.querySelector('#navegador-recarregar')
const navegadorExterno = document.querySelector('#navegador-externo')
const navegadorVoltar = document.querySelector('#navegador-voltar')
const navegadorCortina = document.querySelector('#navegador-cortina')
const navegadorCortinaTexto = document.querySelector('#navegador-cortina-texto')
const navegadorCortinaAcao = document.querySelector('#navegador-cortina-acao')

/*
 * O quadro tem o tamanho de verdade do aparelho escolhido e é reduzido com
 * `transform`. É isso que faz as media queries da página responderem a 390px
 * (celular em pé), 844px (deitado) e 1280px (PC), mesmo numa tela de 375px.
 */
const NAVEGADOR_MODOS = {
  pe: { largura: 390, altura: 844 },
  deitado: { largura: 844, altura: 390 },
  pc: { largura: 1280, altura: 800 },
}
const NAVEGADOR_EXTENSOES =
  /\.(md|markdown|txt|log|json|ya?ml|toml|ini|csv|tsv|pdf|png|jpe?g|gif|webp|svg|bmp|ico|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|c|h|cpp|sh|zip)$/i
const NAVEGADOR_IMAGENS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

function lerDoNavegador(chave) {
  try {
    return localStorage.getItem(chave) ?? ''
  } catch {
    return ''
  }
}

let navegadorModo = lerDoNavegador('koda-navegador-modo') || 'pe'
if (!NAVEGADOR_MODOS[navegadorModo]) navegadorModo = 'pe'
let navegadorEndereco = lerDoNavegador('koda-navegador-endereco')
let navegadorPasta = ''
let navegadorPdf = null
let navegadorUrlAtual = ''
let navegadorTemPagina = false
let navegadorDocumento = false
let navegadorPedidoDeAjuste = 0
let navegadorAvisoDemora = 0
let navegadorAvisoTrava = 0

function esconderCortinaDoNavegador() {
  clearTimeout(navegadorAvisoDemora)
  clearTimeout(navegadorAvisoTrava)
  if (navegadorCortina) navegadorCortina.hidden = true
}

function mostrarCortinaDoNavegador() {
  if (!navegadorCortina) return
  clearTimeout(navegadorAvisoDemora)
  clearTimeout(navegadorAvisoTrava)
  navegadorCortina.hidden = false
  if (navegadorCortinaTexto) navegadorCortinaTexto.textContent = 'Abrindo…'
  if (navegadorCortinaAcao) navegadorCortinaAcao.hidden = true
  // A primeira abertura de um host de desenvolvimento compila e resolve centenas de
  // módulos: avisar é melhor do que deixar a pessoa olhando uma tela branca sem saber
  // se travou.
  navegadorAvisoDemora = setTimeout(() => {
    if (navegadorCortinaTexto) {
      navegadorCortinaTexto.textContent =
        'Ainda carregando… o primeiro acesso a um host pode demorar.'
    }
  }, 6000)
  navegadorAvisoTrava = setTimeout(() => {
    if (navegadorCortinaTexto) {
      navegadorCortinaTexto.textContent =
        'Está demorando mais que o normal. O host pode estar ocupado ou fora do ar.'
    }
    if (navegadorCortinaAcao) navegadorCortinaAcao.hidden = false
  }, 30000)
}

function ajustarNavegador() {
  const modo = NAVEGADOR_MODOS[navegadorModo] ?? NAVEGADOR_MODOS.pe
  if (navegadorQuadro) {
    navegadorQuadro.dataset.modo = navegadorDocumento ? 'documento' : navegadorModo
    navegadorQuadro.style.width = `${modo.largura}px`
    navegadorQuadro.style.height = `${modo.altura}px`
  }
  for (const botao of document.querySelectorAll('.navegador__modo')) {
    const ativo = botao.dataset.modo === navegadorModo
    botao.classList.toggle('navegador__modo--ativo', ativo)
    botao.setAttribute('aria-pressed', String(ativo))
  }
  if (!navegadorPalco || !navegadorQuadro || !navegadorEscala || !telaNavegador) return
  if (telaNavegador.hidden || navegadorPalco.hidden) {
    if (navegadorEscalaTexto) navegadorEscalaTexto.textContent = ''
    return
  }
  const caixa = navegadorPalco.getBoundingClientRect()
  const largura = Math.max(120, caixa.width - 24)
  const altura = Math.max(120, caixa.height - 24)
  if (navegadorDocumento) {
    // Arquivo não tem tamanho de aparelho: ocupa o palco inteiro, senão um PDF
    // em «Em pé» apareceria a 45% e ninguém leria.
    navegadorQuadro.style.width = `${largura}px`
    navegadorQuadro.style.height = `${altura}px`
    navegadorQuadro.style.transform = 'none'
    navegadorEscala.style.width = `${largura}px`
    navegadorEscala.style.height = `${altura}px`
    if (navegadorEscalaTexto) navegadorEscalaTexto.textContent = ''
    return
  }
  const fator = Math.max(
    0.1,
    Math.min(largura / modo.largura, altura / modo.altura, 1),
  )
  navegadorQuadro.style.transform = `scale(${fator})`
  navegadorEscala.style.width = `${Math.round(modo.largura * fator)}px`
  navegadorEscala.style.height = `${Math.round(modo.altura * fator)}px`
  if (navegadorEscalaTexto) {
    navegadorEscalaTexto.textContent = fator < 0.995 ? `${Math.round(fator * 100)}%` : ''
  }
}

function pedirAjusteDoNavegador() {
  cancelAnimationFrame(navegadorPedidoDeAjuste)
  navegadorPedidoDeAjuste = requestAnimationFrame(ajustarNavegador)
}

function mostrarPaginaDoNavegador(mostrar) {
  navegadorTemPagina = mostrar
  if (navegadorInicio) navegadorInicio.hidden = mostrar
  if (navegadorPalco) navegadorPalco.hidden = !mostrar
  if (!mostrar) esconderCortinaDoNavegador()
  if (mostrar) pedirAjusteDoNavegador()
}

function urlDoHostDoNavegador(porta, caminho = '/') {
  const sufixo = caminho.startsWith('/') ? caminho : `/${caminho}`
  if (link) {
    if (!link.sessao) throw new Error('o celular ainda não entrou na sala do PC')
    return `${location.origin}/navegador/${encodeURIComponent(link.sessao)}/${porta}${sufixo}`
  }
  if (!TOKEN) throw new Error('o token da API não está configurado neste celular')
  return `${API}/navegador/proxy/${encodeURIComponent(TOKEN)}/${porta}${sufixo}`
}

function urlDoArquivoDoNavegador(caminho, tipo = 'arquivo') {
  const parametros = new URLSearchParams({
    base: estado.projetoCaminho ?? '',
    caminho,
  })
  if (link) {
    if (!link.sessao) throw new Error('o celular ainda não entrou na sala do PC')
    return `${location.origin}/navegador/${tipo}/${encodeURIComponent(link.sessao)}?${parametros}`
  }
  return `${API}/api/navegador/${tipo}?${parametros}`
}

async function pedirArquivoDoNavegador(caminho, tipo = 'arquivo') {
  const url = urlDoArquivoDoNavegador(caminho, tipo)
  const resposta = await fetch(url, link ? {} : { headers: cabecalhos(false) })
  if (!resposta.ok) {
    let detalhe = ''
    try {
      detalhe = (await resposta.json())?.detail ?? ''
    } catch {
      /* resposta sem JSON: fica o status */
    }
    throw new Error(detalhe || `o PC respondeu ${resposta.status}`)
  }
  return resposta
}

function urlDaPaginaPdf(caminho, pagina) {
  const parametros = new URLSearchParams({
    base: estado.projetoCaminho ?? '',
    caminho,
    pagina: String(pagina),
  })
  if (link) {
    if (!link.sessao) throw new Error('o celular ainda não entrou na sala do PC')
    return `${location.origin}/navegador/pdf/${encodeURIComponent(link.sessao)}?${parametros}`
  }
  return `${API}/api/navegador/pdf?${parametros}`
}

async function pedirPaginaPdf(caminho, pagina) {
  const url = urlDaPaginaPdf(caminho, pagina)
  const resposta = await fetch(url, link ? {} : { headers: cabecalhos(false) })
  if (!resposta.ok) {
    let detalhe = ''
    try {
      detalhe = (await resposta.json())?.detail ?? ''
    } catch {
      /* idem */
    }
    throw new Error(detalhe || `o PC respondeu ${resposta.status}`)
  }
  return resposta
}

function hostLocalDoNavegador(url) {
  const nome = url.hostname.toLowerCase()
  return nome === 'localhost' || nome === '127.0.0.1' || nome === '0.0.0.0' || nome === '::1'
}

function interpretarEnderecoDoNavegador(bruto) {
  const texto = String(bruto ?? '').trim()
  if (!texto) return null
  if (/^https?:\/\//i.test(texto)) {
    try {
      const url = new URL(texto)
      if (hostLocalDoNavegador(url)) {
        return {
          tipo: 'host',
          porta: Number(url.port || 80),
          caminho: `${url.pathname}${url.search}` || '/',
        }
      }
      return { tipo: 'site', url: url.href }
    } catch {
      return null
    }
  }
  if (/^:\d{1,5}$/.test(texto)) {
    return { tipo: 'host', porta: Number(texto.slice(1)), caminho: '/' }
  }
  const local = texto.match(
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(\/.*)?$/i,
  )
  if (local) {
    return {
      tipo: 'host',
      porta: Number(local[2] || 80),
      caminho: local[3] || '/',
    }
  }
  if (texto.startsWith('/') || texto.startsWith('./') || texto.startsWith('../')) {
    return { tipo: 'arquivo', caminho: texto.replace(/^\.?\//, '') }
  }
  if (NAVEGADOR_EXTENSOES.test(texto) && !/\s/.test(texto)) {
    return { tipo: 'arquivo', caminho: texto.replace(/^\.?\//, '') }
  }
  if (/^[^\s/]+\.[^\s/]+/.test(texto)) {
    return { tipo: 'site', url: `https://${texto}` }
  }
  return { tipo: 'arquivo', caminho: texto }
}

function criarIframeDoNavegador(url) {
  const quadro = document.createElement('iframe')
  quadro.className = 'navegador__iframe'
  quadro.referrerPolicy = 'no-referrer'
  // `allow-same-origin` devolve cookies e storage ao site, que continua sendo
  // outra origem — não alcança a página do Koda. Sem ele, quase todo site com
  // login abriria quebrado.
  quadro.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
  )
  quadro.addEventListener(
    'load',
    () => {
      // Uma página de erro de rede também dispara `load`; a cortina sai para não cobrir
      // o conteúdo quando ele chegou, e o botão de recarregar cobre o caso de falha.
      setTimeout(esconderCortinaDoNavegador, 200)
    },
    { once: true },
  )
  navegadorTela.append(quadro)
  mostrarCortinaDoNavegador()
  // `src` depois do append: assim o `load` nunca chega antes do ouvinte.
  quadro.src = url
}

function mostrarErroDoNavegador(mensagem) {
  if (!navegadorTela) return
  const aviso = document.createElement('p')
  aviso.className = 'navegador__erro'
  aviso.textContent = mensagem
  navegadorTela.replaceChildren(aviso)
  if (navegadorEstado) navegadorEstado.textContent = 'Não abriu'
}

async function abrirEnderecoDoNavegador(bruto) {
  const destino = interpretarEnderecoDoNavegador(bruto)
  if (!destino) {
    mostrarErroDoNavegador(
      'Endereço inválido. Tente exemplo.com, localhost:3000 ou README.md.',
    )
    return
  }
  navegadorEndereco = String(bruto ?? '').trim()
  if (navegadorUrl) navegadorUrl.value = navegadorEndereco
  try {
    localStorage.setItem('koda-navegador-endereco', navegadorEndereco)
  } catch {
    /* memória cheia: o endereço vale só nesta sessão */
  }
  navegadorDocumento = false
  mostrarPaginaDoNavegador(true)
  navegadorTela.replaceChildren()
  liberarPdfDoNavegador()
  navegadorUrlAtual = ''
  if (destino.tipo === 'site') {
    navegadorUrlAtual = destino.url
    if (navegadorEstado) navegadorEstado.textContent = destino.url
    criarIframeDoNavegador(destino.url)
    return
  }
  if (destino.tipo === 'host') {
    try {
      const url = urlDoHostDoNavegador(destino.porta, destino.caminho)
      navegadorUrlAtual = url
      if (navegadorEstado) {
        navegadorEstado.textContent = `localhost:${destino.porta}${destino.caminho}`
      }
      criarIframeDoNavegador(url)
    } catch (erro) {
      mostrarErroDoNavegador(
        erro instanceof Error ? erro.message : 'não consegui abrir esse host',
      )
    }
    return
  }
  await abrirArquivoNoNavegador(destino.caminho)
}

async function abrirArquivoNoNavegador(caminho) {
  esconderCortinaDoNavegador()
  const nome = caminho.split('/').pop() || caminho
  const extensao = nome.includes('.') ? nome.split('.').pop().toLowerCase() : ''
  if (navegadorEstado) navegadorEstado.textContent = nome
  try {
    navegadorUrlAtual = urlDoArquivoDoNavegador(caminho)
  } catch {
    navegadorUrlAtual = ''
  }
  navegadorDocumento = true
  pedirAjusteDoNavegador()
  try {
    if (extensao === 'pdf') {
      await mostrarPdfDoNavegador(caminho)
      return
    }
    if (NAVEGADOR_IMAGENS.has(extensao)) {
      await mostrarImagemDoNavegador(caminho)
      return
    }
    if (extensao === 'html' || extensao === 'htm') {
      await mostrarHtmlDoNavegador(caminho)
      return
    }
    const resposta = await pedirArquivoDoNavegador(caminho)
    const tamanho = Number(resposta.headers.get('content-length') ?? 0)
    if (tamanho > 3_000_000) {
      throw new Error('esse arquivo é grande demais para mostrar aqui; use «Abrir fora»')
    }
    const tipo = (resposta.headers.get('content-type') ?? '').toLowerCase()
    const texto = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml))/.test(tipo)
    if (tipo && !texto) {
      mostrarArquivoBinarioDoNavegador(nome, tipo)
      return
    }
    const corpo = await resposta.text()
    const documento = document.createElement('div')
    if (extensao === 'md' || extensao === 'markdown') {
      documento.className = 'navegador__documento'
      renderizarMarkdown(corpo, documento)
    } else {
      documento.className = 'navegador__codigo'
      documento.textContent = corpo
    }
    navegadorTela.append(documento)
  } catch (erro) {
    mostrarErroDoNavegador(
      erro instanceof Error ? erro.message : 'não consegui abrir esse arquivo',
    )
  }
}

function mostrarArquivoBinarioDoNavegador(nome, tipo) {
  const documento = document.createElement('div')
  documento.className = 'navegador__documento navegador__documento--binario'
  documento.innerHTML = `
    <p class="navegador__binario-nome"></p>
    <p class="navegador__binario-tipo"></p>
    <button type="button" class="navegador__binario-abrir">Abrir fora do Koda</button>`
  documento.querySelector('.navegador__binario-nome').textContent = nome
  documento.querySelector('.navegador__binario-tipo').textContent =
    `${tipo || 'arquivo binário'} · sem pré-visualização`
  documento.querySelector('.navegador__binario-abrir').addEventListener('click', () => {
    if (!navegadorUrlAtual) return
    const ancora = document.createElement('a')
    ancora.href = navegadorUrlAtual
    ancora.target = '_blank'
    ancora.rel = 'noopener'
    document.body.append(ancora)
    ancora.click()
    ancora.remove()
  })
  navegadorTela.append(documento)
}

async function mostrarImagemDoNavegador(caminho) {
  const resposta = await pedirArquivoDoNavegador(caminho)
  const blob = await resposta.blob()
  const endereco = URL.createObjectURL(blob)
  const documento = document.createElement('div')
  documento.className = 'navegador__documento'
  documento.style.display = 'grid'
  documento.style.placeItems = 'center'
  documento.style.background = '#1a1a1e'
  const imagem = document.createElement('img')
  imagem.src = endereco
  imagem.alt = caminho.split('/').pop() || 'imagem'
  imagem.addEventListener('load', () => URL.revokeObjectURL(endereco), { once: true })
  documento.append(imagem)
  navegadorTela.append(documento)
}

async function mostrarHtmlDoNavegador(caminho) {
  const resposta = await pedirArquivoDoNavegador(caminho)
  const texto = await resposta.text()
  const quadro = document.createElement('iframe')
  quadro.className = 'navegador__iframe'
  // `srcdoc` sem `allow-same-origin`: o HTML roda isolado da página do Koda.
  quadro.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals')
  quadro.srcdoc = texto
  navegadorTela.append(quadro)
}

async function mostrarPdfDoNavegador(caminho) {
  const parametros = new URLSearchParams({
    base: estado.projetoCaminho ?? '',
    caminho,
  })
  const info = await api(`/api/navegador/pdf/info?${parametros}`)
  const paginas = Number(info?.paginas ?? 0)
  if (!paginas) throw new Error(info?.erro || 'não consegui ler esse PDF')
  navegadorPdf = { caminho, pagina: 1, paginas, endereco: '' }
  const documento = document.createElement('div')
  documento.className = 'navegador__pdf'
  documento.innerHTML = `
    <div class="navegador__pdf-topo">
      <button type="button" id="navegador-pdf-anterior" aria-label="Página anterior">‹</button>
      <span id="navegador-pdf-contagem"></span>
      <button type="button" id="navegador-pdf-proxima" aria-label="Próxima página">›</button>
    </div>
    <div class="navegador__pdf-pagina" id="navegador-pdf-pagina"></div>`
  navegadorTela.append(documento)
  documento
    .querySelector('#navegador-pdf-anterior')
    ?.addEventListener('click', () => mudarPaginaPdf(-1))
  documento
    .querySelector('#navegador-pdf-proxima')
    ?.addEventListener('click', () => mudarPaginaPdf(1))
  await carregarPaginaPdf()
}

async function carregarPaginaPdf() {
  const estadoPdf = navegadorPdf
  if (!estadoPdf) return
  const alvo = document.querySelector('#navegador-pdf-pagina')
  const contagem = document.querySelector('#navegador-pdf-contagem')
  if (!alvo || !contagem) return
  contagem.textContent = `${estadoPdf.pagina} / ${estadoPdf.paginas}`
  const anterior = document.querySelector('#navegador-pdf-anterior')
  const proxima = document.querySelector('#navegador-pdf-proxima')
  if (anterior) anterior.disabled = estadoPdf.pagina <= 1
  if (proxima) proxima.disabled = estadoPdf.pagina >= estadoPdf.paginas
  alvo.innerHTML = '<p class="navegador__carregando">Abrindo página…</p>'
  try {
    const resposta = await pedirPaginaPdf(estadoPdf.caminho, estadoPdf.pagina)
    const blob = await resposta.blob()
    if (navegadorPdf !== estadoPdf) return
    if (estadoPdf.endereco) URL.revokeObjectURL(estadoPdf.endereco)
    estadoPdf.endereco = URL.createObjectURL(blob)
    const imagem = document.createElement('img')
    imagem.src = estadoPdf.endereco
    imagem.alt = `Página ${estadoPdf.pagina} de ${estadoPdf.paginas}`
    alvo.replaceChildren(imagem)
  } catch (erro) {
    alvo.innerHTML = ''
    const aviso = document.createElement('p')
    aviso.className = 'navegador__erro'
    aviso.textContent =
      erro instanceof Error ? erro.message : 'não consegui abrir essa página'
    alvo.append(aviso)
  }
}

function mudarPaginaPdf(delta) {
  if (!navegadorPdf) return
  const nova = navegadorPdf.pagina + delta
  if (nova < 1 || nova > navegadorPdf.paginas) return
  navegadorPdf.pagina = nova
  void carregarPaginaPdf()
}

function liberarPdfDoNavegador() {
  if (navegadorPdf?.endereco) URL.revokeObjectURL(navegadorPdf.endereco)
  navegadorPdf = null
}

async function carregarHostsDoNavegador() {
  if (!navegadorHosts) return
  navegadorHosts.innerHTML = '<p class="navegador__vazio">Procurando…</p>'
  try {
    const dados = await api('/api/navegador/hosts')
    const hosts = Array.isArray(dados?.hosts) ? dados.hosts : []
    if (!hosts.length) {
      navegadorHosts.innerHTML =
        '<p class="navegador__vazio">Nenhum host HTTP respondeu agora. Abra o front, o backend ou o servidor de modelos no PC.</p>'
      return
    }
    const fragmento = document.createDocumentFragment()
    for (const host of hosts) {
      const botao = document.createElement('button')
      botao.type = 'button'
      botao.className = 'navegador__host'
      const ponto = document.createElement('span')
      ponto.className = 'navegador__host-ponto'
      const nome = document.createElement('span')
      nome.textContent = host.rotulo || `Porta ${host.porta}`
      const porta = document.createElement('span')
      porta.className = 'navegador__host-porta'
      porta.textContent = `:${host.porta}`
      botao.append(ponto, nome, porta)
      botao.addEventListener('click', () => {
        void abrirEnderecoDoNavegador(`localhost:${host.porta}`)
      })
      fragmento.append(botao)
    }
    navegadorHosts.replaceChildren(fragmento)
  } catch (erro) {
    navegadorHosts.replaceChildren()
    const aviso = document.createElement('p')
    aviso.className = 'navegador__vazio'
    aviso.textContent =
      erro instanceof Error ? erro.message : 'não consegui listar os hosts do PC'
    navegadorHosts.append(aviso)
  }
}

async function carregarArquivosDoNavegador(caminho = '') {
  if (!navegadorArquivos) return
  navegadorArquivos.innerHTML = '<p class="navegador__vazio">Lendo…</p>'
  const parametros = new URLSearchParams({
    base: estado.projetoCaminho ?? '',
    caminho,
  })
  try {
    const dados = await api(`/api/navegador/arquivos?${parametros}`)
    navegadorPasta = String(dados?.caminho ?? '')
    if (navegadorCaminho) {
      navegadorCaminho.textContent = [dados?.raiz, navegadorPasta]
        .filter(Boolean)
        .join('/')
    }
    if (navegadorSubir) navegadorSubir.hidden = !navegadorPasta
    const itens = Array.isArray(dados?.itens) ? dados.itens : []
    if (!itens.length) {
      navegadorArquivos.innerHTML =
        '<p class="navegador__vazio">Esta pasta está vazia.</p>'
      return
    }
    const fragmento = document.createDocumentFragment()
    for (const item of itens) {
      const botao = document.createElement('button')
      botao.type = 'button'
      botao.className = `navegador__arquivo${item.pasta ? ' navegador__arquivo--pasta' : ''}`
      const icone = document.createElement('span')
      icone.className = 'navegador__arquivo-icone'
      icone.innerHTML = item.pasta ? traco('pasta', 17) : traco('arquivo', 17)
      const nome = document.createElement('span')
      nome.className = 'navegador__arquivo-nome'
      nome.textContent = item.nome
      const tamanho = document.createElement('span')
      tamanho.className = 'navegador__arquivo-tamanho'
      tamanho.textContent = item.pasta ? '' : formatarTamanhoDeArquivo(item.tamanho)
      botao.append(icone, nome, tamanho)
      botao.addEventListener('click', () => {
        if (item.pasta) void carregarArquivosDoNavegador(item.caminho)
        else void abrirEnderecoDoNavegador(item.caminho)
      })
      fragmento.append(botao)
    }
    navegadorArquivos.replaceChildren(fragmento)
  } catch (erro) {
    navegadorArquivos.replaceChildren()
    const aviso = document.createElement('p')
    aviso.className = 'navegador__vazio'
    aviso.textContent =
      erro instanceof Error ? erro.message : 'não consegui ler os arquivos do PC'
    navegadorArquivos.append(aviso)
  }
}

function abrirNavegador() {
  abrirTela(telaNavegador)
  ajustarNavegador()
  if (navegadorTemPagina && navegadorTela?.children.length) {
    pedirAjusteDoNavegador()
    return
  }
  if (navegadorEndereco) {
    void abrirEnderecoDoNavegador(navegadorEndereco)
    return
  }
  mostrarPaginaDoNavegador(false)
  void carregarHostsDoNavegador()
  void carregarArquivosDoNavegador(navegadorPasta)
}

function recarregarNavegador() {
  const iframe = navegadorTela?.querySelector('iframe')
  if (iframe && navegadorUrlAtual) {
    iframe.addEventListener(
      'load',
      () => setTimeout(esconderCortinaDoNavegador, 200),
      { once: true },
    )
    mostrarCortinaDoNavegador()
    iframe.src = navegadorUrlAtual
    return
  }
  if (navegadorEndereco) void abrirEnderecoDoNavegador(navegadorEndereco)
}

function irParaInicioDoNavegador() {
  esconderCortinaDoNavegador()
  if (navegadorTela) navegadorTela.replaceChildren()
  navegadorTemPagina = false
  navegadorDocumento = false
  navegadorUrlAtual = ''
  liberarPdfDoNavegador()
  mostrarPaginaDoNavegador(false)
  if (navegadorEstado) {
    navegadorEstado.textContent = 'Sites, arquivos e hosts do seu PC'
  }
  void carregarHostsDoNavegador()
  void carregarArquivosDoNavegador(navegadorPasta)
}

document.querySelector('#abrir-navegador')?.addEventListener('click', abrirNavegador)
navegadorCortinaAcao?.addEventListener('click', recarregarNavegador)
navegadorVoltar?.addEventListener('click', () => {
  // Voltar dentro do navegador é voltar para a página inicial dele; só a
  // página inicial devolve para a conversa.
  if (navegadorTemPagina) irParaInicioDoNavegador()
  else fecharTelas()
})
navegadorForm?.addEventListener('submit', (evento) => {
  evento.preventDefault()
  void abrirEnderecoDoNavegador(navegadorUrl?.value ?? '')
})
for (const botao of document.querySelectorAll('.navegador__modo')) {
  botao.addEventListener('click', () => {
    navegadorModo = botao.dataset.modo
    try {
      localStorage.setItem('koda-navegador-modo', navegadorModo)
    } catch {
      /* a escolha vale só nesta sessão */
    }
    ajustarNavegador()
  })
}
navegadorAtualizar?.addEventListener('click', () => void carregarHostsDoNavegador())
navegadorRecarregar?.addEventListener('click', recarregarNavegador)
navegadorSubir?.addEventListener('click', () => {
  const partes = navegadorPasta.split('/').filter(Boolean)
  partes.pop()
  void carregarArquivosDoNavegador(partes.join('/'))
})
navegadorExterno?.addEventListener('click', () => {
  if (!navegadorUrlAtual) return
  const ancora = document.createElement('a')
  ancora.href = navegadorUrlAtual
  ancora.target = '_blank'
  ancora.rel = 'noopener'
  document.body.append(ancora)
  ancora.click()
  ancora.remove()
})
window.addEventListener('resize', pedirAjusteDoNavegador)
window.addEventListener('orientationchange', () => {
  setTimeout(ajustarNavegador, 250)
})

/* ------------------------------------------------------------------------- */
/* Início                                                                    */
/* ------------------------------------------------------------------------- */

/* Telas novas: histórico, configuração, pastas e a folha inferior. */
document.querySelector('#abrir-historico')?.addEventListener('click', abrirHistorico)
document.querySelector('#abrir-config')?.addEventListener('click', abrirConfig)
document.querySelector('#botao-novo-chat')?.addEventListener('click', novaConversa)
document.querySelector('#historico-novo')?.addEventListener('click', novaConversa)
historicoBusca?.addEventListener('input', renderizarHistorico)
pastasUsar?.addEventListener('click', () => void usarPastaAtual())
for (const botao of document.querySelectorAll('[data-fechar-tela]')) {
  botao.addEventListener('click', fecharTelas)
}
for (const alvo of document.querySelectorAll('[data-fechar-folha]')) {
  alvo.addEventListener('click', fecharFolha)
}
document.addEventListener('keydown', (evento) => {
  if (evento.key !== 'Escape') return
  if (folha && !folha.hidden) fecharFolha()
  else if (telaNavegador && !telaNavegador.hidden && navegadorTemPagina) {
    irParaInicioDoNavegador()
  } else if (
    [telaHistorico, telaConfig, telaPastas, telaNavegador].some(
      (tela) => tela && !tela.hidden,
    )
  ) {
    fecharTelas()
  }
})

// O que ficou salvo no celular vale já na primeira pintura: os alternadores do
// compositor e o selo do provedor mostram a escolha de ontem, não o padrão.
for (const chave of ['reasoning', 'web']) {
  document
    .querySelector(`[data-toggle="${chave}"]`)
    ?.setAttribute('aria-pressed', String(Boolean(estado[chave])))
}

atualizarGatilhos()
atualizarEnviar()
renderizarAnexos()
medirCompositor()
new ResizeObserver(medirCompositor).observe(compositor)

if (PRECISA_ENTRAR || enderecoQueFalhou) {
  iniciarEntrada()
} else {
  if (link) {
    mostrarLink(link.sessao ? 'Reconectando ao seu Koda…' : 'Conectando ao seu Koda…')
    void conectarLink().catch(() => {})
  }

  // Tudo em paralelo: a conversa restaurada não pode esperar o catálogo inteiro
  // de modelos do PC, que é a parte lenta.
  void carregarModelos()
  void carregarPermissoes()
  void restaurarUltimaConversa()
}
void carregarProjetos()

/*
 * Instalável na tela inicial (PWA). Só em contexto seguro — HTTPS do túnel ou
 * localhost; na Wi-Fi em HTTP o navegador não registra service worker, e o app
 * continua funcionando igual, só sem a instalação.
 */
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* sem service worker o app abre normalmente */
    })
  })
}
