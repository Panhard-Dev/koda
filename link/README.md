# koda-link

O "RustDesk do Koda": um servidor de encontro e relay que é **seu**, não da
nuvem do Koda. O PC abre uma sala, mostra um QR, e o celular entra nela para
falar com o Koda que está rodando no PC.

```
 celular  ──WS──►  koda-link  ◄──WS──  PC (Koda)
   QR                 │                 │
                      │                 └── backend local 127.0.0.1
                      └── sala + código de uso único
```

São três modos, no mesmo servidor:

| Modo | Onde o `koda-link` roda | Como o celular chega |
| --- | --- | --- |
| **Túnel público** | dentro do backend, atrás do Cloudflare Tunnel | `https://<aleatório>.trycloudflare.com` |
| **Mesma Wi-Fi** | dentro do backend do PC | `http://<ip-do-pc>:8798` |
| **De qualquer lugar** | num VPS / Raspberry Pi / Tailscale | `https://link.seudominio.com` |

No modo local nada sai da rede de casa. No modo remoto o PC conecta **de
saída** no servidor — não é preciso abrir porta no roteador nem expor o
backend.

## Túnel público (o atalho do ícone de celular)

No app do PC: toque no **ícone de celular** no topo, ou **Ajustes › Celular ›
Túnel público › Abrir túnel e mostrar QR**.

O backend faz tudo sozinho:

1. escolhe uma **porta livre** e sobe uma instância nova do link só para aquele
   QR, escutando em `127.0.0.1`;
2. abre um **Cloudflare quick tunnel** para essa porta;
3. cria a sala e devolve o QR com o endereço público.

O túnel fica **aberto até você tocar em Desligar** (ou fechar o Koda). Não há
expiração automática. Cada novo QR fecha o anterior e nasce com **porta,
endereço, sala, código e sessão novos** — nada é reaproveitado.

O binário do `cloudflared` é baixado pelo próprio Koda na primeira vez e fica
em `backend/data/bin/` (fora do repositório). Se preferir, instale no `PATH`
ou aponte `KODA_CLOUDFLARED` para ele.

### O que protege o túnel

- **Lista fechada de rotas.** O link só aceita `GET /api/provedores`,
  `GET /api/provedores/<id>/modelos`, `GET|PUT /api/permissions`,
  `GET /api/projects`, `POST /api/chat`, `POST /api/chat/approval`,
  `POST /api/attachments` e `GET /api/health`. O resto responde erro — e não
  existe HTTP `/api/*` público: a API só é alcançada por dentro do WebSocket
  pareado.
- **Código de uso único + sessão.** O primeiro pareamento consome o código e
  devolve uma sessão; um segundo celular com o mesmo código é recusado.
- **Freio por sala.** 90 pedidos por minuto e 4 pedidos simultâneos; acima
  disso o link recusa mesmo com o QR na mão.
- **Origem conferida.** O WebSocket só aceita a origem da própria página
  servida pelo link.
- **Sem docs.** O servidor do link não publica OpenAPI nem Swagger.
- **Token em casa.** O `Authorization` do backend local é injetado pelo PC;
  nunca entra no QR, no link ou no Cloudflare.
- **Criação de sala fechada.** No modo público, `POST /api/salas` exige o
  token administrativo interno (aleatório por sessão), porque atrás do túnel
  todo pedido chega de `127.0.0.1`.

## Mesma Wi-Fi (o caminho fácil)

No app do PC: **Ajustes › Celular › Mesma Wi-Fi › Ligar e mostrar QR**.

O backend sobe este servidor em `0.0.0.0:8798`, cria a sala e mostra o QR. O
celular precisa estar na mesma rede do PC.

Se preferir rodar o servidor à mão:

```bash
cd link
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

KODA_API_URL=http://127.0.0.1:8787 \
KODA_API_TOKEN=... \
KODA_LINK_PUBLIC_URL=http://192.168.1.4:8798 \
.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8798
```

Depois abra `http://192.168.1.4:8798/` no PC e crie a sala, ou use a tela
Celular do app (que faz isso por você).

## De qualquer lugar (servidor próprio)

Num VPS (ou numa máquina sempre ligada), com um domínio apontando para ele:

```bash
cd link
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

KODA_LINK_TOKEN="um-segredo-longo" \
KODA_LINK_PUBLIC_URL="https://link.seudominio.com" \
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8798
```

Coloque um proxy com TLS na frente (Caddy resolve em três linhas):

```caddyfile
link.seudominio.com {
    reverse_proxy 127.0.0.1:8798
}
```

No app do PC: **Ajustes › Celular › De qualquer lugar**, informe
`https://link.seudominio.com` e o mesmo `KODA_LINK_TOKEN`, e gere o QR. O PC
fica conectado de saída ao servidor; o celular entra pela sala.

> Sem TLS o código da sala viaja em claro. Para uso fora de casa, use HTTPS —
> o WebSocket vira `wss://` sozinho.

## Como a sala funciona

1. O PC chama `POST /api/salas` e recebe `sala`, `codigo`, `segredo` e `url`.
2. O QR carrega `.../mobile/#sala=<sala>&codigo=<codigo>`. O `#` não vai para
   o servidor HTTP; o código só aparece no WebSocket.
3. O celular abre `WS /ws/<sala>?papel=convidado&codigo=...`. O código é
   **consumido** e o servidor devolve uma `sessao`, que o celular guarda para
   reconectar sem precisar de um QR novo.
4. O PC, no modo remoto, abre `WS /ws/<sala>?papel=host&segredo=...` e fica
   escutando. No modo local o próprio servidor repassa para
   `KODA_API_URL`.
5. Cada pedido do celular (`GET /api/projects`, `POST /api/chat`…) vira um
   quadro JSON; a resposta volta em `inicio` → `pedaco`… → `fim`. O SSE do chat
   atravessa sem mudar de forma.

O token da API do Koda **nunca** entra no QR, no servidor de link ou no
celular. Quem injeta o `Authorization` é o PC, na hora de falar com o backend
local.

> **O QR é uma senha.** Quem entra na sala fala com o agente do PC — pode ler
> arquivos, rodar ferramentas e responder pedidos de permissão. Mostre o QR só
> para o seu celular e feche a sala quando terminar.

## Variáveis

| Variável | Para que serve |
| --- | --- |
| `KODA_API_URL` | backend local a repassar (só no modo mesma Wi-Fi) |
| `KODA_API_TOKEN` | token do backend local (só no modo mesma Wi-Fi) |
| `KODA_LINK_TOKEN` | segredo para criar salas num servidor público |
| `KODA_LINK_PUBLIC_URL` | URL que entra no QR (atrás de proxy, use a pública) |
| `KODA_LINK_TTL` | validade da sala em segundos (padrão 900) |
| `KODA_LINK_MAX_SALAS` | salas simultâneas (padrão 64) |
| `KODA_LINK_MOBILE_DIR` | pasta do mobile servida em `/mobile` |

## Limites desta versão

- O relay repassa os quadros; ainda não há hole punching P2P como o do
  RustDesk. Para o volume de uma conversa, o relay é suficiente.
- O QR é gerado com o pacote Python `qrcode`. Se ele não estiver instalado, a
  tela mostra o link e o código para digitar — o pareamento continua.
- O servidor guarda as salas em memória. Reiniciou, as salas sumiram; é só
  gerar outro QR.
