import { useState } from 'react'
import type { FormEvent } from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import KodaLogo from './KodaLogo'
import { WindowControls } from './WindowControls'
import { ErroDaConta, conferirSenha, entrar, registrar } from '../api/cloud'
import type { Conta } from '../api/cloud'

/**
 * A porta de entrada do Koda.
 *
 * Esta tela é a mesma casa do resto do app — coroa, superfície, tipografia e a voz das
 * outras frases — porque login que parece de outro produto entrega que o app é um
 * embrulho. Nada aqui é decorativo: não tem brilho, ilustração nem emoji, só o campo que
 * precisa ser preenchido e a frase que diz o que fazer quando algo dá errado.
 *
 * Ela é **obrigatória**: enquanto não houver sessão, o app não existe atrás dela. Quem
 * confere a senha e emite a sessão é o painel (ver `api/cloud.ts`); o cadastro cria a
 * conta lá e já entra.
 */

type Modo = 'entrar' | 'criar'

function Campo({
  id,
  rotulo,
  dica,
  children,
}: {
  id: string
  rotulo: string
  dica?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="px-0.5 text-[12.5px] text-koda-fg/55">
        {rotulo}
        {dica ? <span className="text-koda-fg/30"> · {dica}</span> : null}
      </label>
      {children}
    </div>
  )
}

const CAMPO = [
  'h-10 w-full rounded-xl bg-koda-input px-3 text-[14px] text-koda-fg',
  'ring-1 ring-koda-fg/10 outline-none transition-shadow duration-150',
  'placeholder:text-koda-fg/30 focus:ring-2 focus:ring-koda-accent',
].join(' ')

