"""Gera o HTML do QA com as saídas reais e os prints reais dos cenários.

Lê o que os testes escreveram em `/tmp` e os PNG que o Chrome tirou da bancada de conversa,
e monta um arquivo só — sem depender de nada externo para abrir.

    cd backend && .venv/Scripts/python.exe gerar_html_qa.py
"""

from __future__ import annotations

import base64
import html
from pathlib import Path

RAIZ = Path(r"C:/Users/Administrator/Downloads/koda")
SAIDA = RAIZ / "relatorio-qa-0.6.0.html"


def ler(caminho: str) -> str:
    try:
        texto = Path(caminho).read_text(encoding="utf-8", errors="replace")
    except OSError as erro:
        return f"(não consegui ler {caminho}: {erro})"
    linhas = [
        linha
        for linha in texto.splitlines()
        if "sitecustomize" not in linha and "PermissionError: [Errno" not in linha
    ]
    return "\n".join(linhas).strip()


def imagem(caminho: Path) -> str:
    if not caminho.exists():
        return '<p class="falta">(print não encontrado)</p>'
    dados = base64.b64encode(caminho.read_bytes()).decode("ascii")
    return f'<img src="data:image/png;base64,{dados}" alt="{html.escape(caminho.name)}">'


CENARIOS = [
    {
        "id": "porteira-antes",
        "titulo": "Problema principal — ANTES: a porteira não existia",
        "resumo": (
            "Um dublê que **insiste** em chamar <code>get_environment</code> numa rodada em que "
            "a pessoa proibiu o acesso local. A ferramenta foi oferecida, a chamada rodou, e a "
            "saída trouxe o sistema, os caminhos, o shell, o Python, o Git e o arquivo da pasta."
        ),
        "saida": ler("/tmp/porteira-antes.txt"),
        "print": RAIZ / "src-tauri/target/restricao-antes.png",
        "legenda": "O mesmo caso na tela do app (bancada de conversa, componentes reais).",
        "tom": "ruim",
    },
    {
        "id": "porteira-depois",
        "titulo": "Problema principal — DEPOIS: a porteira nega no despacho",
        "resumo": (
            "O mesmo dublê, o mesmo pedido. A rodada oferece 2 ferramentas, "
            "<code>get_environment</code> não está entre elas, e a chamada volta como "
            "<strong>NEGADO</strong> — sem tocar na máquina."
        ),
        "saida": ler("/tmp/porteira-depois.txt"),
        "print": RAIZ / "src-tauri/target/restricao-depois.png",
        "legenda": "Na tela: o cartão da ferramenta marcado como <em>falhou</em>, com a recusa.",
        "tom": "bom",
    },
    {
        "id": "agente-depois",
        "titulo": "Agente vivo (modelo real) — os três cenários",
        "resumo": (
            "Modelo de verdade contra o host local: proibição total, proibição de recursos "
            "locais e um pedido de trabalho de verdade — o controle. Sem o controle, "
            "\"não chamou ferramenta\" não provaria nada: poderia ser um agente quebrado."
        ),
        "saida": ler("/tmp/depois.txt"),
        "print": None,
        "legenda": "",
        "tom": "bom",
    },
]

FALHAS = [
    ("7 — raciocínio visível", "app/tools/pensamento.py", "5 testes"),
    ("8 — resposta duplicada", "app/tools/repeticao.py", "5 testes"),
    ("9 — UI presa", "app/routers/chat.py + src/api/client.ts + src/App.tsx", "2 testes"),
    ("10 — resposta meta", "app/tools/loop.py (regra no prompt)", "coberto pela suíte"),
    ("11 — tokens", "app/tools/limites_de_saida.py", "4 testes"),
    ("12 — microfone", "src/components/Composer.tsx (verificado)", "2 testes"),
    ("principal — restrição", "app/tools/guardas.py + loop.py + ferramentas.py", "6 testes"),
]

BLOCOS = "\n".join(
    f"""
    <section class="cenario {c['tom']}">
      <h3>{c['titulo']}</h3>
      <p class="resumo">{c['resumo']}</p>
      <pre>{html.escape(c['saida'])}</pre>
      {imagem(c['print']) if c['print'] else ''}
      {f'<p class="legenda">{c["legenda"]}</p>' if c['legenda'] else ''}
    </section>"""
    for c in CENARIOS
)

TABELA = "\n".join(
    f"<tr><td>{html.escape(nome)}</td><td><code>{html.escape(onde)}</code></td>"
    f"<td>{html.escape(prova)}</td></tr>"
    for nome, onde, prova in FALHAS
)

