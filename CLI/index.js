'use strict';

const readline = require('node:readline');
const pkg = require('./package.json');

const ESC = '\x1b[';
const OSC = '\x1b]';
const BEL = '\x07';

const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const CLEAR = `${ESC}2J${ESC}3J${ESC}H`;

const BLACK_BG = `${OSC}11;rgb:0000/0000/0000${BEL}`;
const LIGHT_FG = `${OSC}10;rgb:d6d6/d6d6/d6d6${BEL}`;
const RESET_BG = `${OSC}111${BEL}`;
const RESET_FG = `${OSC}110${BEL}`;
const TITLE = `${OSC}0;koda${BEL}`;

const BORDA = `${ESC}38;2;122;59;145m`;
const STATUS = `${ESC}38;2;160;106;184m`;
const TEXTO = `${ESC}38;2;214;196;224m`;

const MOUSE_ON = `${ESC}?1000h${ESC}?1006h`;
const MOUSE_OFF = `${ESC}?1000l${ESC}?1006l`;

const NOME = [
  '██╗  ██╗  ██████╗  ██████╗   █████╗ ',
  '██║ ██╔╝ ██╔═══██╗ ██╔══██╗ ██╔══██╗',
  '█████╔╝  ██║   ██║ ██║  ██║ ███████║',
  '██╔═██╗  ██║   ██║ ██║  ██║ ██╔══██║',
  '██║  ██╗ ╚██████╔╝ ██████╔╝ ██║  ██║',
  '╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚═╝  ╚═╝',
];

const MARCA = ['K', 'O', 'D', 'A'];
const BOLD = `${ESC}1m`;

const PALETA_ROXA = [
  [242, 175, 255],
  [218, 130, 255],
  [190, 80, 255],
  [150, 40, 220],
  [104, 18, 162],
];
const SAIR = new Set(['exit', 'quit', ':q', ':wq']);

const MODOS = [
  { rotulo: 'Plan - Mode', curto: 'Plan', cor: `${ESC}38;2;86;156;255m` },
  { rotulo: 'pergunta sempre', curto: 'manual', cor: `${ESC}38;2;90;220;120m` },
  { rotulo: 'padrão', curto: 'padrão', cor: `${ESC}38;2;255;165;70m` },
  { rotulo: 'auto', curto: 'auto', cor: `${ESC}38;2;255;80;80m` },
  { rotulo: 'livre', curto: 'livre', cor: `${ESC}38;2;190;45;45m` },
];

const MODELOS = [
  { rotulo: 'Claude Opus 5.5', curto: 'opus' },
  { rotulo: 'Claude Sonnet 5.5', curto: 'sonnet' },
  { rotulo: 'GPT 6.1 Sol', curto: 'gpt 6.1' },
  { rotulo: 'GPT 6.0 Luna', curto: 'gpt 6.0' },
  { rotulo: 'Koda', curto: 'koda' },
];

const ESFORCOS = [
  { rotulo: 'automático', curto: 'automático' },
  { rotulo: 'mínimo', curto: 'mínimo' },
  { rotulo: 'baixo', curto: 'baixo' },
  { rotulo: 'alto', curto: 'alto' },
  { rotulo: 'muito alto', curto: 'muito alto' },
  { rotulo: 'máximo', curto: 'máximo' },
];

let ativo = false;
let buffer = '';
let saida = [];
let conversa = false;
let pisca = true;
let piscaTimer = null;
let rgbTimer = null;
let fase = 0;
let modoAtual = 2;
let modeloAtual = -1;
let esforcoAtual = 0;
let raciocinio = false;
let menu = null;
let lendoMouse = false;
let mousePendente = '';

function entrar() {
  ativo = true;
  process.stdout.write(TITLE + ALT_ON + MOUSE_ON + BLACK_BG + LIGHT_FG + HIDE_CURSOR + CLEAR);
}