export function LoginScreen({ onEntrou }: { onEntrou: (conta: Conta) => void }) {
  const [modo, setModo] = useState<Modo>('entrar')
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [nome, setNome] = useState('')
  const [mostrarSenha, setMostrarSenha] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const trocarModo = (novo: Modo) => {
    if (novo === modo) return
    setModo(novo)
    setErro(null)
    setSenha('')
  }

  const enviar = async (evento: FormEvent) => {
    evento.preventDefault()
    if (enviando) return

    const alvo = email.trim()
    if (!alvo || !senha) {
      // Mesma frase para os dois campos: não vale dizer qual deles está vazio só para
      // alguém curioso descobrir se um e-mail existe por aqui.
      setErro('Preencha o e-mail e a senha para continuar.')
      return
    }

    if (modo === 'criar') {
      const problema = conferirSenha(senha, alvo)
      if (problema) {
        setErro(problema)
        return
      }
    }

    setErro(null)
    setEnviando(true)
    try {
      const conta =
        modo === 'entrar'
          ? await entrar(alvo, senha)
          : await registrar(alvo, senha, nome === '' ? undefined : nome)
      onEntrou(conta)
    } catch (falha) {
      setErro(
        falha instanceof ErroDaConta
          ? falha.message
          : 'Não consegui entrar agora. Tente de novo em instantes.',
      )
      setSenha('')
    } finally {
      setEnviando(false)
    }
  }

  return (
    // Mesmas medidas do resto do app: `--koda-zoom` escala tudo, inclusive esta tela.
    <div className="flex h-[calc(100vh/var(--koda-zoom))] w-[calc(100vw/var(--koda-zoom))] flex-col overflow-hidden bg-koda-bg">
      {/* Faixa de arrastar a janela (não tem titlebar nativa) + controles do Windows. */}
      <div data-tauri-drag-region className="flex shrink-0 items-center p-5">
        <div className="-mr-2 ml-auto">
          <WindowControls />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[380px] msg-in">
          <KodaLogo className="mx-auto h-12 w-auto" />

          <h1 className="mt-6 text-center text-[26px] leading-tight font-semibold tracking-tight text-koda-fg">
            {modo === 'entrar' ? 'Entre na sua conta' : 'Crie sua conta'}
          </h1>
          <p className="mx-auto mt-2 max-w-[300px] text-center text-[13.5px] leading-5 text-koda-fg/50">
            {modo === 'entrar'
              ? 'O que você conversou fica nesta máquina. A conta é o que identifica você no Koda.'
              : 'Uma conta só sua. As conversas continuam salvas aqui, no seu computador.'}
          </p>

          <div className="mt-7 flex rounded-xl bg-koda-fg/6 p-1">
            {(
              [
                ['entrar', 'Entrar'],
                ['criar', 'Criar conta'],
              ] as const
            ).map(([valor, texto]) => (
              <button
                key={valor}
                type="button"
                aria-pressed={modo === valor}
                onClick={() => trocarModo(valor)}
                className={[
                  'h-8 flex-1 rounded-lg text-[13px] font-medium transition-colors duration-150',
                  'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                  modo === valor
                    ? 'bg-koda-surface text-koda-fg ring-1 ring-koda-fg/10'
                    : 'text-koda-fg/50 hover:text-koda-fg/80',
                ].join(' ')}
              >
                {texto}
              </button>
            ))}
          </div>

          <form onSubmit={enviar} className="mt-3 flex flex-col gap-3.5">
            {modo === 'criar' ? (
              <Campo id="koda-nome" rotulo="Nome" dica="opcional">
                <input
                  id="koda-nome"
                  type="text"
                  value={nome}
                  onChange={(evento) => setNome(evento.target.value)}
                  autoComplete="name"
                  maxLength={160}
                  placeholder="Como quer ser chamado"
                  className={CAMPO}
                />
              </Campo>
            ) : null}

            <Campo id="koda-email" rotulo="E-mail">
              <input
                id="koda-email"
                type="email"
                value={email}
                onChange={(evento) => setEmail(evento.target.value)}
                autoComplete="username"
                autoFocus
                spellCheck={false}
                maxLength={254}
                placeholder="voce@exemplo.com"
                className={CAMPO}
              />
            </Campo>

            <Campo
              id="koda-senha"
              rotulo="Senha"
              dica={modo === 'criar' ? 'mínimo de 12 caracteres' : undefined}
            >
              <div className="relative">
                <input
                  id="koda-senha"
                  type={mostrarSenha ? 'text' : 'password'}
                  value={senha}
                  onChange={(evento) => setSenha(evento.target.value)}
                  autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'}
                  maxLength={200}
                  placeholder="••••••••••••"
                  className={`${CAMPO} pr-10`}
                />
                <button
                  type="button"
                  aria-label={mostrarSenha ? 'Ocultar a senha' : 'Mostrar a senha'}
                  title={mostrarSenha ? 'Ocultar a senha' : 'Mostrar a senha'}
                  onClick={() => setMostrarSenha((valor) => !valor)}
                  className="absolute top-0 right-0 flex h-10 w-10 items-center justify-center text-koda-fg/40 transition-colors duration-150 hover:text-koda-fg focus-visible:outline-none"
                >
                  {mostrarSenha ? (
                    <EyeOff className="h-4 w-4" strokeWidth={1.8} />
                  ) : (
                    <Eye className="h-4 w-4" strokeWidth={1.8} />
                  )}
                </button>
              </div>
            </Campo>

            {erro ? (
              <p
                role="alert"
                className="rounded-xl bg-red-500/10 px-3 py-2 text-[12.5px] leading-4 text-red-400 ring-1 ring-red-500/20"
              >
                {erro}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={enviando}
              className={[
                'mt-1 flex h-10 items-center justify-center gap-2 rounded-xl text-[14px] font-medium text-white',
                'bg-koda-accent-strong transition-colors duration-150 hover:bg-koda-accent-strong/85',
                'focus-visible:ring-2 focus-visible:ring-koda-accent focus-visible:outline-none',
                'disabled:cursor-default disabled:opacity-70',
              ].join(' ')}
            >
              {enviando ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  {modo === 'entrar' ? 'Entrando…' : 'Criando…'}
                </>
              ) : modo === 'entrar' ? (
                'Entrar'
              ) : (
                'Criar conta e entrar'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

export default LoginScreen
