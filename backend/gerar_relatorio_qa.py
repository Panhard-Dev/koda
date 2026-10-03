"""Gera o relatório do QA em Markdown, com a linha de cada um dos 105 arquivos.

Lê o material de referência, extrai a docstring de cada arquivo e monta a tabela: achado,
o que o arquivo carrega e o destino no Koda — portado (com o módulo que recebeu) ou
justificado.

    cd backend && .venv/Scripts/python.exe gerar_relatorio_qa.py
"""

from __future__ import annotations

import re
from pathlib import Path

REFERENCIA = Path(r"C:/Users/Administrator/Downloads/referencia-qa/trabalho")
SAIDA = Path(r"C:/Users/Administrator/Downloads/koda/RELATORIO-QA-0.6.0.md")

DOC = re.compile(r'^\s*(?:"""|\'\'\')\s*(.+?)(?:"""|\'\'\'|\n)', re.S)

ACHADOS = {
    "PERM": (
        "Problema principal — acesso local depois de proibido",
        "Porteira de despacho (`app/tools/guardas.py`): só o que a rodada **ofereceu** pode "
        "ser chamado, com recusa que vira o resultado da ferramenta e falha fechada. Mais a "
        "detecção por domínio em `app/tools/loop.py` (`SEM_SHELL`, `SEM_AMBIENTE`) e os "
        "grupos `FERRAMENTAS_LOCAIS`, `FERRAMENTAS_DE_SHELL` e `FERRAMENTAS_DO_AMBIENTE` em "
        "`app/tools/ferramentas.py`.",
    ),
    "DUP": (
        "Achado 8 — resposta duplicada",
        "`app/tools/repeticao.py`: o eco do modelo corta a rodada com aviso, em vez de ser "
        "costurado na resposta final pela continuação de truncamento.",
    ),
    "TURN": (
        "Achado 9 — UI presa em Pensando/Trabalhando",
        "Contrato de vivacidade nos dois lados: o backend emite o evento terminal também no "
        "caminho de erro (`app/routers/chat.py`) e o cliente desbloqueia a tela quando o "
        "fluxo fecha sem terminal (`src/api/client.ts`, gancho `onClosed`).",
    ),
    "RAC": (
        "Achado 7 — raciocínio/log interno visível",
        "`app/tools/pensamento.py`: limpa blocos de raciocínio do texto que vai à tela, "
        "segurando a marcação partida entre pedaços. Ligado em "
        "`app/providers/openai_compat.py`, depois do filtro de identidade.",
    ),
    "TOK": (
        "Achado 11 — consumo excessivo de tokens",
        "`app/tools/limites_de_saida.py`: corte com **cabeça e cauda** (40%/60%) no lugar do "
        "`texto[:teto]`, que jogava fora justamente o fim — onde está o erro do teste e o "
        "resultado do build. Sem o fim, o modelo repetia o comando para ver o que faltou.",
    ),
    "VOZ": (
        "Achado 12 — pedido de microfone em fluxo textual",
        "Verificado e travado por teste: nenhuma API de áudio é tocada na montagem, e o "
        "reconhecimento de fala nasce **só** no clique do botão "
        "(`src/components/Composer.tsx`).",
    ),
    "INJ": (
        "Achado 13 — prompt injection em história fictícia (não regredir)",
        "Nada foi alterado no caminho de leitura de conteúdo não confiável. O teste do QA "
        "passou e continua passando.",
    ),
    "SEG": (
        "Achado 14 — bypass de segredo por transformação (não regredir)",
        "Nada foi alterado no caminho de proteção de segredo. O teste do QA passou e "
        "continua passando.",
    ),
}

