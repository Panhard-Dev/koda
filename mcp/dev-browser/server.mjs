#!/usr/bin/env node
/**
 * MCP `koda-dev-browser` — o navegador do Painel Dev, controlado pela IA.
 *
 * ## O que ele resolve, e por que assim
 *
 * O Painel Dev do Koda mostra página num `<iframe>`. Isso serve para o olho humano, mas
 * **não** para a IA: o navegador proíbe uma página de ler ou clicar no conteúdo de um iframe
 * de outra origem — e `localhost:3000` é outra origem de `localhost:5174`, e arquivo local é
 * outra origem de qualquer coisa. Não é limitação do Koda; é a regra de origem do navegador.
 *
 * Então a automação acontece num **navegador de verdade**, controlado por CDP
 * (Chrome DevTools Protocol). A IA lê o DOM, clica e digita de verdade. E o painel espelha a
 * mesma sessão: este processo escreve o último quadro e o estado em `data/`, e o backend
 * entrega isso para o painel. Uma sessão só — o que a IA faz, você vê.
 *
 * ## Nada é baixado
 *
 * Usa o Chrome ou o Edge **que já está na máquina**. Não baixa Playwright, não instala
 * Chromium, não abre dependência nenhuma: é Node puro, sem `package.json`, sem `npm install`.
 *
 * ## O que ele aceita abrir
 *
 * Qualquer `http`/`https`, arquivo do disco (caminho do Windows ou `file://`) e o atalho
 * `localhost:PORTA`. A trava de "só localhost" foi derrubada a pedido do dono: ele quer que a
 * IA veja **qualquer** site, não só o servidor de dev. O que continua fora são os esquemas que
 * não são navegação (`javascript:`, `data:`), que não abrem página nenhuma e só serviriam para
 * injetar script no que já está aberto.
 *
 * ## Protocolo
 *
 * MCP sobre stdio: um objeto JSON por linha no `stdin`, um por linha no `stdout`. Nada de
 * `Content-Length`. O `stdout` é **só** do protocolo — qualquer diagnóstico vai para o
 * `stderr`, porque uma linha solta no `stdout` é lida como resposta.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------- utilidades

const dormir = (ms) => new Promise((pronto) => setTimeout(pronto, ms))

/** Recado de diagnóstico. Vai para o `stderr` — o `stdout` pertence ao protocolo. */
const log = (...partes) => process.stderr.write(`[dev-browser] ${partes.join(' ')}\n`)

/** Onde ficam `dev-browser.json` e `dev-browser.png`. O backend lê os dois daqui. */
function pastaDeDados() {
  const candidatos = [
    process.env.KODA_DATA_DIR,
    join(process.cwd(), 'data'),
    join(process.cwd(), 'backend', 'data'),
  ].filter(Boolean)
  for (const candidato of candidatos) {
    if (existsSync(candidato)) return candidato
  }
  const criada = candidatos[0]
  mkdirSync(criada, { recursive: true })
  return criada
}

