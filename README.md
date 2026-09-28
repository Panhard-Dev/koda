<p align="center">
  <img src="public/coroa.svg" width="96" alt="Coroa do Koda">
</p>

<h1 align="center">Koda</h1>

<p align="center">
  Seu chat de código: conversa como gente, entende o projeto e faz a tarefa — com as
  ferramentas na mão.
</p>

<p align="center">
  <img alt="Licença" src="https://img.shields.io/badge/licen%C3%A7a-propriet%C3%A1ria-b040d0">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149eca">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8-9135ff">
  <img alt="Português" src="https://img.shields.io/badge/interface-pt--BR-2f9e44">
</p>

---

> ### ⚠️ Projeto proprietário — uso proibido sem autorização
>
> Este repositório está público **apenas para leitura, consulta e avaliação**.
> **Usar, copiar, modificar, distribuir, treinar modelos com ele ou explorar
> comercialmente — no todo ou em parte — sem autorização prévia, expressa e por escrito do
> titular é proibido.** Até mesmo *fork* dentro do GitHub não concede licença de uso.
>
> Leia o arquivo **[LICENSE](LICENSE)** (a versão em português é a que vale) e, para pedir
> autorização, abra uma issue aqui ou fale com [@Panhard-Dev](https://github.com/Panhard-Dev).

---

## O que é o Koda

O Koda é uma área de código com cara de chat. Você escreve o que precisa — *"lista os
arquivos de `src/components`"*, *"esse teste está falhando, conserta"*, *"cria um script que
junta os CSVs dessa pasta"* — e ele **faz**, não só responde: lê e escreve arquivos, roda
comandos e Python, busca no código, pesquisa na web e mexe no git. Cada passo aparece na
conversa, com o que foi chamado, quanto tempo levou e o resultado atrás de um clique.

É um app para rodar no seu computador, com **os seus arquivos** e o **seu histórico** — o
que a tela mostra é o que fica guardado, então reabrir o Koda devolve a conversa inteira,
ferramentas incluídas.

## Destaques

**Ele executa, não improvisa.** 37 ferramentas: ler, criar, editar, mover, copiar, renomear
e apagar arquivos e pastas, aplicar um diff inteiro de uma vez, rodar comandos, rodar um
trecho de código (Python ou JavaScript, com `linguagem: node`) e verificar problema de
sintaxe, procurar arquivo por nome ou trecho de código, ler páginas e pesquisar na web,
instalar dependência e trabalhar com git — inclusive commitar, enviar e baixar. O modelo
recebe o resultado real de cada ferramenta antes de responder, em vez de imaginar o que tem
na pasta.

**Tarefa grande vira plano, e o plano aparece.** Quando o pedido tem várias partes, o Koda
divide em itens **antes** de mexer em qualquer coisa e mostra a lista na conversa — com o
que já foi feito riscado, o que está rodando girando e o quanto falta no cabeçalho.

**Ele não para no meio do caminho.** Quatro portões de parada seguram a conversa antes de
ela fechar: lista com item em aberto, código mudado sem nada ter sido executado depois,
fechamento que **promete** o próximo passo ("vou deletar o bench…") e tarefa de ação em que
nenhuma ferramenta funcionou. Cada um cobra a execução uma vez e, se ainda assim a tarefa
parar, o Koda diz o que faltou — citando o anúncio que ficou sem execução — em vez de
esconder que parou.

**Conversa longa e projeto grande não estouram o contexto.** O histórico inteiro é
reenviado a cada passo, então o Koda compacta em vez de estourar: saídas antigas das
ferramentas viram uma linha, o miolo resolvido dá lugar a um resumo do que já foi feito e a
janela recente encolhe — sem nunca quebrar a conversa. O teto é configurável
(`KODA_CONTEXTO_TOKENS`, **1 milhão** por padrão — a janela dos modelos) e sobe para o
que o modelo aguenta.

**Você acompanha o trabalho, não o silêncio.** Enquanto o Koda pensa, a coroa da marca
atravessa a tela com um brilho; cada ferramenta vira uma linha com o seu próprio desenho,
acendendo enquanto roda. Nada de esperar uma resposta que chega de uma vez, do nada.

**Esforço de raciocínio, por modelo.** Ao lado do seletor de modelo há um seletor de
esforço — e cada modelo guarda o seu: `Automático` (quem decide é o botão *Reasoning*),
`Mínimo`, `Baixo`, `Médio` ou `Alto`. Pergunta rápida num modelo leve, tarefa cabeluda num
modelo grande, sem ficar reconfigurando.

**Conversas de verdade, com parar de verdade.** O texto chega sendo escrito e o botão de
parar interrompe a geração na hora — o que já saiu continua na conversa. Dá para anexar
arquivos, ditar pelo microfone em `pt-BR` e buscar dentro do histórico, com o campo no topo
contando os acertos.

**Sua cara, sua tela.** Tema claro, escuro ou seguindo o sistema; quatro cores de destaque;
três fontes; tamanho da interface; e uma opção para reduzir animações. A tela de configuração
ainda traz a **conta**, o **uso** — com os limites diário, semanal e mensal e um mapa de
atividade do ano — e um **Sobre** que diz onde tudo é guardado.

**Feito em português.** A interface, as respostas e os rótulos das ferramentas (`Listar
pasta`, `Rodar Python`, `Escrever arquivo`) são em `pt-BR` — e o agente também entende os
nomes que outros agentes usam (`run_command`, `list_directory`, `apply_patch`), porque
quem escreve o nome é o modelo, não a interface.

**Acessível e navegável pelo teclado.** Todos os menus respondem a `↑` `↓` `Enter` `→` `←`
`Esc`, com `aria-expanded`, `aria-pressed` e `role="menu"` onde precisa.

## Como rodar

```bash
npm install
npm run dev      # abre a interface
npm run build    # build de produção
npm run lint     # checagem estática
```

O Koda conversa com o **serviço de modelos do projeto**, que é próprio e distribuído à
parte — os modelos não são públicos. Sem ele o app continua de pé, respondendo de forma
offline e explícita, em vez de fingir que está pensando.

## App desktop (Tauri)

A mesma interface empacotada como aplicativo nativo (Tauri 2 + WebView2), com ícone e
janela próprios. No Windows:

```bash
npm run app          # janela em modo dev (usa o Vite com HMR)
npm run app:build    # gera o instalador NSIS e o exe em src-tauri/target
```

Ao abrir, o app sobe as duas peças da conversa, nesta ordem, e **encerra as duas quando
fecha**:

1. o **host** (`host/c-host.exe`), que é o serviço dos modelos oficiais — ele vai **dentro
do instalador** (recurso `host/` do bundle) e o app o encontra ao lado do próprio exe;
2. o **backend** (`uvicorn` na porta 8787), procurado como
`backend/.venv/Scripts/python.exe` na árvore do projeto.

O que já estiver no ar é reutilizado em vez de subir de novo, e nada é encerrado à força
sem ter sido iniciado pelo app. Sem o backend a interface entra no modo offline dela — é o
que acontece com o app **instalado**, porque o pacote leva só o host (o backend é Python e
vem do projeto). O ícone é a coroa da marca sobre o fundo escuro do app (`assets/icon.png`,
gerado por `scripts/gerar-icone.mjs`).

## Licença e autorização de uso

**Projeto proprietário. Todos os direitos reservados.** Este repositório é público para
leitura e avaliação; **qualquer uso sem autorização prévia, expressa e por escrito do titular
é proibido** — inclusive executar, copiar, modificar, distribuir, treinar modelos de IA com
o código, usar a marca ou explorar comercialmente. O texto completo, com as definições e as
consequências, está em **[LICENSE](LICENSE)**.

Para pedir autorização: abra uma issue neste repositório ou fale com
[@Panhard-Dev](https://github.com/Panhard-Dev).

Copyright (c) 2026 Panhard-Dev.
