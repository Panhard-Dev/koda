import { useEffect, useState } from 'react'
import { fraseDeFalha, listModels, listarCombos, modelosDoProvedor, provedoresDeLogin, removerCombo, salvarCombo } from '../api/client'
import type { ComboKoda } from '../api/client'

const vazio = (): ComboKoda => ({ nome: '', estrategia: 'fallback', modelos: [], decisor: '', juiz: '', politica: 'smart-switch', limiar: 0.8 })
type Opcao = { valor: string; nome: string }
const input = 'rounded-lg bg-koda-input px-3 py-2 text-sm text-koda-fg ring-1 ring-koda-fg/10 outline-none'

export default function CombosSection() {
  const [lista, setLista] = useState<ComboKoda[]>([])
  const [opcoes, setOpcoes] = useState<Opcao[]>([])
  const [editando, setEditando] = useState<ComboKoda | null>(null)
  const [selecionado, setSelecionado] = useState('')
  const [mensagem, setMensagem] = useState('')
  const [excluir, setExcluir] = useState<string | null>(null)
  const carregar = async () => setLista(await listarCombos())
  useEffect(() => {
    void carregar().catch((e) => setMensagem(fraseDeFalha(e)))
    void (async () => {
      const [host, provedores] = await Promise.all([listModels().catch(() => []), provedoresDeLogin()])
      const grupos = await Promise.all(provedores.filter((p) => p.conectado).map(async (p) => {
        try { const r = await modelosDoProvedor(p.id); return r.modelos.map((m) => ({ valor: `provedor:${p.id}:${m}`, nome: `${p.nome} · ${r.nomes?.[m] ?? m}` })) }
        catch { return [] }
      }))
      setOpcoes([...host.map((m) => ({ valor: m.value, nome: `Koda · ${m.label}` })), ...grupos.flat()])
    })().catch((e) => setMensagem(fraseDeFalha(e)))
  }, [])
  const nome = (valor: string) => opcoes.find((item) => item.valor === valor)?.nome ?? valor
  const atualizar = <K extends keyof ComboKoda>(campo: K, valor: ComboKoda[K]) => setEditando((atual) => atual ? { ...atual, [campo]: valor } : null)
  const salvar = async () => {
    if (!editando) return
    try { await salvarCombo(editando); await carregar(); window.dispatchEvent(new Event('koda-combos')); setEditando(null); setMensagem('Combo salvo.') }
    catch (e) { setMensagem(fraseDeFalha(e)) }
  }
  return <div className="flex flex-col gap-4">
    {mensagem ? <p role="status" className="text-sm text-koda-fg/65">{mensagem}</p> : null}
    {!editando ? <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
      {lista.map((combo) => <div key={combo.id} className="flex flex-col gap-2 rounded-2xl bg-koda-panel p-4 ring-1 ring-koda-fg/10"><button type="button" onClick={() => { setMensagem(''); setEditando(combo) }} className="text-left"><span className="block font-medium">{combo.nome}</span><span className="text-xs text-koda-fg/50">{combo.estrategia} · {combo.modelos.length} modelos</span></button>{excluir === combo.id ? <div className="flex gap-2 text-xs"><button type="button" className="text-red-400" onClick={() => void (async () => { try { await removerCombo(combo.id!); setExcluir(null); await carregar(); window.dispatchEvent(new Event('koda-combos')) } catch (e) { setMensagem(fraseDeFalha(e)) } })()}>Confirmar exclusão</button><button type="button" onClick={() => setExcluir(null)}>Cancelar</button></div> : <button type="button" className="w-fit text-xs text-red-400" onClick={() => setExcluir(combo.id ?? null)}>Excluir</button>}</div>)}
      <button type="button" onClick={() => { setMensagem(''); setEditando(vazio()) }} className="min-h-24 rounded-2xl border border-dashed border-koda-fg/20 p-4 text-sm hover:border-koda-accent">+ Criar combo</button>
    </div> : <div className="flex flex-col gap-4 rounded-2xl bg-koda-panel p-5 ring-1 ring-koda-fg/10">
      <label className="flex flex-col gap-1 text-xs">Nome<input aria-label="Nome do combo" className={input} value={editando.nome} onChange={(e) => atualizar('nome', e.target.value)} placeholder="Meu combo" /></label>
      <label className="flex flex-col gap-1 text-xs">Estratégia<select aria-label="Estratégia do combo" className={input} value={editando.estrategia} onChange={(e) => atualizar('estrategia', e.target.value as ComboKoda['estrategia'])}><option value="fallback">Fallback</option><option value="round-robin">Round Robin</option><option value="smart">Smart Router</option><option value="fusion">Fusion</option></select></label>
      <p className="text-xs text-koda-fg/55">{editando.estrategia === 'fallback' ? 'Tenta os modelos em ordem quando ocorrer falha.' : editando.estrategia === 'round-robin' ? 'Alterna o primeiro modelo a cada pedido; usa os outros em caso de falha.' : editando.estrategia === 'smart' ? 'System One ou outro modelo decisor escolhe entre os modelos. A escolha adiciona uma chamada.' : 'Consulta todos os modelos em paralelo e um juiz reúne as respostas. Consome créditos de cada modelo e do juiz.'}</p>
      <div><p className="mb-2 text-sm font-medium">Modelos em ordem</p><div className="flex flex-col gap-2">{editando.modelos.map((m, i) => <div key={m} className="flex items-center gap-2 rounded-lg bg-koda-fg/5 p-2 text-sm"><span className="min-w-0 flex-1 break-all">{i + 1}. {nome(m)}</span><button type="button" disabled={i===0} aria-label={`Subir ${nome(m)}`} onClick={() => { const v = [...editando.modelos]; [v[i-1],v[i]] = [v[i],v[i-1]]; atualizar('modelos',v) }} className="disabled:opacity-30">↑</button><button type="button" disabled={i===editando.modelos.length-1} aria-label={`Descer ${nome(m)}`} onClick={() => { const v = [...editando.modelos]; [v[i+1],v[i]] = [v[i],v[i+1]]; atualizar('modelos',v) }} className="disabled:opacity-30">↓</button><button type="button" aria-label={`Remover ${nome(m)}`} onClick={() => atualizar('modelos',editando.modelos.filter((x) => x !== m))} className="text-red-400">×</button></div>)}</div></div>
      <div className="flex gap-2"><select aria-label="Escolher modelo para combo" className={`${input} min-w-0 flex-1`} value={selecionado} onChange={(e) => setSelecionado(e.target.value)}><option value="">Escolher modelo…</option>{opcoes.map((o) => <option key={o.valor} value={o.valor}>{o.nome}</option>)}</select><button type="button" disabled={!selecionado || editando.modelos.includes(selecionado)} onClick={() => { atualizar('modelos',[...editando.modelos,selecionado]); setSelecionado('') }} className="rounded-lg bg-koda-fg/10 px-3 text-xs disabled:opacity-40">Adicionar</button></div>
      {editando.estrategia === 'smart' ? <><label className="flex flex-col gap-1 text-xs">Modelo decisor<select aria-label="Modelo decisor" className={input} value={editando.decisor} onChange={(e) => atualizar('decisor',e.target.value)}><option value="">Escolher decisor…</option><option value="systemone:opencode:jev-1.13-free">System One · Jev 1.13 Free (OpenCode)</option>{opcoes.map((o) => <option key={o.valor} value={o.valor}>{o.nome}</option>)}</select></label><label className="flex flex-col gap-1 text-xs">Política<select aria-label="Política Smart" className={input} value={editando.politica} onChange={(e) => atualizar('politica',e.target.value as ComboKoda['politica'])}><option value="smart-switch">Smart Switch</option><option value="strict">Strict Lock</option><option value="per-turn">Por turno</option></select></label>{editando.politica !== 'strict' ? <label className="flex flex-col gap-1 text-xs">Confiança mínima (0 a 1)<input type="number" min="0" max="1" step="0.05" className={input} value={editando.limiar} onChange={(e) => atualizar('limiar',Number(e.target.value))} /></label> : null}</> : null}
      {editando.estrategia === 'fusion' ? <label className="flex flex-col gap-1 text-xs">Modelo juiz<select aria-label="Modelo juiz" className={input} value={editando.juiz} onChange={(e) => atualizar('juiz',e.target.value)}><option value="">Primeiro modelo do painel</option>{opcoes.map((o) => <option key={o.valor} value={o.valor}>{o.nome}</option>)}</select></label> : null}
      <div className="flex gap-2"><button type="button" onClick={() => void salvar()} className="rounded-lg bg-koda-accent px-4 py-2 text-sm text-koda-bg">Salvar combo</button><button type="button" onClick={() => setEditando(null)} className="rounded-lg bg-koda-fg/8 px-4 py-2 text-sm">Cancelar</button></div>
    </div>}
  </div>
}