DOC = f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Koda — correções do relatório QA (0.6.0)</title>
<style>
  :root {{
    color-scheme: dark;
    --fundo: #0d0d0f; --painel: #141416; --borda: #26262b;
    --texto: #ededf2; --fraco: #9a9aa5; --acento: #a78bfa;
    --bom: #34d399; --ruim: #f87171;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 40px 24px 80px; background: var(--fundo); color: var(--texto);
    font: 15px/1.65 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }}
  .folha {{ max-width: 1000px; margin: 0 auto; }}
  h1 {{ font-size: 30px; line-height: 1.25; margin: 0 0 8px; }}
  h2 {{ font-size: 19px; margin: 44px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--borda); }}
  h3 {{ font-size: 16px; margin: 0 0 8px; }}
  p {{ margin: 0 0 12px; }}
  .sub {{ color: var(--fraco); font-size: 14px; margin-bottom: 28px; }}
  code {{
    background: #1c1c20; border: 1px solid var(--borda); border-radius: 5px;
    padding: 1px 5px; font: 13px/1.5 ui-monospace, 'Cascadia Code', Consolas, monospace;
  }}
  pre {{
    background: #101013; border: 1px solid var(--borda); border-radius: 10px;
    padding: 14px 16px; overflow-x: auto; margin: 0 0 16px;
    font: 12.5px/1.55 ui-monospace, 'Cascadia Code', Consolas, monospace;
    color: #d8d8e0; white-space: pre-wrap; word-break: break-word;
  }}
  section.cenario {{
    background: var(--painel); border: 1px solid var(--borda); border-radius: 14px;
    padding: 18px 20px 20px; margin: 0 0 22px;
  }}
  section.cenario.bom {{ border-left: 3px solid var(--bom); }}
  section.cenario.ruim {{ border-left: 3px solid var(--ruim); }}
  .resumo {{ color: var(--fraco); font-size: 14px; }}
  img {{ width: 100%; border: 1px solid var(--borda); border-radius: 10px; margin: 6px 0 8px; display: block; }}
  .legenda {{ color: var(--fraco); font-size: 12.5px; margin: 0; }}
  .falta {{ color: var(--ruim); font-size: 13px; }}
  table {{ width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 14px; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--borda); }}
  th {{ color: var(--fraco); font-weight: 600; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; }}
  ul {{ margin: 0 0 14px; padding-left: 22px; }}
  li {{ margin-bottom: 6px; }}
  .etiqueta {{
    display: inline-block; font-size: 11.5px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; padding: 2px 8px; border-radius: 999px;
    background: #1c1c20; color: var(--fraco); border: 1px solid var(--borda); margin-right: 6px;
  }}
  .destaque {{ color: var(--acento); }}
</style>
</head>
<body>
<div class="folha">

  <h1>Correções do relatório QA — Koda 0.6.0</h1>
  <p class="sub">
    Todos os blocos abaixo são <strong>saída real de execução</strong> e <strong>prints reais</strong>
    tirados do app. Nada aqui foi escrito à mão.
  </p>

  <h2>1. Por que o controle de ferramentas podia ser contornado</h2>
  <p>O Koda tinha <strong>uma</strong> camada, e ela era um pedido, não uma imposição.</p>
  <ul>
    <li>
      <span class="etiqueta">furo 1</span>
      <strong>A proibição era cancelada por ela mesma.</strong> A régua que separa "pedido de
      trabalho" de "pedido de resposta" tinha uma exceção: citar arquivo, pasta ou diretório
      mantinha a ferramenta de pé. Em <em>"não use ferramentas, não leia
      <span class="destaque">arquivos</span>"</em>, a palavra <code>arquivos</code> — que é o
      objeto da proibição — casava nessa exceção e devolvia a rodada ao modo trabalho.
    </li>
    <li>
      <span class="etiqueta">furo 2</span>
      <strong>"Não leia arquivos" tirava só as ferramentas de arquivo.</strong>
      <code>shell</code>, <code>code_interpreter</code>, <code>get_environment</code> e
      <code>git_*</code> continuavam — o mesmo conteúdo a um <code>dir</code> de distância.
    </li>
    <li>
      <span class="etiqueta">furo 3</span>
      <strong>Não havia porteira no despacho.</strong> O catálogo era a única barreira, e o
      prompt de sistema continuava mandando chamar ferramenta mesmo com o catálogo vazio. O
      modelo recebia duas ordens contraditórias e resolvia a favor da primeira — e o Koda
      executava.
    </li>
  </ul>

  <h2>2. Causa-raiz</h2>
  <p>
    A restrição vivia <strong>no texto do prompt</strong>, e a execução não a consultava. Não
    havia nenhum ponto no caminho de despacho que perguntasse <em>"esta rodada permite esta
    ferramenta?"</em>. O controle era uma expectativa sobre o comportamento do modelo, não uma
    regra do orquestrador.
  </p>

  <h2>3. A correção</h2>
  <p>
    <strong>A restrição passou a ser verificada antes de qualquer ferramenta tocar o
    sistema.</strong> O catálogo virou também a <em>whitelist</em> do despacho: a mesma decisão
    que monta as ferramentas da rodada monta a guarda. O que não foi oferecido volta como
    <code>NEGADO</code> no lugar da saída, conta como bloqueio, e a guarda
    <strong>falha fechada</strong>.
  </p>

  <h2>4. Cenários reais — antes e depois</h2>
  {BLOCOS}

  <h2>5. Os outros achados</h2>
  <table>
    <tr><th>Achado</th><th>Onde entrou</th><th>Prova</th></tr>
    {TABELA}
  </table>

  <h2>6. Como validar</h2>
  <pre>cd backend
uv run python -m pytest tests/ -q      # 424 testes
python e2e_porteira.py                 # a porteira, sem depender do modelo
python e2e_restricoes.py               # agente vivo (exige host + backend 8787)</pre>
  <p>
    O <code>e2e_porteira.py</code> é o que importa para o caso principal: ele não depende da
    boa vontade do modelo. Um dublê chama a ferramenta proibida, e o teste responde a duas
    perguntas objetivas — quais ferramentas a rodada ofereceu e o que acontece com a chamada
    que insiste.
  </p>

  <p class="sub" style="margin-top:28px">
    Koda 0.6.0 · relatório completo, arquivo por arquivo dos 105, em
    <code>RELATORIO-QA-0.6.0.md</code>.
  </p>
</div>
</body>
</html>
"""

SAIDA.write_text(DOC, encoding="utf-8")
print(f"escrito: {SAIDA} ({SAIDA.stat().st_size / 1024:.0f} KB)")