/** Chrome ou Edge já instalado. Nada é baixado. */
function acharNavegador() {
  const candidatos = [
    process.env.KODA_BROWSER,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  return candidatos.find((caminho) => existsSync(caminho)) ?? null
}

/**
 * Um endereço que este MCP aceita: `http`/`https` de **qualquer** host, `localhost:PORTA` sem
 * esquema, ou arquivo do disco.
 *
 * Antes só passava `localhost`/`127.0.0.1` e arquivo — o dono derrubou essa trava: ele quer que
 * a IA veja qualquer site, não só o servidor de dev. Quem fica de fora são os esquemas que não
 * são navegação (`javascript:`, `data:`, `about:`): não abrem página e só serviriam para
 * injetar script no que já está aberto.
 */
function enderecoAceito(valor) {
  const bruto = String(valor ?? '').trim()
  if (!bruto) return { ok: false, motivo: 'endereço vazio' }

  // O caso normal, e o único que o modelo precisa acertar: a URL inteira.
  if (/^https?:\/\/\S+$/i.test(bruto)) {
    return { ok: true, url: bruto }
  }

  // Caminho do disco. Vem **antes** do atalho de host sem esquema: senão `C:/x/index.html`
  // viraria `https://C:/x/index.html`.
  const arquivo = caminhoDeArquivo(bruto)
  if (arquivo) return { ok: true, url: paraUrlDeArquivo(arquivo), arquivo }

  // `localhost:5173/...` sem esquema — servidor de dev é sempre http, não https.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(bruto)) {
    return { ok: true, url: `http://${bruto}` }
  }

  // `exemplo.com` sem esquema. A última etiqueta tem de parecer um domínio e **não** uma
  // extensão de arquivo: senão `index.html` viraria `https://index.html`, que é pior do que
  // recusar — abriria um site que não existe em vez de dizer que faltou o caminho.
  const semEsquema = bruto.split(/[?#]/)[0]
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(bruto)) {
    const ultima = semEsquema.replace(/\/.*$/, '').split('.').pop().toLowerCase()
    if (!EXTENSOES_DE_ARQUIVO.has(ultima)) {
      return { ok: true, url: `https://${bruto}` }
    }
  }

  return {
    ok: false,
    motivo:
      `não sei abrir "${bruto}": mande um endereço http/https (ex.: https://exemplo.com), ` +
      '`localhost:PORTA/...` ou o caminho completo de um arquivo do disco.',
  }
}

/** Etiquetas finais que são arquivo, não domínio — só para não confundir as duas coisas. */
const EXTENSOES_DE_ARQUIVO = new Set([
  'html', 'htm', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'json', 'md', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf', 'xml', 'csv', 'yml', 'yaml',
  'py', 'rs', 'go', 'java', 'sh', 'bat', 'ps1', 'zip',
])

/** `C:\x`, `C:/x`, `file:///C:/x` e `\\servidor\pasta` viram caminho do disco. */
function caminhoDeArquivo(valor) {
  if (/^file:\/\//i.test(valor)) {
    const semEsquema = valor.replace(/^file:\/\//i, '')
    const caminho = /^\/[a-z]:/i.test(semEsquema) ? semEsquema.slice(1) : semEsquema
    try {
      return decodeURIComponent(caminho)
    } catch {
      return caminho
    }
  }
  if (/^[a-z]:[\\/]/i.test(valor)) return valor
  if (/^\\\\/.test(valor)) return valor
  return null
}

function paraUrlDeArquivo(caminho) {
  const normalizado = caminho.replace(/\\/g, '/')
  const comBarra = normalizado.startsWith('/') ? normalizado : `/${normalizado}`
  return `file://${encodeURI(comBarra).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

// ---------------------------------------------------------------- teclado

/**
 * Como o navegador chama cada tecla que não produz texto.
 *
 * O `key` é o nome lógico (o que os componentes leem em `event.key`), o `code` é a posição
 * física no teclado e o `vk` é o código virtual do Windows — os três têm de bater, senão a
 * página recebe uma tecla que não existe.
 */
const TECLAS_ESPECIAIS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}

/** Nome de tecla escrito à mão -> `{key, code, vk}`. */
function descreverTecla(pedida) {
  const bruta = String(pedida).trim()
  const baixa = bruta.toLowerCase()
  if (TECLAS_ESPECIAIS[baixa]) return TECLAS_ESPECIAIS[baixa]
  const funcao = /^f([1-9]|1[0-2])$/.exec(baixa)
  if (funcao) return { key: 'F' + funcao[1], code: 'F' + funcao[1], vk: 111 + Number(funcao[1]) }
  if (bruta.length === 1) {
    const maiuscula = bruta.toUpperCase()
    const code = /[a-z]/i.test(bruta) ? 'Key' + maiuscula : /[0-9]/.test(bruta) ? 'Digit' + bruta : bruta
    return { key: bruta, code, vk: maiuscula.charCodeAt(0) }
  }
  // Nome desconhecido vai como está: o navegador recusa o que não conhece, e "não aconteceu
  // nada" é uma resposta melhor do que inventar um código errado e culpar a página.
  return { key: bruta, code: bruta, vk: 0 }
}

// ---------------------------------------------------------------- CDP

/**
 * Conversa com **uma** página do navegador, em modo `flatten`.
 *
 * A pegadinha que já custou tempo: falar com o WebSocket da **página** aceita `Page.enable` e
 * `Page.navigate` mas nunca responde a `Runtime.evaluate` — o sintoma é um tempo esgotado, não
 * um erro. O caminho que funciona é o endpoint do **browser** + `Target.attachToTarget`
 * (`flatten: true`) e mandar o `sessionId` em cada comando.
 */
class Navegador {
  constructor() {
    this.processo = null
    this.perfil = null
    this.porta = null
    this.ws = null
    this.sessionId = null
    this.targetId = null
    this.url = 'about:blank'
    this.titulo = ''
    this._proximo = 1
    this._pendentes = new Map()
    this._relogio = null
    /** As últimas linhas que o navegador escreveu — viram a mensagem de erro se a subida falhar. */
    this._erroNavegador = []
    /** Onde a página está rolada. Vai no estado publicado, para o painel acompanhar. */
    this._rolagem = null
    /** O texto que a IA foi olhar, quando ela rolou até um trecho. Ver `_publicar`. */
    this._alvoRolagem = null
    /** O patch do WebGL já foi injetado nesta sessão? Ver `_prepararCanvasLegivel`. */
    this._canvasLegivel = false
    /** O que o navegador reclamou — console, exceções e log. Ver `console()`. */
    this._console = []
    /**
     * Os erros, **agrupados por assinatura** e sem teto de leitura. Ver `_anotarErro()`.
     *
     * Isto é o que o MCP `koda-dev-logs` lê. É separado do `_console` de propósito: o
     * `console` da IA pode ser esvaziado (`limpar: true`) e a página pode repetir o mesmo
     * erro milhares de vezes — aqui o que fica é a **assinatura** com o contador, não a
     * enxurrada. Sem este agrupamento um laço de erro encheria o arquivo publicado.
     */
    this._feed = new Map()
    /** O que a página pediu na rede, por `requestId`. Ver `rede()`. */
    this._rede = new Map()
    /** O mock de rede ligado agora, se houver. Ver `requisicao()`. */
    this._mock = null
    /** O domínio `Fetch` está interceptando? */
    this._mockLigado = false
    this._dados = pastaDeDados()
  }

  get vivo() {
    return this.processo !== null && this.processo.exitCode === null && this.ws !== null
  }

  // -------------------------------------------------- ciclo de vida

  async abrir() {
    if (this.vivo) return
    const exe = acharNavegador()
    if (!exe) {
      throw new Error(
        'não achei Chrome nem Edge nesta máquina — defina KODA_BROWSER com o caminho do executável',
      )
    }

    // **Duas tentativas.** Subir navegador falha de vez em quando por motivo passageiro —
    // disputa de recurso com outro navegador aberto, perfil recém-criado, antivírus passando
    // no executável. Uma queda dessas derrubava a chamada inteira da IA, que via "o navegador
    // fechou logo depois de subir" e desistia da tarefa. Uma segunda tentativa custa um
    // segundo e salva a rodada.
    let ultimoErro = null
    this._erroNavegador = []
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        // A segunda tentativa abre mão do sandbox do navegador. O motivo: em ambiente com
        // processos aninhados (o backend sobe o MCP, o MCP sobe o navegador) o sandbox do
        // Chrome no Windows falha **na largada** — ele sai com `0x80000003` e não escreve
        // nada, que é o pior tipo de erro para se diagnosticar. Na primeira tentativa o
        // sandbox fica de pé, porque é a opção mais segura; só quem já falhou perde ele.
        await this._subir(exe, tentativa === 2)
        log(`navegador no ar na porta ${this.porta}${tentativa === 2 ? ' (sem sandbox)' : ''}`)
        return
      } catch (erro) {
        ultimoErro = erro
        log(`tentativa ${tentativa} falhou: ${erro.message}`)
        await this._limpar()
        await dormir(900)
      }
    }
    const pistas = this._erroNavegador.length
      ? `\nO navegador escreveu:\n  ${this._erroNavegador.slice(-5).join('\n  ')}`
      : '\nO navegador não escreveu nada.'
    throw new Error(`${ultimoErro.message} (tentei duas vezes)${pistas}`)
  }

  async _subir(exe, semSandbox) {
    this.perfil = mkdtempSync(join(tmpdir(), 'koda-dev-browser-'))
    this.processo = spawn(
      exe,
      [
        // Sem janela: quem mostra a sessão é o painel, por espelho. `KODA_DEV_BROWSER_VISIVEL=1`
        // abre a janela de verdade, para depurar.
        ...(process.env.KODA_DEV_BROWSER_VISIVEL === '1' ? [] : ['--headless=new']),
        // `=0` faz o próprio navegador escolher a porta e publicá-la no perfil — melhor do que
        // sortear uma aqui e torcer para não estar ocupada.
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        `--user-data-dir=${this.perfil}`,
        '--window-size=1280,860',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-gpu',
        ...(semSandbox ? ['--no-sandbox'] : []),
        'about:blank',
      ],
      // O `stderr` fica capturado, e não descartado: quando o navegador não sobe, é ali que
      // está o motivo ("profile in use", política de máquina, caminho errado). Descartar isso
      // deixa o erro como um tempo esgotado sem explicação.
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    this.processo.stderr?.setEncoding('utf8')
    this.processo.stderr?.on('data', (pedaco) => {
      for (const linha of pedaco.split('\n')) {
        const texto = linha.trim()
        if (!texto) continue
        log('navegador:', texto)
        // Guardadas para poderem virar a mensagem de erro: quando a subida falha, o motivo
        // está aqui, e sem isto a IA recebe "o navegador fechou" sem saber por quê.
        this._erroNavegador.push(texto)
        if (this._erroNavegador.length > 8) this._erroNavegador.shift()
      }
    })
    this.processo.on('exit', (codigo) => {
      log(`navegador saiu com código ${codigo}`)
      this.processo = null
      this.ws = null
      this._publicar(false)
    })

    this.porta = await this._esperarPorta()
    await this._conectar()
    this._ligarEspelho()
  }

  /** Desfaz uma tentativa que não deu certo, antes de tentar de novo. */
  async _limpar() {
    this._desligarEspelho()
    try {
      this.processo?.kill()
    } catch {
      // já morreu
    }
    try {
      this.ws?.close()
    } catch {
      // já fechado
    }
    this.processo = null
    this.ws = null
    this.sessionId = null
    if (this.perfil) {
      try {
        rmSync(this.perfil, { recursive: true, force: true })
      } catch {
        // perfil travado: o Windows solta depois
      }
      this.perfil = null
    }
  }

  async _esperarPorta() {
    const arquivo = join(this.perfil, 'DevToolsActivePort')
    // A primeira subida de um perfil novo é lenta: o Chrome monta o perfil inteiro antes de
    // publicar a porta. Doze segundos não bastaram na primeira tentativa; trinta é folga.
    for (let tentativa = 0; tentativa < 300; tentativa++) {
      if (existsSync(arquivo)) {
        const primeira = readFileSync(arquivo, 'utf8').split('\n')[0]?.trim()
        if (primeira) return Number(primeira)
      }
      if (!this.processo) {
        // O `exit` já rodou: esperar mais seria esperar por um processo que não existe.
        throw new Error('o navegador fechou logo depois de subir — veja o stderr acima')
      }
      await dormir(100)
    }
    throw new Error(`o navegador não publicou a porta de depuração em 30s (perfil: ${this.perfil})`)
  }

  async _conectar() {
    const info = await (await fetch(`http://127.0.0.1:${this.porta}/json/version`)).json()
    const ws = new WebSocket(info.webSocketDebuggerUrl)
    await new Promise((pronto, falha) => {
      ws.addEventListener('open', pronto)
      ws.addEventListener('error', falha)
    })
    this.ws = ws

    ws.addEventListener('message', (evento) => {
      let mensagem
      try {
        mensagem = JSON.parse(evento.data)
      } catch {
        return
      }
      const espera = this._pendentes.get(mensagem.id)
      if (espera) {
        this._pendentes.delete(mensagem.id)
        mensagem.error ? espera.reject(new Error(JSON.stringify(mensagem.error))) : espera.resolve(mensagem.result)
        return
      }
      // Eventos de página: é por aqui que o título e a URL ficam sabendo.
      if (mensagem.method === 'Page.frameNavigated' && !mensagem.params?.frame?.parentId) {
        this.url = mensagem.params.frame.url
        // **Recarregar zera o feed.** Um erro que aconteceu no carregamento anterior já não
        // descreve a página que está na tela, e mantê-lo faria a verificação pós-correção
        // mentir: o painel continuaria mostrando o defeito antigo depois de consertado, e a IA
        // não teria como provar que pegou. Se o defeito não foi corrigido, ele **volta** no
        // próximo carregamento — com carimbo novo, e aí sim conta como "novo".
        //
        // A `_rede` **não** é zerada: ela é a memória do `rede()` da IA, com o `limpar` dela.
        this._feed.clear()
      }
      if (mensagem.method === 'Page.loadEventFired') {
        void this._atualizarTitulo()
      }
      this._evento(mensagem.method, mensagem.params)
    })

    const alvo = await this.bruto('Target.createTarget', { url: 'about:blank' })
    this.targetId = alvo.targetId
    const anexo = await this.bruto('Target.attachToTarget', { targetId: this.targetId, flatten: true })
    this.sessionId = anexo.sessionId

    // **Sem isto o quadro sai branco.** A aba criada nasce em segundo plano, e o navegador
    // não compõe o que não está à frente: `Page.captureScreenshot` devolve uma imagem em
    // branco — a página está lá (o `ler` acha os elementos), mas não há superfície desenhada.
    // Custou uma rodada de depuração, e o sintoma engana: parece que a captura não funciona,
    // quando o que falta é a aba estar à frente.
    await this.bruto('Target.activateTarget', { targetId: this.targetId })

    await this.enviar('Page.enable')
    await this.enviar('Runtime.enable')
    // Os três ficam ligados desde a subida, e não só quando alguém pede: o valor deles está
    // justamente no que **já passou** — o erro de console que apareceu no carregamento, a
    // requisição que falhou antes de a IA olhar. Ligar depois seria chegar atrasado.
    await this.enviar('Log.enable')
    await this.enviar('Network.enable')
    await this.enviar('DOM.enable')
  }

  async fechar() {
    this._desligarEspelho()
    try {
      await this.enviar('Browser.close')
    } catch {
      // já caiu
    }
    try {
      this.ws?.close()
    } catch {
      // já fechado
    }
    try {
      this.processo?.kill()
    } catch {
      // já morreu
    }
    this.ws = null
    this.processo = null
    this.sessionId = null
    this._publicar(false)
    if (this.perfil) {
      try {
        rmSync(this.perfil, { recursive: true, force: true })
      } catch {
        // perfil travado: o Windows solta depois
      }
    }
    log('navegador fechado')
  }

  // -------------------------------------------------- transporte

  bruto(metodo, params = {}) {
    return this._pedir(metodo, params)
  }

  enviar(metodo, params = {}) {
    return this._pedir(metodo, params, this.sessionId)
  }

  _pedir(metodo, params, sessionId) {
    const ws = this.ws
    if (!ws) return Promise.reject(new Error('o navegador não está no ar'))
    return new Promise((resolve, reject) => {
      const id = this._proximo++
      this._pendentes.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method: metodo, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (this._pendentes.delete(id)) reject(new Error(`tempo esgotado em ${metodo}`))
      }, 30000)
    })
  }

  async avaliar(expressao) {
    const r = await this.enviar('Runtime.evaluate', {
      expression: expressao,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'erro ao avaliar na página')
    }
    return r.result?.value
  }

  // -------------------------------------------------- ações

  /**
   * Faz o canvas **WebGL** ser legível — o caso de um jogo.
   *
   * Um canvas WebGL descarta o buffer depois de compor: reler os pixels mais tarde devolve
   * vazio, e o `enxergar` mostraria um quadro todo transparente (medido: um canvas pintado de
   * laranja voltava `transparente(32)`). Pedindo `preserveDrawingBuffer` na criação do
   * contexto, o buffer fica. Tem de ser **antes** de a página criar o contexto, e é por isso
   * que entra como script de documento novo, e não como remendo depois da carga.
   *
   * O preço é do lado do WebGL (guardar o buffer custa), e vale num navegador de inspeção:
   * sem isto, um jogo é uma caixa opaca para a IA.
   */
  async _prepararCanvasLegivel() {
    if (this._canvasLegivel) return
    this._canvasLegivel = true
    try {
      await this.enviar('Page.addScriptToEvaluateOnNewDocument', {
        source:
          '(() => {\n' +
          '  const original = HTMLCanvasElement.prototype.getContext\n' +
          '  HTMLCanvasElement.prototype.getContext = function (tipo, attrs) {\n' +
          '    if (typeof tipo === "string" && tipo.indexOf("webgl") >= 0) {\n' +
          '      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true })\n' +
          '    }\n' +
          '    return original.call(this, tipo, attrs)\n' +
          '  }\n' +
          '})()\n',
      })
    } catch (erro) {
      log('não consegui preparar o canvas WebGL: ' + erro.message)
    }
  }

  async ir(url) {
    this._alvoRolagem = null
    await this._prepararCanvasLegivel()
    await this.enviar('Page.navigate', { url })
    await this._esperarCarga()
    await this._atualizarTitulo()
    return { url: this.url, titulo: this.titulo }
  }

  /**
   * Espera a página assentar — em **duas** etapas, e a segunda não é luxo.
   *
   * Consultar o `readyState` é mais fiel do que escutar eventos (que podem chegar antes de o
   * `await` ser registrado). Mas ele só diz que os recursos terminaram de carregar: página
   * desenhada por JavaScript — o próprio app do Koda, um painel de Vite, um SPA — fica com o
   * corpo **vazio** nesse instante. Ler ali devolve "texto visível: (vazio)", e foi exatamente
   * o que aconteceu na primeira versão.
   *
   * A segunda etapa espera o corpo ganhar conteúdo. Se a página for legitimamente vazia, o teto
   * de 3s é o preço — pequeno perto de ler uma tela em branco e concluir que não há nada lá.
   */
  async _esperarCarga(limiteMs = 15000) {
    const fim = Date.now() + limiteMs
    while (Date.now() < fim) {
      try {
        const estado = await this.avaliar('document.readyState')
        if (estado === 'complete' || estado === 'interactive') break
      } catch {
        // navegando: o contexto ainda não existe
      }
      await dormir(150)
    }

    // Seis segundos, e não três: a primeira carga de um servidor de dev (Vite compilando o
    // grafo de módulos) passa fácil dos três, e a leitura saía vazia por azar de corrida —
    // intermitente, que é o pior tipo de defeito para se confiar.
    const tetoConteudo = Date.now() + 6000
    while (Date.now() < tetoConteudo) {
      try {
        const temConteudo = await this.avaliar(
          'Boolean((document.body && document.body.innerText || "").trim())',
        )
        if (temConteudo) break
      } catch {
        // ainda montando
      }
      await dormir(150)
    }
    await dormir(250)
  }

  async _atualizarTitulo() {
    try {
      const dados = await this.avaliar('({ url: location.href, titulo: document.title })')
      if (dados) {
        this.url = dados.url ?? this.url
        this.titulo = dados.titulo ?? ''
      }
    } catch {
      // sem contexto: fica o último conhecido
    }
  }

  /** Marca os elementos interativos com `data-koda-n` e devolve o retrato da página. */
  async ler() {
    const dados = await this.avaliar(`
      (() => {
        const visivel = (el) => {
          const r = el.getBoundingClientRect()
          const s = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
        }
        const todos = Array.from(document.querySelectorAll(
          'a[href], button, input, textarea, select, [role="button"], [contenteditable="true"]'
        )).filter(visivel).slice(0, 80)
        todos.forEach((el, i) => el.setAttribute('data-koda-n', String(i)))
        return {
          url: location.href,
          titulo: document.title,
          texto: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 6000),
          elementos: todos.map((el, i) => {
            const tag = el.tagName.toLowerCase()
            const tipo = el.getAttribute('type') || ''
            const rotulo = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
              .replace(/\\s+/g, ' ').trim().slice(0, 70)
            const href = el.getAttribute('href') || ''
            // O tipo só acrescenta em input (input[text], input[checkbox]). Em button ele
            // repetiria a própria tag, e "button[button]" só polui a leitura do modelo.
            // Sem crase neste comentário: ele vive dentro de um template literal.
            return { n: i, tag: tag === 'input' && tipo ? 'input[' + tipo + ']' : tag, rotulo, href: href.slice(0, 120) }
          }),
        }
      })()
    `)
    if (dados) {
      this.url = dados.url ?? this.url
      this.titulo = dados.titulo ?? this.titulo
    }
    return dados
  }

  async _elemento(alvo) {
    const porIndice = Number.isInteger(alvo?.n)
    const expressao = porIndice
      ? `document.querySelector('[data-koda-n="${alvo.n}"]')`
      : `document.querySelector(${JSON.stringify(String(alvo?.seletor ?? ''))})`
    const achou = await this.avaliar(`
      (() => {
        const el = ${expressao}
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          visivel: r.width > 0 && r.height > 0,
          descricao: (el.tagName.toLowerCase() + ' ' + (el.innerText || el.value || '')).replace(/\\s+/g, ' ').trim().slice(0, 60),
        }
      })()
    `)
    if (!achou) {
      throw new Error(
        porIndice
          ? `não há elemento com o número ${alvo.n} — chame "ler" de novo, os números mudam a cada leitura`
          : `nenhum elemento casa com o seletor ${JSON.stringify(alvo?.seletor)}`,
      )
    }
    if (!achou.visivel) throw new Error(`o elemento ${achou.descricao} está sem tamanho na tela`)
    return achou
  }

  async clicar(alvo) {
    const elemento = await this._elemento(alvo)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.enviar('Input.dispatchMouseEvent', {
        type,
        x: elemento.x,
        y: elemento.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    await dormir(250)
    await this._atualizarTitulo()
    return elemento.descricao
  }

  async digitar(alvo, texto, enter) {
    const elemento = await this._elemento(alvo)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.enviar('Input.dispatchMouseEvent', {
        type,
        x: elemento.x,
        y: elemento.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
    // `insertText` entra como digitação de verdade: o React e o Vue escutam o evento `input`,
    // que é o que este comando gera — atribuir `value` por JavaScript não os acordaria.
    await this.enviar('Input.insertText', { text: String(texto ?? '') })
    if (enter) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await this.enviar('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        })
      }
      await dormir(400)
    }
    await this._atualizarTitulo()
    return elemento.descricao
  }

  // -------------------------------------------------- eventos (console, rede, dublê)

  /**
   * Distribui um evento do navegador para os buffers.
   *
   * Os três têm teto: uma página que loga em laço encheria a memória, e o que interessa quase
   * sempre são as **últimas** linhas — as primeiras já foram lidas.
   */
  _evento(metodo, params) {
    if (!metodo || !params) return

    if (metodo === 'Runtime.consoleAPICalled') {
      const texto = (params.args ?? [])
        .map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type)))
        .join(' ')
      const quadro = params.stackTrace?.callFrames?.[0]
      // `+1`: o CDP conta a linha a partir do zero; o editor e o humano contam a partir do um.
      const onde = quadro ? String(quadro.url) + ':' + (quadro.lineNumber + 1) : ''
      const tipo = params.type ?? 'log'
      this._guardarConsole({ tipo, texto: String(texto).slice(0, 500), onde })
      // `assert` é um erro disfarçado de log: a página afirmou algo e não era verdade.
      if (tipo === 'error' || tipo === 'assert') this._anotarErro('navegador', 'erro', texto, onde, 'grave')
      else if (tipo === 'warning') this._anotarErro('navegador', 'aviso', texto, onde, 'leve')
      return
    }

    if (metodo === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails ?? {}
      const texto = String(d.exception?.description ?? d.text ?? 'erro sem descrição')
      // `+1`: o CDP conta a linha a partir do zero; o editor conta a partir do um.
      const onde = d.url ? String(d.url) + ':' + (d.lineNumber + 1) : ''
      this._guardarConsole({ tipo: 'exceção', texto: texto.slice(0, 500), onde })
      this._anotarErro('navegador', 'exceção', texto, onde, 'grave')
      return
    }

    if (metodo === 'Log.entryAdded') {
      const e = params.entry ?? {}
      // `verbose` é ruído de rede do próprio Chrome. O que importa é aviso, erro, e o que o
      // navegador **recusa** — CSP, recurso bloqueado, certificado.
      if (e.level === 'verbose') return
      this._guardarConsole({ tipo: e.level ?? 'log', texto: String(e.text ?? '').slice(0, 500), onde: e.url ?? '' })
      if (e.level === 'error') this._anotarErro('navegador', 'erro', e.text, e.url, 'grave')
      else if (e.level === 'warning') this._anotarErro('navegador', 'aviso', e.text, e.url, 'leve')
      return
    }

    if (metodo === 'Network.requestWillBeSent') {
      const r = params.request ?? {}
      this._rede.set(params.requestId, {
        metodo: r.method ?? 'GET',
        url: String(r.url ?? ''),
        tipo: params.type ?? '',
        comeco: params.timestamp ?? 0,
        status: null,
        fim: null,
        erro: null,
      })
      if (this._rede.size > 400) this._rede.delete(this._rede.keys().next().value)
      return
    }

    if (metodo === 'Network.responseReceived') {
      const item = this._rede.get(params.requestId)
      if (item) {
        item.status = params.response?.status ?? null
        item.tipo = params.type ?? item.tipo
        // Falha de HTTP também é erro — e é a que o console **não** mostra. Um 500 no `fetch`
        // só aparece aqui; sem isto a IA veria "a tela ficou vazia" sem saber por quê.
        const status = item.status
        if (status !== null && status >= 400) {
          const grave = status >= 500
          this._anotarErro(
            'rede',
            'http',
            `${status} ${item.metodo} ${item.url}`,
            item.url,
            grave ? 'grave' : 'leve',
          )
        }
      }
      return
    }

    if (metodo === 'Network.loadingFinished') {
      const item = this._rede.get(params.requestId)
      if (item) item.fim = params.timestamp ?? null
      return
    }

    if (metodo === 'Network.loadingFailed') {
      const item = this._rede.get(params.requestId)
      if (item) {
        item.erro = params.errorText ?? 'falhou'
        item.fim = params.timestamp ?? null
        // Requisição **cancelada** não é defeito: é navegação nova, `AbortController`, troca de
        // aba. Marcar isso como erro encheria o feed de falso positivo e treinaria a IA a
        // ignorar o feed — que é o oposto do objetivo.
        const cancelada = /aborted|canceled|cancelled/i.test(item.erro)
        if (!cancelada) {
          this._anotarErro(
            'rede',
            'falha',
            `${item.metodo} ${item.url} — ${item.erro}`,
            item.url,
            /cors|blocked|refused|dns|ERR_/i.test(item.erro) ? 'grave' : 'leve',
          )
        }
      }
      return
    }

    if (metodo === 'Fetch.requestPaused') {
      void this._atenderInterceptado(params)
    }
  }

  _guardarConsole(item) {
    this._console.push(item)
    if (this._console.length > 300) this._console.shift()
  }

  /**
   * A **assinatura** de um erro: o que faz dois relatos serem o mesmo problema.
   *
   * Sem isto, um laço que loga o mesmo erro 800 vezes viraria 800 linhas. A receita tira o que
   * muda a cada repetição — números, hashes, ids de requisição, timestamps — e deixa o que
   * identifica: a mensagem sem os valores e o lugar. Dois erros só contam como um se a
   * mensagem normalizada **e** o lugar baterem; mensagens parecidas em lugares diferentes
   * continuam sendo dois, porque consertar um não conserta o outro.
   */
  _assinatura(fonte, tipo, texto, onde) {
    const limpo = String(texto ?? '')
      .toLowerCase()
      .replace(/https?:\/\/[^\s)'"]+/g, (u) => u.replace(/[?#].*$/, ''))
      .replace(/0x[0-9a-f]+/g, '0x')
      .replace(/[0-9a-f]{8,}/gi, 'h')
      .replace(/\d+/g, 'n')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
    // O `onde` entra só pelo arquivo e a linha **relativa** (sem o número absoluto): a mesma
    // falha em `app.js:42` e `app.js:43` é a mesma falha; em `outro.js` não é.
    const lugar = String(onde ?? '').replace(/:\d+$/, '')
    return `${fonte}|${tipo}|${limpo}|${lugar}`
  }

  /**
   * Guarda (ou atualiza) um erro no feed que o MCP `koda-dev-logs` lê.
   *
   * Só entra o que é **erro ou aviso**. `log`/`info`/`debug` ficam de fora: o pedido é "só
   * erros, sem spam", e um feed que carrega o ruído junto obriga quem lê a filtrar de novo.
   */
  _anotarErro(fonte, tipo, texto, onde, severidade) {
    if (!texto) return
    const chave = this._assinatura(fonte, tipo, texto, onde)
    const agora = Date.now()
    const existente = this._feed.get(chave)
    if (existente) {
      existente.ultimo = agora
      existente.ocorrencias += 1
      return
    }
    this._feed.set(chave, {
      chave,
      fonte,
      tipo,
      severidade: severidade ?? 'grave',
      texto: String(texto).slice(0, 600),
      onde: String(onde ?? '').slice(0, 300),
      primeiro: agora,
      ultimo: agora,
      ocorrencias: 1,
    })
    // Teto do feed: o que interessa é o que **está acontecendo**, não o histórico da sessão
    // inteira. Passando disto, sai o mais antigo por último avistamento.
    if (this._feed.size > 200) {
      let alvo = null
      for (const [k, v] of this._feed) if (!alvo || v.ultimo < alvo.ultimo) alvo = { k, ...v }
      if (alvo) this._feed.delete(alvo.k)
    }
  }

  // -------------------------------------------------- interação fina

  /**
   * Aperta uma tecla de verdade (`Input.dispatchKeyEvent`), com modificadores.
   *
   * É o que faltava para testar teclado: o `digitar` só sabe escrever texto e dar Enter. Aqui
   * entram Tab, Escape, as setas, Espaço, Home/End, F1..F12 e atalhos com Ctrl/Shift/Alt.
   * Com `seletor`, o elemento é clicado antes — tecla sem foco vai para o lugar errado.
   */
  async tecla(pedido) {
    const pedida = String(pedido?.tecla ?? '').trim()
    if (!pedida) throw new Error('preciso da tecla — ex.: Tab, Escape, ArrowDown, Space, Enter, a')
    const mods = Array.isArray(pedido?.modificadores) ? pedido.modificadores.map(String) : []
    const vezes = Math.min(Math.max(Number(pedido?.vezes) || 1, 1), 50)

    if (pedido?.seletor || pedido?.n !== undefined) {
      const alvo = await this._elemento({ seletor: pedido.seletor, n: pedido.n })
      await this.enviar('Input.dispatchMouseEvent', { type: 'mousePressed', x: alvo.x, y: alvo.y, button: 'left', clickCount: 1, buttons: 1 })
      await this.enviar('Input.dispatchMouseEvent', { type: 'mouseReleased', x: alvo.x, y: alvo.y, button: 'left', clickCount: 1, buttons: 0 })
      await dormir(80)
    }

    const { key, code, vk } = descreverTecla(pedida)
    const modifiers =
      (mods.some((m) => /^alt/i.test(m)) ? 1 : 0) |
      (mods.some((m) => /ctrl|control/i.test(m)) ? 2 : 0) |
      (mods.some((m) => /meta|cmd|command|win/i.test(m)) ? 4 : 0) |
      (mods.some((m) => /shift/i.test(m)) ? 8 : 0)

    // Tecla que produz texto entra como `keyDown` com `text`; tecla de comando entra como
    // `rawKeyDown`. Trocar os dois faz a letra não sair, ou o Enter virar dois eventos.
    const imprimivel = key.length === 1
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    for (let i = 0; i < vezes; i++) {
      await this.enviar('Input.dispatchKeyEvent', imprimivel ? { ...base, type: 'keyDown', text: key } : { ...base, type: 'rawKeyDown' })
      await this.enviar('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
      await dormir(50)
    }
    await this._atualizarTitulo()
    return 'apertei ' + (mods.length ? mods.join('+') + '+' : '') + pedida + (vezes > 1 ? ' ' + vezes + 'x' : '')
  }

  /**
   * Passa o mouse por cima — hover de verdade.
   *
   * Dois movimentos, não um: um salto único não dispara `mouseenter`/`mouseover` em todo
   * componente, porque muitos escutam `mousemove` para decidir que o ponteiro entrou.
   */
  async hover(pedido) {
    let x
    let y
    let descricao
    if (typeof pedido?.x === 'number' && typeof pedido?.y === 'number') {
      x = pedido.x
      y = pedido.y
      descricao = 'em ' + x + ',' + y
    } else {
      const alvo = await this._elemento(pedido ?? {})
      x = alvo.x
      y = alvo.y
      descricao = alvo.descricao
    }
    await this.enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.max(0, x - 24), y: Math.max(0, y - 24), buttons: 0 })
    await dormir(60)
    await this.enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
    await dormir(150)
    return descricao
  }

  /**
   * Arrasta de um ponto a outro, em passos.
   *
   * Os passos intermediários não são enfeite: componente que escuta `mousemove` — a maioria
   * das bibliotecas de arrastar — só reage se o ponteiro **passar** pelos pontos. Um salto
   * direto solta no vazio.
   *
   * Vale para arrastar com mouse. O arrastar **nativo do HTML** (`draggable="true"` com
   * `dragstart`/`drop`) usa outro canal do navegador e não é disparado por isto.
   */
  async arrastar(pedido) {
    const de = pedido?.de ?? pedido ?? {}
    await this._elemento(de)
    const destino =
      typeof pedido?.paraX === 'number' && typeof pedido?.paraY === 'number'
        ? { x: pedido.paraX, y: pedido.paraY, descricao: pedido.paraX + ',' + pedido.paraY }
        : await this._elemento(pedido?.para ?? {})
    // Resolver o destino rola a página para centrá-lo, e isso **move a origem**. Reler a
    // origem sem rolar é o que impede o arrasto de começar no lugar errado.
    const origem = { ...(await this._posicaoDe(de)), descricao: 'origem' }

    await this.enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x: origem.x, y: origem.y, buttons: 0 })
    await this.enviar('Input.dispatchMouseEvent', { type: 'mousePressed', x: origem.x, y: origem.y, button: 'left', clickCount: 1, buttons: 1 })
    const passos = Math.min(Math.max(Number(pedido?.passos) || 14, 2), 60)
    for (let i = 1; i <= passos; i++) {
      await this.enviar('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(origem.x + ((destino.x - origem.x) * i) / passos),
        y: Math.round(origem.y + ((destino.y - origem.y) * i) / passos),
        button: 'left',
        buttons: 1,
      })
      await dormir(16)
    }
    await this.enviar('Input.dispatchMouseEvent', { type: 'mouseReleased', x: destino.x, y: destino.y, button: 'left', clickCount: 1, buttons: 0 })
    await dormir(250)
    return origem.x + ',' + origem.y + ' → ' + destino.descricao
  }

  /** O centro de um elemento **sem rolar** — para medir sem mexer na página. */
  async _posicaoDe(alvo) {
    const seletor = alvo?.n !== undefined ? '[data-koda-n="' + alvo.n + '"]' : String(alvo?.seletor ?? '')
    if (!seletor) throw new Error('preciso do seletor ou do número do elemento')
    const achou = await this.avaliar(
      '(() => { const el = document.querySelector(' + JSON.stringify(seletor) + ');' +
        ' if (!el) return null; const r = el.getBoundingClientRect();' +
        ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()',
    )
    if (!achou) throw new Error('não achei ' + seletor)
    return achou
  }

  /** Põe arquivos num `input[type=file]` — o caminho que o navegador usa de verdade. */
  async upload(pedido) {
    const arquivos = (Array.isArray(pedido?.arquivos) ? pedido.arquivos : [pedido?.arquivo])
      .filter((a) => a !== undefined && a !== null && String(a).trim() !== '')
      .map((a) => String(a))
    if (!arquivos.length) throw new Error('preciso do caminho do arquivo (parâmetro "arquivos")')
    const seletor = pedido?.n !== undefined ? '[data-koda-n="' + pedido.n + '"]' : String(pedido?.seletor ?? '')
    if (!seletor) throw new Error('preciso do seletor ou do número do input de arquivo')
    const doc = await this.enviar('DOM.getDocument', { depth: 0 })
    const no = await this.enviar('DOM.querySelector', { nodeId: doc.root.nodeId, selector: seletor })
    if (!no?.nodeId) throw new Error('não achei o input ' + seletor)
    await this.enviar('DOM.setFileInputFiles', { files: arquivos, nodeId: no.nodeId })
    await dormir(250)
    return arquivos.length + ' arquivo(s) em ' + seletor
  }

  /**
   * A árvore de acessibilidade — o que um leitor de tela lê.
   *
   * É outra leitura, e não um detalhe do `enxergar`: papel, nome acessível **calculado** e
   * estado (`checked`, `disabled`, `expanded`, `required`). Uma tela pode estar visualmente
   * certa e ser inusável por teclado — é aqui que isso aparece.
   */
  async acessibilidade(pedido) {
    let nos = []
    if (pedido?.seletor || pedido?.n !== undefined) {
      const seletor = pedido?.n !== undefined ? '[data-koda-n="' + pedido.n + '"]' : String(pedido.seletor)
      const doc = await this.enviar('DOM.getDocument', { depth: 0 })
      const no = await this.enviar('DOM.querySelector', { nodeId: doc.root.nodeId, selector: seletor })
      if (!no?.nodeId) throw new Error('não achei o elemento ' + seletor)
      const r = await this.enviar('Accessibility.getPartialAXTree', { nodeId: no.nodeId, fetchRelatives: false })
      nos = r?.nodes ?? []
    } else {
      const r = await this.enviar('Accessibility.getFullAXTree')
      nos = r?.nodes ?? []
    }
    const teto = Math.min(Math.max(Number(pedido?.limite) || 300, 1), 2000)
    const interessantes = ['checked', 'disabled', 'expanded', 'selected', 'required', 'invalid', 'focusable', 'focused', 'modal', 'level', 'valuetext', 'valuenow']
    const linhas = []
    for (const no of nos) {
      if (linhas.length >= teto) break
      if (no.ignored) continue
      const papel = no.role?.value ?? ''
      const nome = no.name?.value ?? ''
      if (!nome && !papel) continue
      const marcas = (no.properties ?? [])
        .filter((p) => interessantes.includes(p.name))
        .map((p) => p.name + '=' + JSON.stringify(p.value?.value))
        .join(' ')
      linhas.push(papel + (nome ? ' "' + nome + '"' : '') + (marcas ? ' [' + marcas + ']' : ''))
    }
    if (!linhas.length) return 'a árvore de acessibilidade não devolveu nada útil aqui'
    return linhas.length + ' nó(s):\n' + linhas.join('\n')
  }

  /** O que o navegador reclamou — console, exceções e log. `limpar: true` esvazia. */
  async console(pedido) {
    const itens = pedido?.limpar ? this._console.splice(0, this._console.length) : [...this._console]
    const filtro = pedido?.filtro ? String(pedido.filtro).toLowerCase() : ''
    const uteis = itens.filter((i) => !filtro || (i.texto + ' ' + i.onde).toLowerCase().includes(filtro))
    if (!uteis.length) return pedido?.limpar ? '(console esvaziado)' : '(nada no console)'
    return uteis.map((i) => '[' + i.tipo + '] ' + i.texto + (i.onde ? '  (' + i.onde + ')' : '')).join('\n')
  }

  /** O que a página pediu na rede. `limpar` esvazia; `filtro` casa na URL. */
  async rede(pedido) {
    const itens = [...this._rede.values()]
    const filtro = pedido?.filtro ? String(pedido.filtro).toLowerCase() : ''
    const uteis = itens
      .filter((i) => !filtro || i.url.toLowerCase().includes(filtro))
      .filter((i) => !pedido?.somenteFalhas || i.erro || (i.status !== null && i.status >= 400))
    if (pedido?.limpar) this._rede.clear()
    if (!uteis.length) return '(nenhuma requisição registrada)'
    const linhas = uteis.slice(-120).map((i) => {
      const ms = i.fim && i.comeco ? Math.round((i.fim - i.comeco) * 1000) + 'ms' : '…'
      const status = i.erro ? 'FALHOU(' + i.erro + ')' : i.status === null ? 'pendente' : i.status
      return status + ' ' + i.metodo + ' ' + i.url.slice(0, 120) + (i.tipo ? ' [' + i.tipo + ']' : '') + ' ' + ms
    })
    return uteis.length + ' requisição(ões):\n' + linhas.join('\n')
  }

  /**
   * `localStorage`, `sessionStorage` e cookies.
   *
   * Lê sempre; `definir` grava chave a chave e `limpar` apaga. É o que permite testar "refresh
   * no meio do fluxo" e "sessão expirada" sem passar pela tela de login.
   */
  async armazenamento(pedido) {
    if (pedido?.limpar) await this.avaliar('(localStorage.clear(), sessionStorage.clear(), true)')
    if (pedido?.definir && typeof pedido.definir === 'object') {
      const d = JSON.stringify({ local: pedido.definir.local ?? {}, session: pedido.definir.session ?? {} })
      await this.avaliar(
        '(async () => { const d = ' + d + ';' +
          ' for (const [k, v] of Object.entries(d.local)) localStorage.setItem(k, String(v));' +
          ' for (const [k, v] of Object.entries(d.session)) sessionStorage.setItem(k, String(v));' +
          ' return true })()',
      )
    }
    if (pedido?.recarregar) await this.recarregar()
    const dados = await this.avaliar(
      '(() => {' +
        ' const ler = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = String(s.getItem(k)).slice(0, 300) } return o };' +
        ' return { local: ler(localStorage), session: ler(sessionStorage), cookies: document.cookie } })()',
    )
    return (
      'localStorage (' + Object.keys(dados?.local ?? {}).length + '):\n' + JSON.stringify(dados?.local ?? {}, null, 2) + '\n\n' +
      'sessionStorage (' + Object.keys(dados?.session ?? {}).length + '):\n' + JSON.stringify(dados?.session ?? {}, null, 2) + '\n\n' +
      'cookies: ' + (dados?.cookies || '(nenhum)')
    )
  }

  /**
   * Roda JavaScript na página e devolve o valor.
   *
   * É a saída de emergência: o que não virou ferramenta própria cabe aqui — ler
   * `performance.getEntriesByType`, conferir `document.title` e as meta tags, medir contraste
   * com `getComputedStyle`, semear estado, trocar `fetch` por um dublê. O código é avaliado
   * como **expressão**; para várias linhas, use uma função invocada na hora com `return`.
   */
  async executarJs(pedido) {
    const codigo = String(pedido?.codigo ?? '').trim()
    if (!codigo) throw new Error('preciso do código a rodar na página (parâmetro "codigo")')
    const r = await this.enviar('Runtime.evaluate', {
      expression: codigo,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'erro'
      return 'ERRO na página: ' + String(d).split('\n')[0]
    }
    const v = r.result?.value
    if (v === undefined) return '(sem valor — a expressão não devolveu nada)'
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }

  /** Espera acontecer — seletor, texto ou uma expressão — até o prazo. */
  async esperar(pedido) {
    const limite = Math.min(Math.max(Number(pedido?.ms) || 5000, 100), 60000)
    let condicao
    let descricao
    if (pedido?.seletor) {
      condicao = '!!document.querySelector(' + JSON.stringify(String(pedido.seletor)) + ')'
      descricao = 'aparecer ' + pedido.seletor
    } else if (pedido?.texto) {
      condicao = '(document.body ? document.body.innerText : "").includes(' + JSON.stringify(String(pedido.texto)) + ')'
      descricao = 'o texto "' + pedido.texto + '"'
    } else if (pedido?.ate) {
      condicao = '(' + String(pedido.ate) + ')'
      descricao = 'a condição ' + pedido.ate
    } else {
      throw new Error('diga o que esperar: seletor, texto ou ate (expressão)')
    }
    const comeco = Date.now()
    while (Date.now() - comeco < limite) {
      try {
        if (await this.avaliar(condicao)) return descricao + ' — aconteceu em ' + (Date.now() - comeco) + 'ms'
      } catch {
        // a página pode estar no meio de uma navegação: tenta de novo
      }
      await dormir(120)
    }
    throw new Error('esperei ' + limite + 'ms e não aconteceu: ' + descricao)
  }

  /**
   * O tamanho da janela — é o que permite testar responsividade e mobile.
   *
   * `mobile: true` liga o modo de toque; com `acao: toque` ou `acao: swipe` o dedo vai de
   * verdade (`Input.dispatchTouchEvent`), em passos, que é o que faz o gesto ser reconhecido.
   */
  async janela(pedido) {
    if (pedido?.limpar) {
      await this.enviar('Emulation.clearDeviceMetricsOverride')
      await this.enviar('Emulation.setTouchEmulationEnabled', { enabled: false })
      await dormir(150)
      return 'janela de volta ao tamanho natural'
    }

    if (pedido?.acao === 'toque' || pedido?.acao === 'swipe') {
      const de = typeof pedido.x === 'number' && typeof pedido.y === 'number'
        ? { x: pedido.x, y: pedido.y }
        : await this._posicaoDe(pedido ?? {})
      const ate = pedido.acao === 'swipe'
        ? { x: de.x + (Number(pedido.dx) || 0), y: de.y + (Number(pedido.dy) || 0) }
        : de
      const ponto = (p) => [{ x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1, id: 1 }]
      await this.enviar('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: ponto(de) })
      const passos = ate === de ? 1 : Math.min(Math.max(Number(pedido.passos) || 12, 2), 40)
      for (let i = 1; i <= passos; i++) {
        await this.enviar('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: ponto({
            x: Math.round(de.x + ((ate.x - de.x) * i) / passos),
            y: Math.round(de.y + ((ate.y - de.y) * i) / passos),
          }),
        })
        await dormir(20)
      }
      await this.enviar('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await dormir(200)
      return pedido.acao === 'toque'
        ? 'toquei em ' + de.x + ',' + de.y
        : 'arrastei o dedo de ' + de.x + ',' + de.y + ' para ' + ate.x + ',' + ate.y
    }

    const largura = Math.min(Math.max(Number(pedido?.largura) || 390, 120), 4096)
    const altura = Math.min(Math.max(Number(pedido?.altura) || 844, 120), 4096)
    const mobile = Boolean(pedido?.mobile)
    await this.enviar('Emulation.setDeviceMetricsOverride', {
      width: largura,
      height: altura,
      deviceScaleFactor: Number(pedido?.escala) || 1,
      mobile,
    })
    await this.enviar('Emulation.setTouchEmulationEnabled', { enabled: Boolean(pedido?.toque ?? mobile), maxTouchPoints: 5 })
    await dormir(250)
    // O modo de toque só vale num documento **novo**: `ontouchstart` e `navigator.maxTouchPoints`
    // são fixados quando a página nasce. Sem recarregar, a janela muda de tamanho mas a página
    // continua se achando um desktop sem dedo — medido: `ontouchstart in window` deu false.
    if (pedido?.recarregar) await this.recarregar()
    return 'janela em ' + largura + 'x' + altura + (mobile ? ' (mobile, toque ligado)' : '')
  }

  /**
   * Dublê de rede: responde no lugar do servidor, e mexe nas condições da conexão.
   *
   * É o que permite testar o que a tela faz quando a API **falha** — 400, 401, 404, 500 —,
   * quando a rede está lenta e quando está offline. Sem isto, esses caminhos só se testam
   * mexendo no servidor.
   */
  async requisicao(pedido) {
    if (pedido?.limpar) {
      if (this._mockLigado) {
        try {
          await this.enviar('Fetch.disable')
        } catch {
          // já estava desligado
        }
        this._mockLigado = false
      }
      this._mock = null
      await this.enviar('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      return 'dublê e condições de rede desligados'
    }

    if (pedido?.offline !== undefined || pedido?.latencia !== undefined) {
      await this.enviar('Network.emulateNetworkConditions', {
        offline: Boolean(pedido?.offline),
        latency: Math.max(0, Number(pedido?.latencia) || 0),
        downloadThroughput: Number(pedido?.downloadBytes) || -1,
        uploadThroughput: Number(pedido?.uploadBytes) || -1,
      })
    }

    if (pedido?.padrao) {
      if (this._mockLigado) {
        try {
          await this.enviar('Fetch.disable')
        } catch {
          // já estava desligado
        }
        this._mockLigado = false
      }
      this._mock = {
        status: Number(pedido?.status) || 500,
        corpo: String(pedido?.corpo ?? '{"erro":"simulado"}'),
        atraso: Math.max(0, Number(pedido?.atraso) || 0),
      }
      await this.enviar('Fetch.enable', { patterns: [{ urlPattern: String(pedido.padrao), requestStage: 'Request' }] })
      this._mockLigado = true
    }

    const partes = []
    if (this._mock) partes.push('respondendo ' + this._mock.status + ' no lugar de ' + JSON.stringify(pedido.padrao))
    if (pedido?.offline) partes.push('rede offline')
    if (pedido?.latencia) partes.push('latência de ' + pedido.latencia + 'ms')
    return partes.length ? partes.join(' · ') : 'nada mudou — diga padrao, offline ou latencia'
  }

  async _atenderInterceptado(params) {
    const mock = this._mock
    try {
      if (!mock) {
        await this.enviar('Fetch.continueRequest', { requestId: params.requestId })
        return
      }
      if (mock.atraso) await dormir(mock.atraso)
      await this.enviar('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: mock.status,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body: Buffer.from(mock.corpo, 'utf8').toString('base64'),
      })
    } catch {
      try {
        await this.enviar('Fetch.continueRequest', { requestId: params.requestId })
      } catch {
        // o pedido já tinha ido
      }
    }
  }

  async historico(direcao) {
    const { currentIndex, entries } = await this.enviar('Page.getNavigationHistory')
    const destino = currentIndex + (direcao === 'voltar' ? -1 : 1)
    if (destino < 0 || destino >= entries.length) {
      return null
    }
    await this.enviar('Page.navigateToHistoryEntry', { entryId: entries[destino].id })
    await this._esperarCarga()
    await this._atualizarTitulo()
    return { url: this.url, titulo: this.titulo }
  }

  async recarregar() {
    await this.enviar('Page.reload')
    await this._esperarCarga()
    await this._atualizarTitulo()
    return { url: this.url, titulo: this.titulo }
  }

  /**
   * Rola a página e **para num lugar**. Aceita cinco jeitos de dizer onde, porque a IA pensa
   * de cinco jeitos: pelo número que o `ler` deu, por seletor CSS, pelo texto que aparece na
   * tela, por `topo`/`fim`, ou por uma altura em pixels.
   */
  async rolar(pedido) {
    const resultado = await this.avaliar(`
      (() => {
        const pedido = ${JSON.stringify(pedido ?? {})}

        // Acha o alvo do texto **preferindo título**. A primeira versão pegava o primeiro
        // elemento que contivesse o texto, e num relatório com índice no topo isso acerta o
        // índice em vez da seção — o dono pediu "a seção 3" e a tela parou lá em cima.
        const acharPorTexto = (busca) => {
          const alvo = String(busca).trim().toLowerCase()
          const grupos = [
            document.querySelectorAll('h1,h2,h3,h4,h5,h6'),
            document.querySelectorAll('p,li,td,th,dt,dd,label,button,a,span,div'),
          ]
          for (const grupo of grupos) {
            for (const el of grupo) {
              if (el.children.length > 0) continue
              const texto = (el.textContent || '').trim().toLowerCase()
              if (texto.startsWith(alvo)) return el
            }
          }
          for (const grupo of grupos) {
            for (const el of grupo) {
              if (el.children.length > 0) continue
              if ((el.textContent || '').toLowerCase().includes(alvo)) return el
            }
          }
          return null
        }

        let alvo = null
        let como = ''
        if (pedido.n !== undefined) {
          alvo = document.querySelector('[data-koda-n="' + pedido.n + '"]')
          como = 'elemento ' + pedido.n
        } else if (pedido.seletor) {
          alvo = document.querySelector(pedido.seletor)
          como = 'seletor ' + pedido.seletor
        } else if (pedido.texto) {
          alvo = acharPorTexto(pedido.texto)
          como = 'texto "' + pedido.texto + '"'
        }

        // Rolagem suave de propósito: quem está olhando o Painel Dev precisa VER a tela
        // andando. Salto instantâneo parece que nada aconteceu — foi a reclamação dele.
        // Sem crase neste comentário: ele vive dentro de um template literal.
        if (alvo) {
          alvo.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
          return { ok: true, como }
        }
        if (pedido.n !== undefined || pedido.seletor || pedido.texto) {
          return { ok: false, motivo: 'não achei ' + como }
        }

        if (pedido.destino === 'topo') {
          window.scrollTo({ top: 0, behavior: 'smooth' })
          return { ok: true, como: 'topo' }
        }
        if (pedido.destino === 'fim') {
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
          return { ok: true, como: 'fim' }
        }
        if (typeof pedido.y === 'number') {
          window.scrollTo({ top: pedido.y, behavior: 'smooth' })
          return { ok: true, como: pedido.y + 'px' }
        }
        return {
          ok: false,
          motivo: 'diga onde parar: n (número do ler), seletor, texto, destino (topo/fim) ou y (pixels)',
        }
      })()
    `)
    if (!resultado?.ok) throw new Error(resultado?.motivo ?? 'não consegui rolar a página')

    // Espera a rolagem suave assentar antes de medir: medir na hora devolveria a posição
    // antiga, e aí o painel acompanharia o lugar errado.
    await this._esperarRolagem()
    const onde = await this.avaliar(
      '({ topo: Math.round(window.scrollY), total: Math.round(document.documentElement.scrollHeight), janela: window.innerHeight })',
    )
    this._rolagem = onde
    this._alvoRolagem = pedido?.texto ?? null
    this._publicar(true)
    return { ...resultado, ...onde }
  }

  /** Espera o `scrollY` parar de mudar. Teto curto: a rolagem suave leva poucas centenas de ms. */
  async _esperarRolagem(limiteMs = 2500) {
    const fim = Date.now() + limiteMs
    let anterior = -1
    while (Date.now() < fim) {
      await dormir(120)
      try {
        const agora = await this.avaliar('Math.round(window.scrollY)')
        if (agora === anterior) return
        anterior = agora
      } catch {
        return
      }
    }
  }

  /**
   * O que a página tem de **visual**, em números: cor, fundo, fonte, tamanho, posição.
   *
   * Existe porque a IA lê texto, não pixels. Perguntada sobre a cor de um selo, ela só podia
   * responder "não dá para afirmar pelo texto" — e tirar print não resolve, porque o print vira
   * um arquivo que ela não enxerga. Aqui vêm os valores que o navegador calculou: é mais exato
   * do que olhar a imagem, e responde cor, fonte, tamanho e posição sem depender de visão.
   */
  async estilo(pedido) {
    const resultado = await this.avaliar(`
      (() => {
        const pedido = ${JSON.stringify(pedido ?? {})}

        const acharPorTexto = (busca) => {
          const alvo = String(busca).trim().toLowerCase()
          const grupos = [
            document.querySelectorAll('h1,h2,h3,h4,h5,h6'),
            document.querySelectorAll('p,li,td,th,dt,dd,label,button,a,span,div'),
          ]
          for (const grupo of grupos) {
            for (const el of grupo) {
              if (el.children.length > 0) continue
              const texto = (el.textContent || '').trim().toLowerCase()
              if (texto.startsWith(alvo)) return el
            }
          }
          for (const grupo of grupos) {
            for (const el of grupo) {
              if (el.children.length > 0) continue
              if ((el.textContent || '').toLowerCase().includes(alvo)) return el
            }
          }
          return null
        }

        const resumo = (el) => {
          const s = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          const texto = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80)
          return {
            elemento: el.tagName.toLowerCase(),
            texto,
            cor: s.color,
            fundo: s.backgroundColor,
            fonte: s.fontFamily,
            tamanho: s.fontSize,
            peso: s.fontWeight,
            entrelinha: s.lineHeight,
            alinhamento: s.textAlign,
            borda: s.border,
            canto: s.borderRadius,
            tamanhoNaTela: Math.round(r.width) + 'x' + Math.round(r.height),
            posicao: Math.round(r.left + window.scrollX) + ',' + Math.round(r.top + window.scrollY),
          }
        }

        // Sem alvo: um retrato visual da página — as cores e fontes que mais aparecem, e a
        // lista de títulos com o estilo de cada um. É o "ver tudo" em forma de número.
        if (!pedido.n && !pedido.seletor && !pedido.texto) {
          const contar = (mapa, chave) => {
            if (!chave) return
            mapa[chave] = (mapa[chave] || 0) + 1
          }
          const cores = {}
          const fundos = {}
          const fontes = {}
          for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el)
            if (s.display === 'none' || s.visibility === 'hidden') continue
            const temTexto = (el.innerText || '').trim().length > 0
            if (temTexto) contar(cores, s.color)
            if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') contar(fundos, s.backgroundColor)
            contar(fontes, s.fontFamily)
          }
          const topo = (mapa, quantos) =>
            Object.entries(mapa).sort((a, b) => b[1] - a[1]).slice(0, quantos)
          return {
            ok: true,
            retrato: {
              coresDeTexto: topo(cores, 5),
              coresDeFundo: topo(fundos, 5),
              fontes: topo(fontes, 3),
              fundoDaPagina: getComputedStyle(document.body).backgroundColor,
              titulos: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
                .slice(0, 12)
                .map((h) => resumo(h)),
            },
          }
        }

        let alvo = null
        let como = ''
        if (pedido.n !== undefined) {
          alvo = document.querySelector('[data-koda-n="' + pedido.n + '"]')
          como = 'elemento ' + pedido.n
        } else if (pedido.seletor) {
          alvo = document.querySelector(pedido.seletor)
          como = 'seletor ' + pedido.seletor
        } else {
          alvo = acharPorTexto(pedido.texto)
          como = 'texto "' + pedido.texto + '"'
        }
        if (!alvo) return { ok: false, motivo: 'não achei ' + como }
        return { ok: true, como, estilo: resumo(alvo) }
      })()
    `)
    if (!resultado?.ok) throw new Error(resultado?.motivo ?? 'não consegui medir o estilo')
    return resultado
  }

  /**
   * A leitura do **render** — o que está de fato desenhado, em números exatos.
   *
   * O `ler` devolve texto; isto devolve o desenho. Cada nó que o navegador realmente pintou
   * entra com geometria (x, y, largura e altura em coordenadas de página), as cores e as
   * fontes que ele **computou**, borda, canto, sombra, empilhamento, rolagem interna, se está
   * fora da janela ou coberto por outro elemento — e o texto **próprio** daquele nó, sem
   * repetir o dos filhos. `canvas` entra com as dimensões e uma amostra real de pixels;
   * `img` com o tamanho natural.
   *
   * **Nada de captura de tela.** São os números que o próprio motor do navegador calculou —
   * mais exatos do que olhar uma imagem, e sem depender de o modelo enxergar arquivo. A lista
   * é limitada em nós e em bytes, porque a saída de uma ferramenta tem teto.
   */
  async enxergar(pedido) {
    const resultado = await this.avaliar(`
      (() => {
        const pedido = ${JSON.stringify(pedido ?? {})}
        const teto = Math.min(Math.max(Number(pedido.limite) || 300, 1), 3000)
        const tetoCaracteres = Math.min(Math.max(Number(pedido.caracteres) || 0, 0), 2000)

        const acharPorTexto = (busca) => {
          const alvo = String(busca).trim().toLowerCase()
          const grupos = [
            document.querySelectorAll('h1,h2,h3,h4,h5,h6'),
            document.querySelectorAll('p,li,td,th,dt,dd,label,button,a,span,div'),
          ]
          for (const grupo of grupos) {
            for (const el of grupo) {
              if (el.children.length > 0) continue
              if ((el.textContent || '').trim().toLowerCase().startsWith(alvo)) return el
            }
          }
          for (const grupo of grupos) {
            for (const el of grupo) {
              if (el.children.length > 0) continue
              if ((el.textContent || '').toLowerCase().includes(alvo)) return el
            }
          }
          return null
        }

        let raiz = document.body
        let como = 'página inteira'
        if (pedido.n !== undefined) {
          raiz = document.querySelector('[data-koda-n="' + pedido.n + '"]')
          como = 'elemento ' + pedido.n
        } else if (pedido.seletor) {
          raiz = document.querySelector(pedido.seletor)
          como = 'seletor ' + pedido.seletor
        } else if (pedido.texto) {
          raiz = acharPorTexto(pedido.texto)
          como = 'texto "' + pedido.texto + '"'
        }
        if (!raiz) return { ok: false, motivo: 'não achei ' + como }

        const sx = window.scrollX || window.pageXOffset || 0
        const sy = window.scrollY || window.pageYOffset || 0
        const janela = { l: window.innerWidth, a: window.innerHeight }
        const regiao = (typeof pedido.x === 'number' && typeof pedido.y === 'number' &&
                        typeof pedido.largura === 'number' && typeof pedido.altura === 'number')
          ? { x: pedido.x, y: pedido.y, l: pedido.largura, a: pedido.altura }
          : null

        const escondidas = { script: 1, style: 1, meta: 1, link: 1, title: 1, noscript: 1, template: 1, head: 1 }

        // Devolve estilo e caixa quando o nó foi **desenhado**, ou null. Guardar os dois aqui
        // evita chamar getComputedStyle e getBoundingClientRect de novo na hora de escrever a
        // linha — numa página grande são milhares de chamadas, e é o que faz a leitura caber
        // no tempo em vez de arrastar.
        const estiloVisivel = (el) => {
          const s = getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return null
          if (Number(s.opacity) === 0) return null
          const r = el.getBoundingClientRect()
          if (!(r.width > 0 && r.height > 0)) return null
          return { s, r }
        }

        const rotulo = (el) => {
          const tag = el.tagName.toLowerCase()
          const id = el.id ? '#' + el.id : ''
          const c = el.getAttribute('class')
          const cls = c ? '.' + c.trim().split(/\\s+/).slice(0, 3).join('.') : ''
          return tag + id + cls
        }

        const textoProprio = (el) => {
          let t = ''
          for (const no of el.childNodes) if (no.nodeType === 3) t += no.nodeValue
          return t.replace(/\\s+/g, ' ').trim()
        }

        // O alvo está acima do nó na árvore **plana**? Precisa subir pelo host do
        // shadowRoot, senão o conteúdo de um componente aparece como "coberto pelo próprio
        // componente" — o elementFromPoint devolve o host, e o contains do DOM normal não
        // enxerga essa ligação.
        const naCadeia = (de, alvo) => {
          let n = de
          while (n) {
            if (n === alvo) return true
            n = n.parentNode || n.host || null
          }
          return false
        }

        // O texto que o navegador desenha por ::before / ::after. Sem isto, um ícone ou um
        // selo feito em CSS aparece na tela e some da leitura — o nó fica "vazio" para a IA.
        const conteudoPseudo = (el, qual) => {
          try {
            const c = getComputedStyle(el, qual).content
            if (!c || c === 'none' || c === 'normal' || c === 'open-quote' || c === 'close-quote') return ''
            return c.replace(/^["']|["']$/g, '')
          } catch {
            return ''
          }
        }

        // Coleta os nós **que o navegador desenhou**: os que têm caixa. O que está com
        // display:none, opacidade 0 ou sem tamanho não foi pintado e não entra — ler o que
        // não está na tela seria descrever uma página que ninguém está vendo.
        //
        // A coleta **não** para no teto da página: é ela que diz o total, e é o total que
        // permite paginar sem perder nada. O teto só limita o que sai escrito.
        const TETO_COLETA = 20000
        const recolhidos = []
        let parouNaColeta = false
        const visitar = (el, profundidade, sombra) => {
          if (recolhidos.length >= TETO_COLETA) {
            parouNaColeta = true
            return
          }
          if (escondidas[el.tagName.toLowerCase()]) return
          if (el.tagName === 'IFRAME') {
            const v = estiloVisivel(el)
            if (v) recolhidos.push({ el, profundidade, sombra, s: v.s, r: v.r })
            // Iframe de outra origem não é alcançável — o navegador não deixa. De mesma
            // origem, sim, e aí descemos nele em vez de parar no quadro.
            try {
              const doc = el.contentDocument
              if (doc && doc.body) for (const f of doc.body.children) visitar(f, profundidade + 1, sombra)
            } catch {
              // origem diferente: fica só o quadro
            }
            return
          }
          const v = estiloVisivel(el)
          if (v) {
            let dentro = true
            if (regiao) {
              const r = v.r
              dentro = (r.left + sx) < (regiao.x + regiao.l) && (r.left + sx + r.width) > regiao.x &&
                       (r.top + sy) < (regiao.y + regiao.a) && (r.top + sy + r.height) > regiao.y
            }
            if (dentro) recolhidos.push({ el, profundidade, sombra, s: v.s, r: v.r })
          }
          for (const f of el.children) visitar(f, profundidade + 1, sombra)
          // O conteúdo de um componente (web component) NÃO está em children: mora no
          // shadowRoot. Sem isto a IA veria a casca e nada de dentro do componente. Raiz
          // **fechada** não é alcançável por JavaScript nenhum — essa continua invisível, e
          // é limite do navegador, não escolha daqui.
          if (el.shadowRoot) {
            for (const f of el.shadowRoot.children) visitar(f, profundidade + 1, true)
          }
        }
        visitar(raiz, 0, false)

        const curto = (v, n) => {
          const s = String(v == null ? '' : v)
          return s.length > n ? s.slice(0, n - 1) + '…' : s
        }
        const semEspaco = (v) => String(v || '').replace(/\\s+/g, '')

        // A fatia que sai escrita. Os índices são **absolutos** — a posição do nó na página
        // inteira —, e não relativos à fatia: é o que faz "continue com inicio=N" funcionar
        // sem o modelo ter de somar nada.
        const de = Math.max(0, Math.min(Number(pedido.inicio) || 0, recolhidos.length))
        const ate = Math.min(recolhidos.length, de + teto)

        const linhas = []
        const canvases = []
        for (let i = de; i < ate; i++) {
          const item = recolhidos[i]
          const el = item.el
          const s = item.s
          const r = item.r
          const x = Math.round(r.left + sx)
          const y = Math.round(r.top + sy)
          const l = Math.round(r.width)
          const a = Math.round(r.height)

          const partes = [rotulo(el), '@' + x + ',' + y + ' ' + l + 'x' + a]
          if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') partes.push('fundo=' + semEspaco(s.backgroundColor))
          if (s.backgroundImage !== 'none') partes.push('fundo-img=' + curto(s.backgroundImage, 44))
          partes.push('cor=' + semEspaco(s.color))

          const proprio = textoProprio(el)
          const valor = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
            ? String(el.value == null ? '' : el.value) : ''
          if (proprio || valor) {
            const fam = s.fontFamily.split(',')[0].replace(/["']/g, '').trim()
            partes.push('fonte=' + s.fontSize + '/' + s.lineHeight + ' ' + s.fontWeight + ' ' + fam)
            if (s.letterSpacing !== 'normal') partes.push('espaco=' + s.letterSpacing)
            if (s.textAlign !== 'start' && s.textAlign !== 'left') partes.push('alinhamento=' + s.textAlign)
            if (s.textTransform !== 'none') partes.push('caixa=' + s.textTransform)
            if (s.textDecorationLine !== 'none') partes.push('deco=' + s.textDecorationLine)
          }
          if (s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0) {
            partes.push('borda=' + semEspaco(s.borderTopWidth) + ' ' + s.borderTopStyle + ' ' + semEspaco(s.borderTopColor))
          }
          if (s.borderRadius !== '0px') partes.push('canto=' + curto(semEspaco(s.borderRadius), 24))
          if (s.boxShadow !== 'none') {
            // Camada **totalmente transparente** é ruído: o Tailwind deixa
            // rgba(0, 0, 0, 0) 0px 0px 0px 0px em todo elemento com --tw-shadow, e isso não
            // é sombra nenhuma. As camadas invisíveis saem e fica só a sombra que existe —
            // truncar a string inteira esconderia justamente a camada que importa.
            const camadas = s.boxShadow
              .split(/,(?![^(]*\\))/)
              .map((c) => c.trim())
              .filter((c) => c && !/^rgba?\\(\\s*0,\\s*0,\\s*0,\\s*0\\s*\\)/.test(c))
            if (camadas.length) partes.push('sombra=' + curto(camadas.join(', '), 60))
          }
          if (Number(s.opacity) < 1) partes.push('opacidade=' + s.opacity)
          if (s.position !== 'static') partes.push('pos=' + s.position)
          if (s.zIndex !== 'auto') partes.push('z=' + s.zIndex)
          if (s.overflow !== 'visible') partes.push('overflow=' + s.overflow)
          if (s.transform !== 'none') partes.push('transform=' + curto(s.transform, 36))
          if (s.filter !== 'none') partes.push('filtro=' + curto(s.filter, 28))
          // Só o cursor que **diz alguma coisa**: pointer é "isto é clicável", text é
          // "aqui se escreve". default é o padrão de todo botão e só poluiria a linha.
          if (s.cursor === 'pointer' || s.cursor === 'text' || s.cursor === 'grab' || s.cursor === 'move') {
            partes.push('cursor=' + s.cursor)
          }
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
            partes.push('rolavel=' + el.scrollWidth + 'x' + el.scrollHeight)
          }

          // Onde o nó está de fato: fora da janela (desenhado, mas fora de vista), coberto
          // por outro elemento, ou à vista. A árvore do DOM não sabe nada disso — é a
          // diferença entre "existe" e "está na tela".
          const naJanela = r.bottom > 0 && r.top < janela.a && r.right > 0 && r.left < janela.l
          if (!naJanela) {
            partes.push('fora-da-janela')
          } else if (s.pointerEvents !== 'none') {
            const px = Math.min(Math.max(Math.round(r.left + r.width / 2), 0), janela.l - 1)
            const py = Math.min(Math.max(Math.round(r.top + r.height / 2), 0), janela.a - 1)
            const topo = document.elementFromPoint(px, py)
            if (topo && !el.contains(topo) && !naCadeia(el, topo)) partes.push('coberto-por=' + rotulo(topo))
          }

          if (el.tagName === 'IMG') {
            partes.push('imagem=' + el.naturalWidth + 'x' + el.naturalHeight + (el.complete ? '' : '(carregando)'))
            partes.push('src=' + curto(el.currentSrc || el.src, 60))
            if (el.alt) partes.push('alt="' + curto(el.alt, 40) + '"')
          }
          if (el.tagName === 'CANVAS') {
            partes.push('canvas=' + el.width + 'x' + el.height)
            canvases.push({ el, seletor: rotulo(el) })
          }
          if (el.tagName === 'IFRAME') partes.push('iframe=' + curto(el.src || el.getAttribute('src') || '', 60))
          if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
            partes.push('midia=' + curto(el.currentSrc || el.src || '', 50) + (el.paused ? ' (pausado)' : ' (tocando)'))
          }

          const antes = conteudoPseudo(el, '::before')
          const depois = conteudoPseudo(el, '::after')
          if (antes) partes.push('antes="' + curto(antes, 40) + '"')
          if (depois) partes.push('depois="' + curto(depois, 40) + '"')

          const mostrado = proprio || valor
          const recuo = '  '.repeat(Math.min(item.profundidade, 12))
          linhas.push(
            recuo + '[' + i + ']' + (item.sombra ? ' shadow' : '') + ' ' + partes.join(' ') +
            (mostrado ? ' "' + curto(mostrado, 100) + '"' : ''),
          )
        }

        // Caixas por caractere: a posição exata de cada letra, medida com Range. Só o
        // texto **próprio** de cada nó entra (senão o texto do filho seria contado de novo
        // no pai). É o que responde "onde exatamente está esta letra".
        const caixas = []
        if (tetoCaracteres > 0) {
          let restam = tetoCaracteres
          for (let ind = de; ind < ate && restam > 0; ind++) {
            const item = recolhidos[ind]
            for (const no of item.el.childNodes) {
              if (no.nodeType !== 3 || restam <= 0) continue
              const t = no.nodeValue
              if (!t || !t.trim()) continue
              for (let k = 0; k < t.length && restam > 0; k++) {
                if (/\\s/.test(t[k])) continue
                const faixa = document.createRange()
                faixa.setStart(no, k)
                faixa.setEnd(no, k + 1)
                const rr = faixa.getBoundingClientRect()
                if (rr.width === 0 && rr.height === 0) continue
                caixas.push('"' + t[k] + '"(' + Math.round(rr.left + sx) + ',' + Math.round(rr.top + sy) +
                            ' ' + rr.width.toFixed(1) + 'x' + rr.height.toFixed(1) + ')')
                restam--
              }
            }
          }
        }

        // Canvas: o conteúdo é pixel de verdade. Desenhamos o canvas num quadro pequeno e
        // lemos os pixels **de lá** — assim uma grade de 8x4 custa 32 pixels lidos, não os
        // milhões do canvas inteiro. Canvas contaminado por imagem de outra origem recusa a
        // leitura, e isso é dito com todas as letras em vez de virar "vazio".
        const canvasInfo = []
        for (const c of canvases.slice(0, 6)) {
          const el = c.el
          const info = { seletor: c.seletor, w: el.width, h: el.height }
          try {
            if (!el.width || !el.height) {
              info.erro = 'canvas sem pixels (largura ou altura zero)'
            } else {
              const cols = 8
              const rows = 4
              const tmp = document.createElement('canvas')
              tmp.width = cols
              tmp.height = rows
              const tctx = tmp.getContext('2d')
              tctx.drawImage(el, 0, 0, cols, rows)
              const dados = tctx.getImageData(0, 0, cols, rows).data
              const contagem = {}
              const grade = []
              for (let ry = 0; ry < rows; ry++) {
                const linha = []
                for (let rx = 0; rx < cols; rx++) {
                  const idx = (ry * cols + rx) * 4
                  const cor = dados[idx + 3] === 0
                    ? 'transparente'
                    : '#' + [dados[idx], dados[idx + 1], dados[idx + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
                  linha.push(cor)
                  contagem[cor] = (contagem[cor] || 0) + 1
                }
                grade.push(linha)
              }
              info.grade = grade
              info.cores = Object.entries(contagem).sort((a, b) => b[1] - a[1]).slice(0, 6)
                .map((par) => par[0] + '(' + par[1] + ')')
            }
          } catch {
            info.erro = 'não consegui ler os pixels — o canvas está contaminado por imagem de outra origem'
          }
          canvasInfo.push(info)
        }

        return {
          ok: true,
          url: location.href,
          titulo: document.title,
          como,
          janela,
          rolagem: {
            x: Math.round(sx),
            y: Math.round(sy),
            total: Math.round(document.documentElement.scrollHeight),
          },
          zoom: window.devicePixelRatio,
          total: recolhidos.length,
          parouNaColeta,
          teto,
          de,
          ate,
          mostrando: linhas.length,
          linhas,
          caixas,
          canvases: canvasInfo,
          fundo: getComputedStyle(document.body).backgroundColor,
          fonteBase: getComputedStyle(document.body).fontFamily.split(',')[0].replace(/["']/g, '').trim(),
        }
      })()
    `)
    if (!resultado?.ok) throw new Error(resultado?.motivo ?? 'não consegui ler o render da página')

    const linhas = []
    linhas.push('render: ' + resultado.como + ' — ' + resultado.url)
    linhas.push('título: ' + (resultado.titulo || '(sem título)'))
    linhas.push(
      'janela: ' + resultado.janela.l + 'x' + resultado.janela.a +
      ' · rolagem ' + resultado.rolagem.x + ',' + resultado.rolagem.y + ' de ' + resultado.rolagem.total + 'px' +
      ' · zoom ' + resultado.zoom,
    )
    linhas.push(
      'nós desenhados: ' + resultado.total +
      (resultado.parouNaColeta ? ' (a varredura parou no teto de 20000 nós)' : '') +
      ' · esta chamada começa no nó ' + resultado.de,
    )
    linhas.push('fundo da página: ' + resultado.fundo + ' · fonte base: ' + resultado.fonteBase)
    linhas.push('')
    linhas.push('x,y são coordenadas de página (do canto superior esquerdo do documento); o recuo é a profundidade na árvore; "shadow" = nó dentro do shadow DOM de um componente; "fora-da-janela" = desenhado mas fora de vista; "coberto-por" = outro elemento está por cima; "antes"/"depois" = texto que o ::before/::after desenha')
    linhas.push('')

    // Teto **nosso**, não do backend: o resultado de uma ferramenta MCP chega ao modelo
    // inteiro — só as ferramentas do Koda passam pelo limitador de saída. Este teto existe
    // para uma leitura só não engolir o contexto, e o que passa dele **não se perde**: a
    // próxima chamada continua pelo `inicio`.
    const TETO_BYTES = 100000
    let usado = linhas.join('\n').length
    let mostrados = 0
    for (const linha of resultado.linhas) {
      if (usado + linha.length + 1 > TETO_BYTES) break
      linhas.push(linha)
      usado += linha.length + 1
      mostrados++
    }
    const fim = resultado.de + mostrados
    if (fim < resultado.total) {
      const porBytes = resultado.linhas.length > mostrados
      linhas.push('')
      linhas.push(
        '… mostrei os nós ' + resultado.de + ' a ' + (fim - 1) + ' de ' + resultado.total + ' — ' +
        (porBytes
          ? 'o teto de tamanho desta resposta foi atingido'
          : 'o limite desta chamada (' + resultado.teto + ') acabou') +
        '. Nada se perdeu: para continuar exatamente de onde parou, chame de novo com inicio=' + fim +
        (porBytes ? '' : ' e um limite maior') +
        '. Se você quer só uma parte, aponte com seletor, texto ou região — é mais direto.',
      )
    }
    if (resultado.caixas?.length) {
      linhas.push('')
      linhas.push('caixas de texto por caractere (' + resultado.caixas.length + '):')
      linhas.push('  ' + resultado.caixas.join(' '))
    }
    for (const c of resultado.canvases ?? []) {
      linhas.push('')
      linhas.push('canvas ' + c.seletor + ' — ' + c.w + 'x' + c.h + ' px')
      if (c.erro) {
        linhas.push('  ' + c.erro)
      } else {
        linhas.push('  cores mais frequentes: ' + c.cores.join(', '))
        linhas.push('  amostra (grade ' + c.grade[0].length + 'x' + c.grade.length + '):')
        for (const faixa of c.grade) linhas.push('    ' + faixa.join(' '))
      }
    }
    return linhas.join('\n')
  }

  /**
   * A varredura de **pixels**: quem é dono de cada ponto da janela.
   *
   * Para cada faixa horizontal, anda de `passo` em `passo` pixels e pergunta ao navegador
   * qual elemento está **por cima** naquele ponto (`elementFromPoint`) — e junta os trechos
   * vizinhos do mesmo dono. É a leitura linha a linha da tela, e ela responde o que a árvore
   * do DOM não responde: o que está sobreposto, o que ficou escondido atrás de outro, o que
   * de fato ocupa o espaço.
   *
   * `agrupar` (padrão ligado) sobe cada ponto até o ancestral mais próximo com id ou classe:
   * sem isso, um texto dentro de um botão apareceria como "span" em vez de "button".
   */
  async pixels(pedido) {
    const resultado = await this.avaliar(`
      (() => {
        const pedido = ${JSON.stringify(pedido ?? {})}
        const passo = Math.min(Math.max(Number(pedido.passo) || 8, 1), 64)
        const quantas = Math.min(Math.max(Number(pedido.linhas) || 12, 1), 60)
        const agrupar = pedido.agrupar === false ? false : true
        const W = window.innerWidth
        const H = window.innerHeight

        const nome = (el) => {
          const tag = el.tagName.toLowerCase()
          const id = el.id ? '#' + el.id : ''
          const c = el.getAttribute('class')
          const cls = c ? '.' + c.trim().split(/\\s+/).slice(0, 2).join('.') : ''
          return tag + id + cls
        }
        const rotulo = (el) => {
          if (!agrupar) return nome(el)
          let atual = el
          while (atual && atual !== document.body && atual.parentElement) {
            if (atual.id || (atual.getAttribute('class') || '').trim()) return nome(atual)
            atual = atual.parentElement
          }
          return nome(el)
        }

        const faixas = []
        for (let i = 0; i < quantas; i++) {
          const y = Math.min(H - 1, Math.max(0, Math.round((i + 0.5) * H / quantas)))
          const trechos = []
          let atual = null
          let inicio = 0
          for (let x = 0; x < W; x += passo) {
            const px = Math.min(W - 1, x + Math.floor(passo / 2))
            const el = document.elementFromPoint(px, y)
            const chave = el ? rotulo(el) : '(vazio)'
            if (chave !== atual) {
              if (atual !== null) trechos.push({ de: inicio, ate: x, quem: atual })
              atual = chave
              inicio = x
            }
          }
          trechos.push({ de: inicio, ate: W, quem: atual })
          faixas.push({ y, trechos })
        }

        return {
          ok: true,
          janela: { l: W, a: H },
          passo,
          linhas: quantas,
          rolagem: Math.round(window.scrollY || 0),
          faixas,
        }
      })()
    `)
    if (!resultado?.ok) throw new Error('não consegui ler os pixels da janela')

    const linhas = [
      'pixels: janela ' + resultado.janela.l + 'x' + resultado.janela.a +
      ' · passo ' + resultado.passo + 'px · ' + resultado.linhas + ' faixas · rolagem ' + resultado.rolagem + 'px',
      'cada trecho é [x inicial..x final] e o elemento que está por cima ali',
      '',
    ]
    // Mesmo teto do `enxergar`: é nosso, não do backend, e existe só para uma varredura não
    // engolir o contexto. Numa página com muita sobreposição uma faixa vira dezenas de
    // trechos, e é fácil passar disso.
    const TETO_BYTES = 100000
    let usado = linhas.join('\n').length
    let mostradas = 0
    for (const faixa of resultado.faixas) {
      const trechos = faixa.trechos
        .map((t) => '[' + t.de + '..' + t.ate + '] ' + (t.quem || '(vazio)'))
        .join(' | ')
      const linha = 'y=' + faixa.y + ': ' + trechos
      if (usado + linha.length + 1 > TETO_BYTES) break
      linhas.push(linha)
      usado += linha.length + 1
      mostradas++
    }
    if (mostradas < resultado.faixas.length) {
      linhas.push(
        '… (' + (resultado.faixas.length - mostradas) +
        ' faixas não couberam — reduza o `passo` para as faixas ficarem mais curtas, ou as `linhas`)',
      )
    }
    return linhas.join('\n')
  }

  /**
   * Marca (seleciona) um trecho, como quem arrasta o mouse por cima.
   *
   * É seleção **de verdade**: `Selection`/`Range` do navegador, a mesma coisa que o Ctrl+A
   * produz. O que fica azul na tela é o que a IA marcou.
   */
  async marcar(pedido) {
    const resultado = await this.avaliar(`
      (() => {
        const pedido = ${JSON.stringify(pedido ?? {})}
        const selecao = window.getSelection()
        if (!selecao) return { ok: false, motivo: 'esta página não tem seleção' }
        selecao.removeAllRanges()

        if (pedido.texto) {
          const busca = String(pedido.texto).toLowerCase()
          const andar = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          let no = null
          let posicao = -1
          while ((no = andar.nextNode())) {
            const achou = (no.nodeValue || '').toLowerCase().indexOf(busca)
            if (achou >= 0) {
              posicao = achou
              break
            }
          }
          if (posicao < 0) return { ok: false, motivo: 'não achei o texto "' + pedido.texto + '" na página' }
          const faixa = document.createRange()
          faixa.setStart(no, posicao)
          faixa.setEnd(no, posicao + String(pedido.texto).length)
          selecao.addRange(faixa)
          if (no.parentElement) no.parentElement.scrollIntoView({ block: 'center' })
          return { ok: true, como: 'texto', marcado: selecao.toString() }
        }

        let alvo = null
        let como = ''
        if (pedido.n !== undefined) {
          alvo = document.querySelector('[data-koda-n="' + pedido.n + '"]')
          como = 'elemento ' + pedido.n
        } else if (pedido.seletor) {
          alvo = document.querySelector(pedido.seletor)
          como = 'seletor ' + pedido.seletor
        } else if (pedido.tudo) {
          alvo = document.body
          como = 'página inteira'
        }
        if (!alvo) {
          return { ok: false, motivo: 'diga o que marcar: texto, n (número do ler), seletor ou tudo' }
        }
        const faixa = document.createRange()
        faixa.selectNodeContents(alvo)
        selecao.addRange(faixa)
        alvo.scrollIntoView({ block: 'center' })
        return { ok: true, como, marcado: selecao.toString().slice(0, 300) }
      })()
    `)
    if (!resultado?.ok) throw new Error(resultado?.motivo ?? 'não consegui marcar')
    return resultado
  }

  async quadro() {
    const r = await this.enviar('Page.captureScreenshot', { format: 'jpeg', quality: 70 })
    return Buffer.from(r.data, 'base64')
  }

  // -------------------------------------------------- espelho do painel

  /**
   * O que o painel precisa saber, e o último quadro.
   *
   * Isto é o que faz o painel mostrar a **mesma** sessão: em vez de o painel ter um navegador
   * próprio (que não conseguiria ler nem clicar em página de outra origem), ele desenha o
   * quadro que este processo publica.
   */
  _publicar(vivo) {
    try {
      writeFileSync(
        join(this._dados, 'dev-browser.json'),
        JSON.stringify(
          {
            vivo: Boolean(vivo),
            porta: this.porta,
            url: this.url,
            titulo: this.titulo,
            // A rolagem vai junto porque o painel é **outra** instância do navegador: ele
            // carrega a página do zero e, sem isto, fica sempre no topo enquanto a IA lê lá
            // embaixo.
            //
            // O `alvo` (o texto que a IA foi olhar) importa mais do que a altura: a fração
            // sozinha **erra a seção** quando a largura é outra — o painel é estreito, o texto
            // quebra mais, e a mesma fração cai em outro trecho. Com o texto, o painel acha a
            // mesma seção na própria renderização dele.
            rolagem: this._rolagem ? { ...this._rolagem, alvo: this._alvoRolagem } : null,
            atualizado: Date.now(),
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch (erro) {
      log('não consegui publicar o estado:', erro.message)
    }

    // O feed de erros vai em **arquivo separado**, e não dentro do `dev-browser.json`: são dois
    // consumidores diferentes e com ritmos diferentes. O painel lê o estado a cada 1,5 s; o MCP
    // `koda-dev-logs` lê este aqui quando a IA pergunta. Misturar os dois faria o painel carregar
    // a lista inteira de erros a cada tique.
    try {
      writeFileSync(
        join(this._dados, 'dev-browser-logs.json'),
        JSON.stringify(
          {
            atualizado: Date.now(),
            porta: this.porta,
            url: this.url,
            titulo: this.titulo,
            // Já ordenado do mais recente para o mais antigo: quem lê quer o que acabou de
            // acontecer no topo, não a primeira ocorrência da sessão.
            erros: [...this._feed.values()].sort((a, b) => b.ultimo - a.ultimo),
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch (erro) {
      log('não consegui publicar os erros:', erro.message)
    }
  }

  _ligarEspelho() {
    if (this._relogio) return
    this._relogio = setInterval(async () => {
      if (!this.vivo) return
      try {
        const quadro = await this.quadro()
        writeFileSync(join(this._dados, 'dev-browser.png'), quadro)
        await this._atualizarTitulo()
        this._rolagem = await this.avaliar(
          '({ topo: Math.round(window.scrollY), total: Math.round(document.documentElement.scrollHeight), janela: window.innerHeight })',
        )
        this._publicar(true)
      } catch {
        // página no meio de uma navegação: o quadro sai no próximo tique
      }
    }, 900)
    // O relógio não pode segurar o processo vivo: quem manda nele é o `stdin` do MCP.
    this._relogio.unref?.()
  }

  _desligarEspelho() {
    if (this._relogio) clearInterval(this._relogio)
    this._relogio = null
  }
}

// ---------------------------------------------------------------- ferramentas

const navegador = new Navegador()

const FERRAMENTAS = [
  {
    name: 'abrir',
    description:
      'Abre um endereço no navegador do Painel Dev. Aceita qualquer site (https://exemplo.com), ' +
      'servidor de dev (http://localhost:PORT/…) e arquivo do disco (C:/pasta/arquivo.html ou ' +
      'file:///C:/pasta/arquivo.html). Devolve a URL e o título.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Endereço ou caminho a abrir.' } },
      required: ['url'],
    },
    async run({ url }) {
      const aceito = enderecoAceito(url)
      if (!aceito.ok) throw new Error(aceito.motivo)
      await navegador.abrir()
      const resultado = await navegador.ir(aceito.url)
      return `aberto: ${resultado.url}\ntítulo: ${resultado.titulo || '(sem título)'}`
    },
  },
  {
    name: 'ler',
    description:
      'Lê a página aberta: URL, título, o texto visível e a lista numerada de elementos interativos ' +
      '(links, botões, campos). Use os números dessa lista em `clicar` e `digitar`.\n\n' +
      'Devolve o texto visível **inteiro** de uma vez, então dá para responder sem rolar. Mas ler ' +
      'não move a tela: se a pessoa pediu para ver um trecho, chame `rolar` também, senão o Painel ' +
      'Dev dela continua no topo.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      await navegador.abrir()
      const dados = await navegador.ler()
      const elementos = (dados.elementos ?? [])
        .map((e) => `  [${e.n}] ${e.tag}${e.rotulo ? ' — ' + e.rotulo : ''}${e.href ? ' → ' + e.href : ''}`)
        .join('\n')
      return [
        `url: ${dados.url}`,
        `título: ${dados.titulo || '(sem título)'}`,
        '',
        'texto visível:',
        dados.texto || '(vazio)',
        '',
        `elementos interativos (${(dados.elementos ?? []).length}):`,
        elementos || '  (nenhum)',
      ].join('\n')
    },
  },
  {
    name: 'clicar',
    description: 'Clica num elemento pelo número devolvido por `ler`, ou por seletor CSS.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Número do elemento, como `ler` devolveu.' },
        seletor: { type: 'string', description: 'Seletor CSS, se preferir ao número.' },
      },
    },
    async run({ n, seletor }) {
      const descricao = await navegador.clicar({ n, seletor })
      return `cliquei em: ${descricao}\nagora em: ${navegador.url}`
    },
  },
  {
    name: 'digitar',
    description: 'Escreve num campo (pelo número de `ler` ou por seletor CSS) e opcionalmente tecla Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Número do campo, como `ler` devolveu.' },
        seletor: { type: 'string', description: 'Seletor CSS, se preferir ao número.' },
        texto: { type: 'string', description: 'O que escrever.' },
        enter: { type: 'boolean', description: 'Teclar Enter depois.' },
      },
      required: ['texto'],
    },
    async run({ n, seletor, texto, enter }) {
      const descricao = await navegador.digitar({ n, seletor }, texto, enter)
      return `escrevi em: ${descricao}${enter ? ' (+ Enter)' : ''}`
    },
  },
  {
    name: 'rolar',
    description:
      'Rola a página e para num lugar. Diga onde por um destes: `n` (número que `ler` devolveu), ' +
      '`seletor` (CSS), `texto` (um trecho visível na tela), `destino` ("topo" ou "fim") ou `y` ' +
      '(altura em pixels). Devolve onde parou e o tamanho total da página.\n\n' +
      'IMPORTANTE: use isto SEMPRE que a pessoa pedir para ver, mostrar, ir até ou "rolar até" ' +
      'alguma parte — e use ANTES de responder. O `ler` já devolve o texto todo de uma vez, então ' +
      'você consegue responder sem rolar; mas a pessoa está olhando o Painel Dev, que mostra a ' +
      'mesma página, e é esta chamada que faz o painel ir para o mesmo lugar. Sem ela, ela lê a ' +
      'resposta enquanto a tela continua no topo — e parece que você não fez nada.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Número do elemento, como `ler` devolveu.' },
        seletor: { type: 'string', description: 'Seletor CSS.' },
        texto: { type: 'string', description: 'Trecho de texto que aparece na página.' },
        destino: { type: 'string', enum: ['topo', 'fim'], description: 'Ir para o começo ou para o fim.' },
        y: { type: 'number', description: 'Altura em pixels, a partir do topo.' },
      },
    },
    async run(argumentos) {
      const r = await navegador.rolar(argumentos ?? {})
      return `rolei até ${r.como} — agora em ${r.topo}px de ${r.total}px (janela de ${r.janela}px)`
    },
  },
  {
    name: 'marcar',
    description:
      'Marca (seleciona) um trecho da página, como quem arrasta o mouse — a seleção fica visível. ' +
      'Diga o que marcar: `texto` (um trecho escrito na página), `n` (número do `ler`), `seletor` ' +
      '(CSS) ou `tudo` (a página inteira).',
    inputSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Trecho de texto a marcar.' },
        n: { type: 'number', description: 'Número do elemento, como `ler` devolveu.' },
        seletor: { type: 'string', description: 'Seletor CSS.' },
        tudo: { type: 'boolean', description: 'Marcar a página inteira.' },
      },
    },
    async run(argumentos) {
      const r = await navegador.marcar(argumentos ?? {})
      return `marquei (${r.como}): "${r.marcado}"`
    },
  },
  {
    name: 'estilo',
    description:
      'Diz o que a página tem de VISUAL, em valores exatos: cor do texto, cor de fundo, fonte, ' +
      'tamanho, peso, alinhamento, borda, cantos, tamanho e posição. Sem argumento, devolve um ' +
      'retrato da página inteira (as cores e fontes que mais aparecem, e o estilo de cada ' +
      'título). Com `n` (número do `ler`), `seletor` ou `texto`, devolve o de um elemento.\n\n' +
      'USE ISTO SEMPRE que a pergunta for sobre aparência — cor, fonte, tamanho, espaçamento, ' +
      'posição. Você lê texto, não pixels: o print é um arquivo que você não enxerga, e responder ' +
      '"não dá para afirmar pelo texto" quando a pessoa perguntou a cor é deixar a pergunta sem ' +
      'resposta. Aqui os valores são os que o navegador calculou — mais exatos do que olhar.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Número do elemento, como `ler` devolveu.' },
        seletor: { type: 'string', description: 'Seletor CSS.' },
        texto: { type: 'string', description: 'Trecho de texto que aparece na página.' },
      },
    },
    async run(argumentos) {
      const r = await navegador.estilo(argumentos ?? {})
      if (r.retrato) {
        const p = r.retrato
        const linhas = [
          `fundo da página: ${p.fundoDaPagina}`,
          `cores de texto (mais usadas): ${p.coresDeTexto.map(([c, n]) => `${c} (${n}×)`).join(', ')}`,
          `cores de fundo (mais usadas): ${p.coresDeFundo.map(([c, n]) => `${c} (${n}×)`).join(', ')}`,
          `fontes: ${p.fontes.map(([f, n]) => `${f} (${n}×)`).join(', ')}`,
          '',
          'títulos:',
          ...p.titulos.map(
            (h) => `  ${h.elemento} "${h.texto}" — ${h.tamanho} ${h.peso} ${h.cor} · ${h.fonte}`,
          ),
        ]
        return linhas.join('\n')
      }
      const e = r.estilo
      return [
        `${e.elemento} "${e.texto}"`,
        `  cor do texto: ${e.cor}`,
        `  fundo: ${e.fundo}`,
        `  fonte: ${e.fonte} ${e.tamanho} peso ${e.peso} entrelinha ${e.entrelinha}`,
        `  alinhamento: ${e.alinhamento}`,
        `  borda: ${e.borda}`,
        `  cantos: ${e.canto}`,
        `  tamanho na tela: ${e.tamanhoNaTela}`,
        `  posição na página: ${e.posicao}`,
      ].join('\n')
    },
  },
  {
    name: 'enxergar',
    description:
      'Lê o RENDER da página: o que está de fato DESENHADO, em números exatos. Cada nó que o ' +
      'navegador pintou vem com geometria (x, y, largura, altura, em coordenadas de página), ' +
      'cor, fundo, fonte, tamanho, peso, alinhamento, borda, canto, sombra, empilhamento (z), ' +
      'rolagem interna, e ainda se está FORA da janela ou COBERTO por outro elemento. `canvas` ' +
      'vem com as dimensões e uma amostra real de pixels; `img` com o tamanho natural; `iframe` ' +
      'e `video` também são anotados.\n\n' +
      'Use isto quando a pergunta for sobre LAYOUT ou APARÊNCIA — o que está onde, o que está ' +
      'por cima do quê, alinhamento, espaçamento, cor, tipografia, o que está cortado, ' +
      'escondido ou fora de vista. O `ler` devolve o TEXTO; este devolve o DESENHO.\n\n' +
      'Escopo: sem argumento, a página inteira. Com `n` (número que o `ler` deu), `seletor` ou ' +
      '`texto`, um elemento e o que está dentro dele. Com `x`,`y`,`largura`,`altura`, só o que ' +
      'intersecta essa região. `caracteres` (número) acrescenta a caixa de CADA caractere — a ' +
      'posição exata de cada letra.\n\n' +
      'PÁGINA GRANDE: a leitura é **paginada**, não truncada. O resultado sempre diz quantos ' +
      'nós a página tem e de qual nó você está vendo; quando sobra, o rodapé traz o `inicio` ' +
      'exato da próxima chamada. Para percorrer a página inteira, chame de novo com aquele ' +
      '`inicio` (e o mesmo `limite`) até acabar. Se você já sabe onde olhar, aponte o escopo ' +
      '(seletor, texto ou região) em vez de varrer tudo.\n\n' +
      'Alcança também o shadow DOM aberto dos componentes e o texto que `::before`/`::after` ' +
      'desenham. O conteúdo de `canvas` é lido em **pixels de verdade**, inclusive WebGL (o ' +
      'contexto é criado com `preserveDrawingBuffer`, senão o buffer some depois de compor e ' +
      'um jogo apareceria como um quadro vazio). NÃO alcança: iframe de outra origem (só o ' +
      'quadro dele), shadow root fechado, e os pixels de um canvas contaminado por imagem de ' +
      'outra origem — nos três casos o motivo vem escrito no resultado, em vez de vir vazio.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Número do elemento, como `ler` devolveu.' },
        seletor: { type: 'string', description: 'Seletor CSS.' },
        texto: { type: 'string', description: 'Trecho de texto que aparece na página.' },
        x: { type: 'number', description: 'Região: x em pixels de página.' },
        y: { type: 'number', description: 'Região: y em pixels de página.' },
        largura: { type: 'number', description: 'Região: largura em pixels.' },
        altura: { type: 'number', description: 'Região: altura em pixels.' },
        limite: { type: 'number', description: 'Quantos nós trazer nesta chamada (padrão 300, até 3000).' },
        inicio: {
          type: 'number',
          description:
            'Número do primeiro nó a trazer (padrão 0). É a paginação: página grande se lê em ' +
            'várias chamadas, e o resultado de uma diz qual é o `inicio` da próxima.',
        },
        caracteres: { type: 'number', description: 'Quantas caixas por caractere incluir (0 = nenhuma).' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.enxergar(argumentos ?? {})
    },
  },
  {
    name: 'pixels',
    description:
      'Varre a janela como um scanner e diz QUEM é dono de cada ponto: para cada faixa ' +
      'horizontal da tela, devolve os trechos e qual elemento está POR CIMA em cada trecho. ' +
      'É a leitura linha a linha do que está renderizado — mostra o que de fato ocupa o ' +
      'espaço, inclusive o que está sobreposto ou escondido atrás de outro, coisa que a ' +
      'árvore do DOM não diz.\n\n' +
      'Sem argumento, varre a janela em 12 faixas, amostrando de 8 em 8 pixels. `passo` menor ' +
      'dá mais detalhe; `linhas` maior dá mais faixas. `agrupar: false` mostra o elemento mais ' +
      'profundo de cada ponto em vez do ancestral com id/classe.',
    inputSchema: {
      type: 'object',
      properties: {
        passo: { type: 'number', description: 'De quantos em quantos pixels amostrar (padrão 8).' },
        linhas: { type: 'number', description: 'Quantas faixas horizontais (padrão 12).' },
        agrupar: { type: 'boolean', description: 'Agrupar pelo ancestral com id/classe (padrão sim).' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.pixels(argumentos ?? {})
    },
  },
  {
    name: 'tecla',
    description:
      'Aperta uma tecla de verdade no navegador — é o que testa teclado. Aceita Tab, Escape, ' +
      'Enter, Space, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp/PageDown, ' +
      'F1..F12, uma letra ou um dígito. `modificadores` combina Ctrl, Shift, Alt e Meta ' +
      '(ex.: Control+a para selecionar tudo, Shift+Tab para voltar o foco). Com `seletor` ou ' +
      '`n`, o elemento é clicado antes — tecla sem foco vai para o lugar errado. `vezes` ' +
      'repete (ex.: 3 Tab para pular três campos).',
    inputSchema: {
      type: 'object',
      properties: {
        tecla: { type: 'string', description: 'Tab, Escape, ArrowDown, Space, Enter, a, 7…' },
        modificadores: { type: 'array', items: { type: 'string' }, description: 'Control, Shift, Alt, Meta.' },
        vezes: { type: 'number', description: 'Quantas vezes apertar (padrão 1).' },
        seletor: { type: 'string', description: 'Foca neste elemento antes de apertar.' },
        n: { type: 'number', description: 'Número do elemento (do `ler`) para focar antes.' },
      },
      required: ['tecla'],
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.tecla(argumentos ?? {})
    },
  },
  {
    name: 'hover',
    description:
      'Passa o mouse por cima de um elemento (ou de um ponto) e para ali. É o que revela o que ' +
      'só aparece no hover — tooltip, menu que abre, sublinhado, mudança de cor. O resultado ' +
      'se lê depois com `enxergar`.',
    inputSchema: {
      type: 'object',
      properties: {
        seletor: { type: 'string', description: 'Seletor CSS do alvo.' },
        n: { type: 'number', description: 'Número do elemento, como o `ler` devolveu.' },
        x: { type: 'number', description: 'Ou um ponto: x em pixels da janela.' },
        y: { type: 'number', description: 'Ou um ponto: y em pixels da janela.' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.hover(argumentos ?? {})
    },
  },
  {
    name: 'arrastar',
    description:
      'Arrasta de um elemento a outro, em passos, como a mão faz. Serve para reordenar lista, ' +
      'slider, kanban, mover item. `de` é a origem e `para` o destino (elemento), ou ' +
      '`paraX`/`paraY` para um ponto. Não dispara o arrastar **nativo do HTML** ' +
      '(`draggable="true"`), que usa outro canal do navegador.',
    inputSchema: {
      type: 'object',
      properties: {
        de: { type: 'object', description: 'Origem: { seletor } ou { n }.' },
        para: { type: 'object', description: 'Destino: { seletor } ou { n }.' },
        paraX: { type: 'number', description: 'Destino por coordenada (x).' },
        paraY: { type: 'number', description: 'Destino por coordenada (y).' },
        passos: { type: 'number', description: 'Quantos passos intermediários (padrão 14).' },
      },
      required: ['de'],
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.arrastar(argumentos ?? {})
    },
  },
  {
    name: 'upload',
    description:
      'Põe um ou mais arquivos do disco num `input[type=file]` — o mesmo caminho que o ' +
      'navegador usa quando a pessoa escolhe o arquivo. É assim que se testa envio de arquivo, ' +
      'que não dá para fazer digitando.',
    inputSchema: {
      type: 'object',
      properties: {
        seletor: { type: 'string', description: 'Seletor do input de arquivo.' },
        n: { type: 'number', description: 'Ou o número do elemento (do `ler`).' },
        arquivos: { type: 'array', items: { type: 'string' }, description: 'Caminhos completos no disco.' },
      },
      required: ['arquivos'],
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.upload(argumentos ?? {})
    },
  },
  {
    name: 'acessibilidade',
    description:
      'Lê a árvore de ACESSIBILIDADE — o que um leitor de tela enxerga. Devolve papel, nome ' +
      'acessível calculado e estado (`checked`, `disabled`, `expanded`, `required`, `focused`, ' +
      '`level`). Uma tela pode estar visualmente certa e ser inusável: botão que é `div` sem ' +
      'papel, campo sem rótulo, modal sem `aria-modal`. Sem argumento lê a página inteira; com ' +
      '`seletor`/`n`, só aquele ramo.',
    inputSchema: {
      type: 'object',
      properties: {
        seletor: { type: 'string', description: 'Lê só este ramo.' },
        n: { type: 'number', description: 'Ou o número do elemento (do `ler`).' },
        limite: { type: 'number', description: 'Teto de nós (padrão 300).' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.acessibilidade(argumentos ?? {})
    },
  },
  {
    name: 'console',
    description:
      'O que o navegador reclamou: `console.*`, exceções não tratadas e o log dele (CSP, ' +
      'recurso bloqueado, certificado). Fica ligado desde a subida, então pega o que apareceu ' +
      '**antes** de você olhar — que é justamente o erro que estraga a tela em silêncio. ' +
      '`limpar: true` esvazia depois de ler; `filtro` casa no texto.',
    inputSchema: {
      type: 'object',
      properties: {
        limpar: { type: 'boolean', description: 'Esvazia o buffer depois de ler.' },
        filtro: { type: 'string', description: 'Só o que contém este texto.' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.console(argumentos ?? {})
    },
  },
  {
    name: 'rede',
    description:
      'As requisições que a página fez: status, método, URL, tipo e tempo. É o que responde ' +
      '"os dados vieram?" e "por que a tela ficou vazia?" — um 401 silencioso ou uma chamada ' +
      'que falhou aparecem aqui, não no console. `somenteFalhas: true` mostra só erro e 4xx/5xx.',
    inputSchema: {
      type: 'object',
      properties: {
        filtro: { type: 'string', description: 'Só URLs que contêm este texto.' },
        somenteFalhas: { type: 'boolean', description: 'Só falhas e status 400+.' },
        limpar: { type: 'boolean', description: 'Esvazia depois de ler.' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.rede(argumentos ?? {})
    },
  },
  {
    name: 'armazenamento',
    description:
      'Lê `localStorage`, `sessionStorage` e cookies — e escreve. `definir: {local:{...}, ' +
      'session:{...}}` grava chave a chave; `limpar: true` apaga; `recarregar: true` recarrega ' +
      'a página em seguida. É como se testa "refresh no meio do fluxo" e "sessão expirada" sem ' +
      'passar pela tela de login.',
    inputSchema: {
      type: 'object',
      properties: {
        definir: { type: 'object', description: '{ local: {chave: valor}, session: {chave: valor} }.' },
        limpar: { type: 'boolean', description: 'Apaga tudo antes de ler.' },
        recarregar: { type: 'boolean', description: 'Recarrega a página depois de escrever.' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.armazenamento(argumentos ?? {})
    },
  },
  {
    name: 'executar_js',
    description:
      'Roda JavaScript na página e devolve o valor. É a saída de emergência para o que não tem ' +
      'ferramenta própria: `performance.getEntriesByType("navigation")` para tempo de carga, ' +
      '`document.title` e meta tags para SEO, contraste calculado a partir do ' +
      '`getComputedStyle`, `matchMedia` para saber que faixa de tela está ativa, estado interno ' +
      'da aplicação, ou trocar `fetch` por um dublê. Escreva uma **expressão**; para várias ' +
      'linhas, use uma função invocada na hora com `return`.',
    inputSchema: {
      type: 'object',
      properties: {
        codigo: { type: 'string', description: 'A expressão a avaliar na página.' },
      },
      required: ['codigo'],
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.executarJs(argumentos ?? {})
    },
  },
  {
    name: 'esperar',
    description:
      'Espera algo acontecer, até um prazo — um seletor aparecer, um texto surgir, ou uma ' +
      'expressão ficar verdadeira. É o que torna o teste confiável: sem isto, a leitura chega ' +
      'antes de a tela responder e o resultado vira sorte. Falha dizendo o que esperou e por ' +
      'quanto tempo.',
    inputSchema: {
      type: 'object',
      properties: {
        seletor: { type: 'string', description: 'Espera este seletor existir.' },
        texto: { type: 'string', description: 'Espera este texto aparecer na página.' },
        ate: { type: 'string', description: 'Ou uma expressão JS que precise virar verdadeira.' },
        ms: { type: 'number', description: 'Prazo em milissegundos (padrão 5000).' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.esperar(argumentos ?? {})
    },
  },
  {
    name: 'janela',
    description:
      'Muda o tamanho da janela — é o que testa responsividade e mobile. `largura`/`altura` em ' +
      'pixels, `mobile: true` liga o modo de toque, `escala` para telas densas. Depois de ' +
      'mudar, use `enxergar` para conferir o layout naquele tamanho. `acao: "toque"` dá um ' +
      'toque (precisa de `seletor` ou `x`/`y`) e `acao: "swipe"` arrasta o dedo por `dx`/`dy`. ' +
      '`limpar: true` devolve ao tamanho natural.',
    inputSchema: {
      type: 'object',
      properties: {
        largura: { type: 'number', description: 'Largura em pixels (ex.: 390).' },
        altura: { type: 'number', description: 'Altura em pixels (ex.: 844).' },
        mobile: { type: 'boolean', description: 'Modo mobile (liga o toque).' },
        escala: { type: 'number', description: 'deviceScaleFactor (padrão 1).' },
        recarregar: { type: 'boolean', description: 'Recarrega a página depois — necessário para o modo de toque valer.' },
        acao: { type: 'string', description: '"toque" ou "swipe".' },
        seletor: { type: 'string', description: 'Onde tocar/arrastar.' },
        x: { type: 'number', description: 'Ou o ponto: x.' },
        y: { type: 'number', description: 'Ou o ponto: y.' },
        dx: { type: 'number', description: 'Swipe: quanto anda em x.' },
        dy: { type: 'number', description: 'Swipe: quanto anda em y.' },
        limpar: { type: 'boolean', description: 'Devolve a janela ao tamanho natural.' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.janela(argumentos ?? {})
    },
  },
  {
    name: 'requisicao',
    description:
      'Dublê de rede: responde no lugar do servidor e mexe na conexão. `padrao` é o pedaço da ' +
      'URL a interceptar (ex.: "*api*"), e `status`/`corpo`/`atraso` dizem o que devolver — é ' +
      'como se testa a tela com API respondendo 400, 401, 404 ou 500 sem tocar no servidor. ' +
      '`offline: true` corta a rede e `latencia` (ms) a deixa lenta. `limpar: true` desfaz tudo.',
    inputSchema: {
      type: 'object',
      properties: {
        padrao: { type: 'string', description: 'Padrão de URL a interceptar (ex.: "*api*").' },
        status: { type: 'number', description: 'Status a devolver (padrão 500).' },
        corpo: { type: 'string', description: 'Corpo da resposta falsa.' },
        atraso: { type: 'number', description: 'Atrasar a resposta em ms.' },
        offline: { type: 'boolean', description: 'Corta a rede.' },
        latencia: { type: 'number', description: 'Latência em ms.' },
        limpar: { type: 'boolean', description: 'Desliga o dublê e as condições de rede.' },
      },
    },
    async run(argumentos) {
      await navegador.abrir()
      return await navegador.requisicao(argumentos ?? {})
    },
  },
  {
    name: 'voltar',
    description: 'Volta uma página no histórico.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const resultado = await navegador.historico('voltar')
      return resultado ? `voltei para: ${resultado.url}` : 'não há página anterior no histórico'
    },
  },
  {
    name: 'avancar',
    description: 'Avança uma página no histórico.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const resultado = await navegador.historico('avancar')
      return resultado ? `avancei para: ${resultado.url}` : 'não há página seguinte no histórico'
    },
  },
  {
    name: 'recarregar',
    description: 'Recarrega a página aberta.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const resultado = await navegador.recarregar()
      return `recarreguei: ${resultado.url}`
    },
  },
  {
    name: 'print',
    description: 'Salva uma captura da tela atual em PNG e devolve o caminho do arquivo.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      await navegador.abrir()
      const quadro = await navegador.quadro()
      const destino = join(pastaDeDados(), `dev-browser-print-${Date.now()}.png`)
      writeFileSync(destino, quadro)
      return `captura salva em: ${destino}`
    },
  },
  {
    name: 'fechar',
    description: 'Fecha o navegador e encerra a sessão do Painel Dev.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      await navegador.fechar()
      return 'navegador fechado'
    },
  },
]

// ---------------------------------------------------------------- protocolo MCP

const responder = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
const responderErro = (id, message) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n')
}

async function tratar(mensagem) {
  const { id, method, params } = mensagem

  if (method === 'initialize') {
    responder(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'koda-dev-browser', version: '1.0.0' },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') {
    responder(id, {})
    return
  }
  if (method === 'tools/list') {
    responder(id, {
      tools: FERRAMENTAS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
    return
  }
  if (method === 'tools/call') {
    const ferramenta = FERRAMENTAS.find((f) => f.name === params?.name)
    if (!ferramenta) {
      responder(id, {
        content: [{ type: 'text', text: `não conheço a ferramenta "${params?.name}"` }],
        isError: true,
      })
      return
    }
    try {
      const texto = await ferramenta.run(params?.arguments ?? {})
      responder(id, { content: [{ type: 'text', text: String(texto) }] })
    } catch (erro) {
      // `isError: true` é o que faz o Koda marcar a chamada como falha. Sem isto, um erro
      // entraria no histórico como sucesso e o modelo acharia que deu certo.
      responder(id, { content: [{ type: 'text', text: erro.message }], isError: true })
    }
    return
  }
  if (id !== undefined) responderErro(id, `método não suportado: ${method}`)
}

let sobra = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (pedaco) => {
  sobra += pedaco
  let quebra
  while ((quebra = sobra.indexOf('\n')) >= 0) {
    const linha = sobra.slice(0, quebra).trim()
    sobra = sobra.slice(quebra + 1)
    if (!linha) continue
    let mensagem
    try {
      mensagem = JSON.parse(linha)
    } catch {
      log('linha que não é JSON, ignorada')
      continue
    }
    void tratar(mensagem)
  }
})

process.stdin.on('end', () => {
  void navegador.fechar().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void navegador.fechar().finally(() => process.exit(0))
})

log('servidor pronto')