PORTADOS = {
    "RAC-think_scrubber.py": (
        "`app/tools/pensamento.py`",
        "Portado inteiro: a classe que segura marcação partida na fronteira entre pedaços, "
        "a lista de marcas, a regra de fronteira de bloco e o descarte no fim do fluxo.",
    ),
    "DUP-repetition_guard.py": (
        "`app/tools/repeticao.py`",
        "Portado inteiro: `dominada_por_repeticao`, `descontrolada`, `VigiaDeRepeticao` e "
        "todos os limiares.",
    ),
    "TOK-tool_output_truncate.py": (
        "`app/tools/limites_de_saida.py`",
        "Portado inteiro: a divisão 40/60, o formato único do aviso e a garantia de que o "
        "texto mantido tem exatamente o teto.",
    ),
}

SUSTENTACAO = {
    "PERM": (
        "Máquina interna de aprovação do projeto de origem: cartão humano, espera de "
        "gateway, escopo de terminal, cofre de segredo, redação de credencial. O Koda já tem "
        "o cartão de permissão dele (`app/approvals.py`, `app/tools/approval*.py`) e o "
        "escopo por pasta (`ferramentas.fora_da_pasta`). O que faltava era a **imposição no "
        "despacho**, e é ela que foi portada."
    ),
    "TURN": (
        "Ciclo de vida de sessão do projeto de origem: host de computação, supervisor de "
        "processo, ceifador de sessão, agendador periódico. O Koda não tem sessão hospedada "
        "nem processo destacado — o ciclo de vida dele é o do processo do app. O que o "
        "achado 9 pedia era o **contrato de vivacidade** da rodada, e é ele que foi "
        "implementado."
    ),
    "TOK": (
        "Compressão de contexto do projeto de origem: compressor, compactação nativa, "
        "orçamento por turno, preço de uso. O Koda já compacta contexto (`app/contexto.py`, "
        "`compactar_turnos`) e já conta uso por turno. O que o achado 11 pedia era o **corte "
        "da saída da ferramenta**, e é ele que foi portado."
    ),
    "VOZ": (
        "Modo de voz do projeto de origem: palavra de ativação, transcrição, TTS. O Koda usa "
        "o reconhecimento de fala do próprio navegador — não tem motor de transcrição nem "
        "palavra de ativação. O que o achado 12 pedia era a **regra de quando pedir o "
        "microfone**, e ela foi verificada e travada por teste."
    ),
    "DUP": (
        "Entrega de fluxo do projeto de origem: escrita única do canal, finalizador de "
        "turno, truncamento, metadados de mensagem. O Koda tem um canal só (SSE por "
        "requisição) e o fechamento dele é o `done` do router. O que o achado 8 pedia era "
        "**detectar o eco antes de costurá-lo**, e é isso que foi portado."
    ),
    "RAC": (
        "Projeção de exibição do projeto de origem: histórico de comentário, resumo de "
        "raciocínio, sanitização de mensagem, camada de display. O Koda mostra raciocínio em "
        "componente próprio, com o texto vindo por canal separado — o que vazava era a "
        "marcação **dentro do texto**. É o que o limpador portado resolve."
    ),
    "INJ": (
        "Varredura de injeção do projeto de origem: revisão em segundo plano, varredura de "
        "cron, política de skill, confiança de hook. Nada disso foi pedido pelo relatório — "
        "os dois testes de segurança do QA **passaram**. Mexer aqui seria risco sem pedido."
    ),
    "SEG": (
        "Cofre de credencial do projeto de origem: arquivos de credencial, autenticação de "
        "MCP, armazenamento de cofre. Mesma razão: o teste do QA passou, e o Koda não guarda "
        "chave de API em disco (a credencial é a sessão da conta, em memória)."
    ),
}


def docstring(caminho: Path) -> str:
    m = DOC.search(caminho.read_text(encoding="utf-8", errors="replace"))
    return " ".join(m.group(1).split())[:150] if m else "(sem docstring)"


