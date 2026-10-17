---
name: video-analizar
description: >-
  Analisa vídeo de verdade — o que é falado (transcrição com timestamps), o que aparece
  (quadros) e o que a pessoa quer com ele. Três peças trabalhando juntas: a pessoa
  **anexa** o vídeo na conversa e você VÊ os quadros como imagem; o MCP
  `video-analizar` analisa vídeo do disco; a rota `/api/video-analizar` é o mesmo motor
  para conferir. Use quando a pessoa mandar um vídeo e perguntar "o que é falado",
  "resume", "o que aparece em", "o que ele fala sobre", quando apontar um caminho de
  vídeo no disco, ou quando a resposta precisar do conteúdo de um vídeo — não de print.
---

# Analisar vídeo

Vídeo tem **duas** dimensões, e a skill existe para você não trocar uma pela outra: o
que é **falado** (transcrição) e o que é **visto** (quadros). A pessoa costuma querer
as duas amarradas — "o que ele fala quando mostra o preço na tela" — e a resposta certa
cruza as duas.

## O que você tem na mão

| Peça | O que entrega | Quando usar |
|---|---|---|
| **Anexo do vídeo na conversa** | Os quadros como **imagem** no seu contexto (você vê) + a transcrição completa como texto | Quando a pessoa **manda** o vídeo. É o caminho rico — é aqui que você vê de verdade. |
| **MCP `video-analizar`** | `analisar_video(caminho)` — metadados, transcrição e os **momentos** (segundo → quadro → fala). `transcrever_video(caminho)` — só a fala, mais barato. | Quando o vídeo está no **disco** e a pessoa fala dele por caminho ou nome. |
| **Rota `/api/video-analizar`** | O mesmo motor, com `pergunta` devolvida amarrada. | Para conferir na mão. Não é o seu caminho — o MCP é. |

**Regra dos quadros:** o MCP devolve os caminhos dos JPG, mas você **não os vê** — o
cliente do Koda traduz imagem de MCP em marcador de texto. Se a pergunta precisa do
visual ("o que aparece na tela"), peça à pessoa **anexar** o vídeo na conversa. Prometer
descrever um quadro que você não viu é inventar.

## O ciclo

```
a pessoa manda o vídeo? → anexo: você vê + lê
a pessoa aponta o disco? → MCP: você lê (e pede anexo se precisar ver)
entenda o que ela quer → responda ELE, não o vídeo em geral
```

1. **Descubra a intenção antes de analisar.** "Resume" pede a espinha do vídeo. "O que
   ele fala sobre X" pede busca na transcrição. "O que aparece no segundo 10" pede o
   momento certo. "Isso tem legenda?" pede conferir se há fala. A mesma palavra —
   "analisa" — esconde pedidos diferentes.
2. **Use a transcrição como fonte da fala.** Ela vem com timestamps (`0s - 5s: …`).
   Quando a pergunta citar um trecho, ache pelo tempo — não rebobine o vídeo inteiro.
3. **Cruze os momentos quando a pergunta misturar as duas dimensões.** Cada momento é
   `{tempo_s, quadro, fala}`: o segundo, o quadro daquele segundo e o que era falado
   ali. É o formato pronto para "o que ele fala enquanto mostra o preço".
4. **Responda o que foi pedido.** Se era resumo, dê o resumo. Se era uma pergunta
   específica, responda ela — não despeje a transcrição inteira.
5. **Se faltar o visual, peça.** "Para te dizer o que aparece na tela, me manda o vídeo
   anexado aqui que eu olho os quadros." Uma frase, e a conversa continua.

## O que a transcrição é — e o que ela não é

- **Ela erra.** Foi calibrada no vídeo do dono: acerta nomes próprios e pontuação, mas
  troca "pro" por "para o" e inventa palavra em fala rápida. Trate como fonte
  confiável do **sentido**, não como texto literal.
- **Ela não ouve o que não é fala.** Música, ambiência e grito sem palavra não entram.
- **Os quadros são uma amostra** (8 por padrão, até 24). Não são todos os frames do
  vídeo — não conclua "não aparece em nenhum momento" por não ter visto nos quadros.

## Custo — avise antes

A primeira transcrição de um vídeo leva **minutos** (CPU, sem GPU). Depois fica em
cache e é instantânea. Se a análise demorar, a pessoa precisa saber que é normal —
"transcrevendo, isso leva alguns minutos" — e não que travar.

## Honestidade

- Não invente o que não viu nem o que não ouviu. Quadro que você não viu, você não
  descreve.
- Se a transcrição não reconheceu fala nenhuma, diga isso — não preencha com suposição.
- Se o vídeo não abre (ffmpeg ausente, arquivo sumido), o erro vem escrito. Repasse o
  erro, não adivinhe a causa.