function sair() {
  if (!ativo) return;
  ativo = false;
  menu = null;
  if (piscaTimer) {
    clearInterval(piscaTimer);
    piscaTimer = null;
  }
  if (rgbTimer) {
    clearInterval(rgbTimer);
    rgbTimer = null;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${RESET}${SHOW_CURSOR}${RESET_BG}${RESET_FG}${MOUSE_OFF}${ALT_OFF}`);
  process.exit(0);
}

function dimensoes() {
  return {
    colunas: process.stdout.columns || 80,
    linhas: process.stdout.rows || 24,
  };
}

function mover(linha, coluna) {
  return `${ESC}${linha};${coluna}H`;
}

function corRoxa(t) {
  const onda = (Math.sin(t * Math.PI * 2) + 1) / 2;
  const escala = onda * (PALETA_ROXA.length - 1);
  const i = Math.min(PALETA_ROXA.length - 2, Math.floor(escala));
  const f = escala - i;
  const a = PALETA_ROXA[i];
  const b = PALETA_ROXA[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `${ESC}38;2;${r};${g};${bl}m`;
}

function corLilas(t) {
  const onda = (Math.sin(t * Math.PI * 2) + 1) / 2;
  const r = Math.round(200 + 42 * onda);
  const g = Math.round(110 + 65 * onda);
  return `${ESC}38;2;${r};${g};255m`;
}

function colorir(texto, corDe) {
  let resultado = '';
  for (let i = 0; i < texto.length; i++) {
    resultado += `${corDe(i)}${texto[i]}`;
  }
  return resultado;
}

function larguraDoNome() {
  return Math.max(...NOME.map((linha) => linha.length));
}

function desenharMarca(linha, espaco) {
  const { colunas } = dimensoes();
  const largura = MARCA.length + espaco * (MARCA.length - 1);
  const esquerda = Math.max(0, Math.floor((colunas - largura) / 2)) + 1;
  return MARCA.map((letra, i) => {
    const cor = corRoxa(i / MARCA.length + fase);
    const coluna = esquerda + i * (1 + espaco);
    return `${mover(linha, coluna)}${BOLD}${cor}${letra}${RESET}`;
  }).join('');
}

function linhasDoBuffer(largura) {
  const larguraTexto = largura - 3;
  const linhas = [];
  let resto = buffer;
  while (resto.length > larguraTexto) {
    linhas.push(resto.slice(0, larguraTexto));
    resto = resto.slice(larguraTexto);
  }
  linhas.push(resto);
  if (linhas[linhas.length - 1].length >= larguraTexto) {
    linhas.push('');
  }
  return linhas;
}

function geometriaCaixa() {
  const { colunas, linhas } = dimensoes();
  const largura = Math.min(64, Math.max(12, colunas - 4));
  const esquerda = Math.max(0, Math.floor((colunas - largura) / 2));
  const alturaEntrada = Math.min(3, linhasDoBuffer(largura).length);
  const topo = Math.max(1, linhas - alturaEntrada - 1);
  return { largura, esquerda, topo, alturaEntrada };
}

function desenharLogo() {
  const { colunas, linhas } = dimensoes();

  if (conversa) {
    return desenharMarca(2, 1);
  }

  const largura = larguraDoNome();
  const esquerda = Math.max(0, Math.floor((colunas - largura) / 2)) + 1;
  const area = Math.max(1, linhas - 3);
  const inicio = Math.max(1, Math.floor((area - NOME.length) / 2) + 1);
  return NOME.map((linha, i) => {
    let texto = mover(inicio + i, esquerda);
    for (let j = 0; j < linha.length; j++) {
      const cor = corRoxa((j / largura + i / NOME.length) / 2 + fase);
      texto += `${cor}${linha[j]}`;
    }
    return `${texto}${RESET}`;
  }).join('');
}

function desenharEntrada() {
  const { largura, esquerda, topo, alturaEntrada } = geometriaCaixa();
  const larguraTexto = largura - 3;
  const visiveis = linhasDoBuffer(largura).slice(-alturaEntrada);
  return visiveis.map((linha, i) => {
    const ultima = i === visiveis.length - 1;
    const conteudo = ultima ? linha + (pisca ? '█' : ' ') : linha;
    const espacos = Math.max(0, larguraTexto - conteudo.length);
    const row = topo + 1 + i;
    return `${mover(row, esquerda + 1)}${BORDA}│${RESET} ${conteudo}${' '.repeat(espacos)}${BORDA}│${RESET}`;
  }).join('');
}

function layoutStatus() {
  const { largura, esquerda, topo } = geometriaCaixa();
  const rotulo = 'Reasoning';
  const separador = '   •   ';
  const permissao = `${MODOS[modoAtual].curto}▾`;
  const modelos = `${modeloAtual >= 0 ? MODELOS[modeloAtual].curto : 'modelos'}▾`;
  const esforco = `${ESFORCOS[esforcoAtual].curto}▾`;
  const esquerdo = `${rotulo}${separador}${permissao}`;
  const direito = `${modelos}${separador}${esforco}`;
  if (topo <= 1 || largura < esquerdo.length + direito.length + 2) return null;
  const espaco = largura - esquerdo.length - direito.length;
  const linha = topo - 1;
  const inicio = esquerda + 1;
  const inicioDireito = inicio + esquerdo.length + espaco;
  const corEsforco =
    esforcoAtual === ESFORCOS.length - 1
      ? colorir(esforco, (i) => corRoxa(fase + i * 0.08))
      : `${STATUS}${esforco}`;
  const corRaciocinio = raciocinio ? `${BOLD}${corLilas(fase)}` : STATUS;
  return {
    linha,
    texto:
      `${mover(linha, inicio)}${corRaciocinio}${rotulo}${RESET}${STATUS}${separador}${MODOS[modoAtual].cor}${permissao}` +
      `${STATUS}${' '.repeat(espaco)}${modelos}${separador}${corEsforco}${RESET}`,
    itens: {
      raciocinio: {
        x1: inicio,
        x2: inicio + rotulo.length - 1,
      },
      permissao: {
        x1: inicio + rotulo.length + separador.length,
        x2: inicio + esquerdo.length - 1,
      },
      modelos: {
        x1: inicioDireito,
        x2: inicioDireito + modelos.length - 1,
      },
      esforco: {
        x1: inicioDireito + modelos.length + separador.length,
        x2: inicioDireito + direito.length - 1,
      },
    },
  };
}

function desenharStatus() {
  const layout = layoutStatus();
  return layout ? layout.texto : '';
}

function itemNoStatus(x, y) {
  const layout = layoutStatus();
  if (!layout || y !== layout.linha) return null;
  for (const tipo of ['raciocinio', 'permissao', 'modelos', 'esforco']) {
    const faixa = layout.itens[tipo];
    if (x >= faixa.x1 && x <= faixa.x2) return tipo;
  }
  return null;
}

function opcoesDoMenu(tipo) {
  if (tipo === 'permissao') return MODOS;
  if (tipo === 'modelos') return MODELOS;
  return ESFORCOS;
}

function indiceAtual(tipo) {
  if (tipo === 'permissao') return modoAtual;
  if (tipo === 'modelos') return modeloAtual >= 0 ? modeloAtual : 0;
  return esforcoAtual;
}

function desenharMenu() {
  if (!menu) return '';
  const { opcoes, x, y, largura, altura, selecionado } = menu;
  const interior = largura - 2;
  const topo = `╭${'─'.repeat(interior)}╮`;
  const base = `╰${'─'.repeat(interior)}╯`;
  const { colunas } = dimensoes();
  let texto = '';
  for (let row = y; row < y + altura; row++) {
    texto += `${mover(row, 1)}${' '.repeat(colunas)}`;
  }
  texto += `${mover(y, x)}${BORDA}${topo}${RESET}`;
  opcoes.forEach((opcao, i) => {
    const ativo = i === selecionado;
    const marcador = ativo ? '•' : ' ';
    const conteudo = ` ${marcador} ${opcao.rotulo}`;
    const espacos = ' '.repeat(Math.max(0, interior - conteudo.length));
    const negrito = ativo ? BOLD : '';
    const rgb = menu.tipo === 'esforco' && i === opcoes.length - 1;
    let corMarcador;
    let rotulo;
    if (menu.tipo === 'permissao') {
      corMarcador = `${negrito}${opcao.cor}`;
      rotulo = `${negrito}${opcao.cor}${opcao.rotulo}`;
    } else if (rgb) {
      corMarcador = `${negrito}${corRoxa(fase)}`;
      rotulo = `${negrito}${colorir(opcao.rotulo, (j) => corRoxa(fase + j * 0.08))}`;
    } else {
      corMarcador = ativo ? `${BOLD}${STATUS}` : TEXTO;
      rotulo = ativo ? `${BOLD}${STATUS}${opcao.rotulo}` : `${TEXTO}${opcao.rotulo}`;
    }
    texto += `${mover(y + 1 + i, x)}${BORDA}│${RESET} ${corMarcador}${marcador}${RESET} ${rotulo}${espacos}${RESET}${BORDA}│${RESET}`;
  });
  texto += `${mover(y + altura - 1, x)}${BORDA}${base}${RESET}`;
  return texto;
}

function fecharMenu() {
  if (!menu) return;
  menu = null;
  pisca = true;
  desenharTela();
}

function abrirMenu(tipo) {
  if (menu && menu.tipo === tipo) {
    fecharMenu();
    return;
  }
  if (menu) {
    menu = null;
    desenharTela();
  }
  const layout = layoutStatus();
  if (!layout) return;
  const faixa = layout.itens[tipo];
  const opcoes = opcoesDoMenu(tipo);
  const largura = Math.max(...opcoes.map((opcao) => opcao.rotulo.length)) + 6;
  const altura = opcoes.length + 2;
  const { colunas } = dimensoes();
  let x = tipo === 'permissao' ? faixa.x1 : faixa.x2 - largura + 1;
  x = Math.max(1, Math.min(x, colunas - largura + 1));
  let y = layout.linha - altura;
  if (y < 1) y = 1;
  menu = {
    tipo,
    opcoes,
    x,
    y,
    largura,
    altura,
    selecionado: indiceAtual(tipo),
  };
  pisca = true;
  process.stdout.write(desenharMenu());
}

function selecionarOpcao(i) {
  if (!menu || i < 0 || i >= menu.opcoes.length) return;
  if (menu.tipo === 'permissao') modoAtual = i;
  else if (menu.tipo === 'modelos') modeloAtual = i;
  else esforcoAtual = i;
  fecharMenu();
}

function alternarRaciocinio() {
  raciocinio = !raciocinio;
  menu = null;
  pisca = true;
  desenharTela();
}

function tratarClique(x, y) {
  if (menu) {
    if (x >= menu.x && x < menu.x + menu.largura && y >= menu.y && y < menu.y + menu.altura) {
      const indice = y - menu.y - 1;
      if (indice >= 0 && indice < menu.opcoes.length) selecionarOpcao(indice);
      return;
    }
    const tipo = itemNoStatus(x, y);
    if (tipo === 'raciocinio') {
      alternarRaciocinio();
      return;
    }
    if (tipo) abrirMenu(tipo);
    else fecharMenu();
    return;
  }
  const tipo = itemNoStatus(x, y);
  if (tipo === 'raciocinio') {
    alternarRaciocinio();
    return;
  }
  if (tipo) abrirMenu(tipo);
}

function processarDados(chunk) {
  if (chunk.includes('\x03') || chunk.includes('\x04')) {
    sair();
    return;
  }
  if (chunk === '\x1b') {
    if (menu) fecharMenu();
    return;
  }
  const texto = mousePendente + chunk;
  mousePendente = '';
  const regex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m;
  while ((m = regex.exec(texto)) !== null) {
    const botao = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (m[4] === 'M' && botao === 0) tratarClique(x, y);
  }
  const incompleto = texto.match(/\x1b\[<[\d;]*$/);
  if (incompleto) mousePendente = incompleto[0];
}

function desenharCaixa() {
  const { largura, esquerda, topo, alturaEntrada } = geometriaCaixa();
  const interior = largura - 2;
  const topoLinha = `╭${'─'.repeat(interior)}╮`;
  const baseLinha = `╰${'─'.repeat(interior)}╯`;
  return (
    desenharStatus() +
    `${mover(topo, esquerda + 1)}${BORDA}${topoLinha}${RESET}` +
    `${mover(topo + alturaEntrada + 1, esquerda + 1)}${BORDA}${baseLinha}${RESET}` +
    desenharEntrada()
  );
}

function desenharSaida() {
  if (!conversa || saida.length === 0) return '';
  const { esquerda, topo } = geometriaCaixa();
  const inicio = 4;
  const disponiveis = Math.max(0, topo - inicio - 1);
  if (disponiveis === 0) return '';
  const visiveis = saida.slice(-disponiveis);
  return visiveis.map((linha, i) => {
    const row = inicio + i;
    return `${mover(row, esquerda + 3)}${DIM}${linha}${RESET}`;
  }).join('');
}

function desenharTela() {
  process.stdout.write(CLEAR + desenharLogo() + desenharSaida() + desenharCaixa() + desenharMenu());
}

function executar() {
  const cmd = buffer.trim();
  buffer = '';
  pisca = true;

  if (SAIR.has(cmd)) {
    sair();
    return;
  }

  if (cmd === 'clear' || cmd === 'cls') {
    saida = [];
    conversa = false;
  } else {
    if (cmd !== '') conversa = true;

    if (cmd === 'help' || cmd === '?') {
      saida = ['help     comandos', 'version  versão', 'clear    limpa a tela', 'exit     fecha a cli'];
    } else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
      saida = [`koda ${pkg.version}`];
    } else if (cmd !== '') {
      saida = ['em breve'];
    }
  }

  desenharTela();
}

function iniciarEntrada() {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', processarDados);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    const sequencia = key.sequence || '';
    if (!lendoMouse && sequencia.startsWith('\x1b[<')) {
      if (!/[Mm]$/.test(sequencia)) lendoMouse = true;
      return;
    }
    if (lendoMouse) {
      if (str === 'M' || str === 'm') lendoMouse = false;
      return;
    }

    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      sair();
      return;
    }

    if (menu) {
      if (key.name === 'escape') {
        fecharMenu();
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        const delta = key.name === 'up' ? -1 : 1;
        menu.selecionado = (menu.selecionado + delta + menu.opcoes.length) % menu.opcoes.length;
        process.stdout.write(desenharMenu());
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        selecionarOpcao(menu.selecionado);
        return;
      }
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      executar();
      return;
    }

    if (key.name === 'backspace') {
      buffer = buffer.slice(0, -1);
      pisca = true;
      desenharTela();
      return;
    }

    if (str && !key.ctrl && !key.meta && str >= ' ') {
      buffer += str;
      pisca = true;
      desenharTela();
    }
  });

  piscaTimer = setInterval(() => {
    if (menu) return;
    pisca = !pisca;
    process.stdout.write(desenharEntrada());
  }, 530);
}

function ajuda() {
  console.log(`koda ${pkg.version} — cli do koda`);
  console.log('');
  console.log('uso:');
  console.log('  koda            abre a cli');
  console.log('  kd              atalho para koda');
  console.log('  koda --help     mostra esta ajuda');
  console.log('  koda --version  mostra a versão');
}

function iniciarAnimacao() {
  rgbTimer = setInterval(() => {
    fase = (fase + 0.05) % 1;
    const animaStatus = raciocinio || esforcoAtual === ESFORCOS.length - 1;
    if (menu) {
      if (menu.tipo === 'esforco') process.stdout.write(desenharMenu());
      if (animaStatus) process.stdout.write(desenharStatus());
      return;
    }
    process.stdout.write(desenharLogo());
    if (animaStatus) process.stdout.write(desenharStatus());
  }, 80);
}

function abrir() {
  entrar();
  desenharTela();
  iniciarEntrada();
  iniciarAnimacao();
  process.stdout.on('resize', () => {
    menu = null;
    pisca = true;
    desenharTela();
  });
}

function main(argv = process.argv.slice(2)) {
  const arg = argv[0];

  if (arg === '-h' || arg === '--help' || arg === 'help') {
    ajuda();
    return;
  }

  if (arg === '-v' || arg === '--version' || arg === 'version') {
    console.log(`koda ${pkg.version}`);
    return;
  }

  if (arg !== undefined) {
    ajuda();
    process.exitCode = 1;
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`koda ${pkg.version}`);
    console.log('abra em um terminal interativo para usar a cli.');
    return;
  }

  process.on('exit', sair);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));

  abrir();
}

module.exports = { main };