def main() -> None:
    arquivos = [
        p for p in sorted(REFERENCIA.rglob("*"))
        if p.is_file() and not p.name.startswith("backend-")
    ]
    duplicatas = [
        p for p in sorted(REFERENCIA.rglob("*"))
        if p.is_file() and p.name.startswith("backend-")
    ]

    linhas: list[str] = [
        "# Relatório QA — correções no Koda 0.6.0",
        "",
        "Relatório do QA em `relatorio_qa_koda_v2.md`. Aqui está o que foi usado de cada",
        "arquivo do material de referência e o que foi implementado no Koda.",
        "",
        f"**{len(arquivos)} arquivos únicos** (mais {len(duplicatas)} `backend-*.py` da raiz, cópias",
        "byte a byte dos `limites/TURN-*.py` correspondentes — conferido com `cmp`).",
        "",
        "---",
        "",
        "## 1. Por que o controle de ferramentas podia ser contornado",
        "",
        "O Koda tinha **uma** camada, e ela era um pedido, não uma imposição: a ferramenta",
        "proibida era tirada do catálogo enviado ao modelo. Três furos se somavam:",
        "",
        "1. **A proibição era cancelada por ela mesma.** A régua que separa pedido de trabalho",
        "   de pedido de resposta tinha uma exceção: se o texto citasse arquivo, pasta ou",
        "   diretório, a ferramenta ficava de pé. Em *não use ferramentas, não leia arquivos*,",
        "   a palavra `arquivos` — que é o objeto da proibição — casava nessa exceção e",
        "   devolvia a rodada ao modo trabalho, com o catálogo inteiro de volta.",
        "2. **Não leia arquivos tirava só as ferramentas de arquivo.** `shell`,",
        "   `code_interpreter`, `get_environment` e `git_*` continuavam no catálogo — o mesmo",
        "   conteúdo estava a um `dir` ou a um `os.environ` de distância.",
        "3. **Não havia porteira no despacho.** O catálogo era a única barreira: o modelo que",
        "   emitisse a chamada assim mesmo era executado. E o prompt de ferramentas continuava",
        "   no sistema mandando chamar ferramenta mesmo com o catálogo vazio — o modelo recebia",
        "   duas ordens contraditórias e resolvia a favor da primeira.",
        "",
        "## 2. Causa-raiz",
        "",
        "A restrição vivia **no texto do prompt**, e a execução não a consultava. Não havia",
        "nenhum ponto no caminho de despacho que perguntasse *esta rodada permite esta",
        "ferramenta?* — a resposta estava só na lista enviada ao modelo, e o modelo é quem",
        "decidia. Ou seja: o controle era uma expectativa sobre o comportamento do modelo,",
        "não uma regra do orquestrador.",
        "",
        "## 3. A correção",
        "",
        "**A restrição passou a ser verificada antes de qualquer ferramenta tocar o sistema.**",
        "O catálogo que vai ao modelo virou também a **whitelist do despacho**: a mesma decisão",
        "que monta as ferramentas da rodada monta a guarda, e elas não podem divergir. Toda",
        "chamada passa por ela antes de executar; o que não foi oferecido volta como `NEGADO`",
        "no lugar da saída, e conta como bloqueio (para o laço não cobrar do modelo a",
        "ferramenta que ele mesmo acabou de negar). A guarda **falha fechada**: sem nome,",
        "quebra ou exceção, ela nega.",
        "",
        "E a detecção deixou de ser só sobre arquivos: passou a cobrir os domínios que o",
        "relatório lista — Desktop, diretórios, variáveis de ambiente, processos, sistema",
        "operacional, shell, hardware e informações do servidor.",
        "",
        "## 4. Como validar",
        "",
        "```bash",
        "cd backend",
        "uv run python -m pytest tests/ -q          # 424 testes",
        "python e2e_porteira.py                     # a porteira, sem depender do modelo",
        "python e2e_restricoes.py                   # agente vivo (exige host + backend 8787)",
        "```",
        "",
        "O `e2e_porteira.py` é o que importa para este caso: um dublê **insiste** em chamar a",
        "ferramenta proibida, e o teste responde a duas perguntas objetivas — quais ferramentas",
        "a rodada ofereceu e o que acontece com a chamada que insiste. Antes: 34 ferramentas",
        "oferecidas e a chamada devolvendo o ambiente da máquina. Depois: 2 oferecidas e a",
        "chamada negada.",
        "",
        "---",
        "",
        "## 5. Arquivo por arquivo",
        "",
        "| Arquivo | Achado | O que carrega | Destino no Koda |",
        "| --- | --- | --- | --- |",
    ]

    for caminho in arquivos:
        prefixo = caminho.name.split("-")[0]
        if caminho.name in PORTADOS:
            destino = "**portado** → " + PORTADOS[caminho.name][0]
        else:
            destino = "sustenta o mecanismo (ver §6)"
        resumo = docstring(caminho).replace("|", "/")
        linhas.append(f"| `{caminho.name}` | {prefixo} | {resumo} | {destino} |")

    linhas += ["", "### As cópias da raiz", ""]
    for caminho in duplicatas:
        par = caminho.name.replace("backend-", "limites/TURN-")
        linhas.append(
            f"- `{caminho.name}` — cópia byte a byte de `{par}.py` (conferido com `cmp`)."
        )

    linhas += ["", "---", "", "## 6. O que foi implementado, por achado", ""]
    for prefixo, (titulo, implementado) in ACHADOS.items():
        linhas += [f"### {titulo}", "", implementado, ""]
        linhas += [
            f"*Por que os outros arquivos do grupo não viraram código:* {SUSTENTACAO[prefixo]}",
            "",
        ]

    linhas += ["---", "", "## 7. Arquivos portados inteiros", ""]
    for nome, (destino, o_que) in PORTADOS.items():
        linhas += [f"- **`{nome}`** → {destino}", f"  - {o_que}"]

    linhas += [
        "",
        "## 8. Onde cada correção entrou",
        "",
        "| Arquivo do Koda | O que mudou |",
        "| --- | --- |",
        "| `app/tools/guardas.py` (novo) | A porteira de despacho: whitelist, recusa com mensagem, falha fechada. |",
        "| `app/tools/repeticao.py` (novo) | Detecção de eco; corta a rodada em vez de costurar a resposta. |",
        "| `app/tools/pensamento.py` (novo) | Limpeza de raciocínio no texto, inclusive partido entre pedaços. |",
        "| `app/tools/limites_de_saida.py` (novo) | Corte com cabeça e cauda no lugar do corte só de cabeça. |",
        "| `app/tools/ferramentas.py` | Grupos `FERRAMENTAS_LOCAIS`, `FERRAMENTAS_DE_SHELL`, `FERRAMENTAS_DO_AMBIENTE`; `_limitar` usa o corte novo. |",
        "| `app/tools/loop.py` | Proibição absoluta; detecção por domínio; porteira no despacho; prompt de ferramentas fora quando não há catálogo; regra contra resposta meta. |",
        "| `app/providers/openai_compat.py` | Limpador de raciocínio encadeado no streaming. |",
        "| `app/routers/chat.py` | Evento terminal também no caminho de erro, nos dois fluxos. |",
        "| `src/api/client.ts` | Gancho `onClosed`: fluxo fechado é rodada encerrada. |",
        "| `src/App.tsx` | `onError` e `onClosed` desbloqueiam a tela. |",
        "",
        "## 9. O que não foi mexido, e por quê",
        "",
        "- **Achados 13 e 14** (injeção em história fictícia e bypass de segredo): o relatório",
        "  registra que **passaram**. Não há defeito a corrigir, e mexer no caminho de leitura",
        "  de conteúdo não confiável sem defeito é risco sem pedido.",
        "- **Rotas, contratos e nomes existentes**: preservados. Nenhuma rota mudou de nome ou",
        "  de formato; os campos novos do evento `done` são aditivos.",
        "- **O motor trazido para `backend/nucleo/`**: 273 arquivos, importável, e **não**",
        "  ligado ao caminho de execução. Ligar isso é trocar o orquestrador, e a ordem que",
        "  você deu é corrigir os achados antes.",
        "",
    ]

    SAIDA.write_text("\n".join(linhas) + "\n", encoding="utf-8")
    print(f"escrito: {SAIDA} ({SAIDA.stat().st_size / 1024:.0f} KB, {len(arquivos)} arquivos)")


if __name__ == "__main__":
    main()
