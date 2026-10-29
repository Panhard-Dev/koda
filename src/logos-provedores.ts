import anthropicLogo from './assets/provedores/anthropic.svg'
import openaiLogo from './assets/provedores/openai.svg'
import googleLogo from './assets/provedores/google.svg'
import githubLogo from './assets/provedores/github.svg'
import xaiLogo from './assets/provedores/xai.svg'
import cursorLogo from './assets/provedores/cursor.svg'
import devinLogo from './assets/provedores/devin.svg'
import qoderLogo from './assets/provedores/qoder.svg'
import kiroLogo from './assets/provedores/kiro.svg'
import factoryLogo from './assets/provedores/factory.svg'
import zcodeLogo from './assets/provedores/zcode.png'
import xiaomiLogo from './assets/provedores/xiaomi.svg'
import clineLogo from './assets/provedores/cline.svg'
import codebuddyLogo from './assets/provedores/codebuddy.svg'
import deepseekLogo from './assets/provedores/deepseek.svg'
import geminiLogo from './assets/provedores/gemini.svg'
import gitlabLogo from './assets/provedores/gitlab.svg'
import iflowLogo from './assets/provedores/iflow.svg'
import kimchiLogo from './assets/provedores/kimchi.svg'
import kilocodeLogo from './assets/provedores/kilocode.svg'
import kimiLogo from './assets/provedores/kimi.svg'
import minimaxLogo from './assets/provedores/minimax.svg'
import museLogo from './assets/provedores/muse.svg'
import museWebLogo from './assets/provedores/muse-web.svg'
import nousLogo from './assets/provedores/nous.svg'
import perplexityLogo from './assets/provedores/perplexity.svg'
import traeLogo from './assets/provedores/trae.svg'
import ucLogo from './assets/provedores/uc.svg'
import windsurfLogo from './assets/provedores/windsurf.svg'
import zedLogo from './assets/provedores/zed.svg'

/**
 * A logo de cada provedor, num lugar só.
 *
 * Antes isso morava dentro do `SettingsScreen`; o menu de modelos do chat também precisa
 * delas, e duas listas de import divergiriam na primeira logo nova.
 *
 * A chave é o id do provedor no Koda; quando o provedor é uma variante do mesmo dono
 * (web, CLI, CN/global), ele reaproveita a marca do dono em vez de cair na sigla.
 */
export const LOGO_DO_PROVEDOR: Record<string, string> = {
  anthropic: anthropicLogo,
  openai: openaiLogo,
  google: googleLogo,
  github: githubLogo,
  xai: xaiLogo,
  cursor: cursorLogo,
  devin: devinLogo,
  qoder: qoderLogo,
  kiro: kiroLogo,
  factory: factoryLogo,
  zcode: zcodeLogo,
  xiaomi: xiaomiLogo,
  'xiaomi-mimo': xiaomiLogo,

  antigravity: googleLogo,
  'chatgpt-web': openaiLogo,
  cline: clineLogo,
  clinepass: clineLogo,
  'codebuddy-intl': codebuddyLogo,
  'codebuddy-cn': codebuddyLogo,
  'deepseek-web': deepseekLogo,
  'gemini-cli': geminiLogo,
  'gemini-web': geminiLogo,
  gitlab: gitlabLogo,
  'grok-cli': xaiLogo,
  'grok-web': xaiLogo,
  iflow: iflowLogo,
  kilocode: kilocodeLogo,
  kimchi: kimchiLogo,
  kimi: kimiLogo,
  'minimax-code': minimaxLogo,
  'minimax-code-global': minimaxLogo,
  muse: museLogo,
  'muse-web': museWebLogo,
  nous: nousLogo,
  'perplexity-web': perplexityLogo,
  'qoder-cn': qoderLogo,
  trae: traeLogo,
  'uc-web': ucLogo,
  windsurf: windsurfLogo,
  glm: zcodeLogo,
  zed: zedLogo,
}
