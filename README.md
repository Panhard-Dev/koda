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

**Ele executa, não improvisa.** Ler, criar e editar arquivos, rodar comandos e Python,
procurar no código com busca textual ou regex, ler páginas e pesquisar na web, e trabalhar
com git — inclusive commitar. O modelo recebe o resultado real de cada ferramenta antes de
responder, em vez de imaginar o que tem na pasta.

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
pasta`, `Rodar Python`, `Escrever arquivo`) são em `pt-BR`, com o nome técnico à mão para
quem quiser conferir a API.

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

## Licença e autorização de uso

**Projeto proprietário. Todos os direitos reservados.** Este repositório é público para
leitura e avaliação; **qualquer uso sem autorização prévia, expressa e por escrito do titular
é proibido** — inclusive executar, copiar, modificar, distribuir, treinar modelos de IA com
o código, usar a marca ou explorar comercialmente. O texto completo, com as definições e as
consequências, está em **[LICENSE](LICENSE)**.

Para pedir autorização: abra uma issue neste repositório ou fale com
[@Panhard-Dev](https://github.com/Panhard-Dev).

Copyright (c) 2026 Panhard-Dev.
