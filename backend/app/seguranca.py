"""Token por execução: quem pode falar com a API local.

O backend escuta em `127.0.0.1`, e isso **não** é fronteira de segurança: qualquer processo
da mesma máquina alcança a porta, e o agente roda código nesta máquina. Sem token, o código
que o agente executa pode chamar `PUT /api/permissions` e se dar o modo `auto`, inserir
regra «sempre» direto no banco ou trocar o workspace — ou seja, **se auto-aprovar**.

O token nasce **uma vez por execução**, no launcher (Rust), e chega ao backend por **stdin**
(`pipe`), nunca por variável de ambiente: o ambiente é justamente o que o código do agente
lê (ver `ferramentas._ambiente_do_comando`). Quem tem o token é a interface, que o recebe
do launcher por `invoke`.

A regra é **deny-by-default**: toda rota sob `/api` exige o token, e rota nova nasce
protegida — não existe lista de rotas protegidas para alguém esquecer de atualizar. As
exceções são três, e cada uma tem motivo:

- `OPTIONS` — o *preflight* do CORS. O navegador **não** manda `Authorization` no preflight;
  sem esta exceção toda chamada do app devolveria 401.
- `GET /api/health` — o launcher bate aqui para saber se o serviço respondeu, e o front
  pergunta ao carregar. Devolve só `ok` e a versão (sem workspace, sem caminho do banco,
  sem lista de ferramentas): o diagnóstico detalhado fica em `/api/health/detalhado`, que
  exige token.
- `GET /api/handshake` — o desafio do launcher (ver `hmac_do_nonce`).

Em dev (`uv run uvicorn`, sem launcher) o token vem de `KODA_API_TOKEN` — variável que só
vale **fora** do empacotado — ou é sorteado e impresso no terminal.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sys
import threading

#: Rotas que respondem sem token. Comparação é **exata**: `/api/health/detalhado` não entra
#: aqui por não ser `/api/health`.
ROTAS_ABERTAS = frozenset({"/api/health", "/api/handshake"})

#: Prefixo protegido. Fora dele (docs, raiz) quem decide é a montagem do app.
PREFIXO = "/api"

#: Quanto esperar pelo token no stdin antes de seguir sem ele.
PRAZO_DO_STDIN_S = 10.0

#: O token desta execução. Vive só na memória do processo — nunca vai para disco, log ou
#: ambiente dos filhos.
_TOKEN: str | None = None


def empacotado() -> bool:
    """O launcher marcou este backend como o do instalador?"""
    return os.environ.get("KODA_BACKEND_PACKAGED") == "1"


def sortear() -> str:
    """Token novo: 32 bytes de aleatoriedade criptográfica, em texto seguro para URL."""
    return secrets.token_urlsafe(32)


def definir(valor: str | None) -> None:
    """Fixa o token desta execução (o launcher, ou o teste)."""
    global _TOKEN
    _TOKEN = valor


def token() -> str | None:
    return _TOKEN


def ativo() -> bool:
    return _TOKEN is not None


def confere(cabecalho: str | None) -> bool:
    """O `Authorization` apresentado é o token desta execução?

    Comparação em tempo constante: um `==` comum para no primeiro byte diferente, e o
    tempo da resposta conta quantos bytes acertaram.
    """
    if not _TOKEN:
        return False
    if not cabecalho:
        return False
    esquema, _, valor = cabecalho.partition(" ")
    if esquema.lower() != "bearer":
        return False
    return hmac.compare_digest(valor.strip(), _TOKEN)


def liberada(caminho: str) -> bool:
    """Esta rota passa sem token?"""
    if not caminho.startswith(PREFIXO):
        # Fora de `/api` não há o que proteger por aqui: as rotas de fora (docs, raiz) são
        # desligadas no empacotado, na montagem do app.
        return True
    return caminho.rstrip("/") in ROTAS_ABERTAS or caminho in ROTAS_ABERTAS


def hmac_do_nonce(nonce: str) -> str:
    """Prova de que este processo conhece o token — sem revelá-lo.

    É o que o launcher usa para saber se quem está na porta é **o backend desta execução**:
    ele manda um nonce, compara o HMAC devolvido com o que ele mesmo calcula. Como o token
    é sorteado por execução, um backend de execução anterior nunca acerta — e aí o
    comportamento esperado é ele sair da frente, não ser adotado.
    """
    chave = (_TOKEN or "").encode("utf-8")
    return hmac.new(chave, nonce.encode("utf-8"), hashlib.sha256).hexdigest()


def do_stdin(prazo_s: float = PRAZO_DO_STDIN_S) -> str | None:
    """Lê o token da primeira linha do stdin, se o stdin não for um terminal.

    O launcher abre o backend com o stdin num `pipe` e escreve o token ali. Quando alguém
    sobe o backend à mão, o stdin é o terminal e a leitura **bloquearia** — daí a checagem
    de `isatty` antes, e o prazo como segunda rede.
    """
    try:
        if sys.stdin is None or os.isatty(0):
            return None
    except (OSError, ValueError, AttributeError):
        return None

    caixa: list[str] = []

    def ler() -> None:
        try:
            caixa.append(sys.stdin.readline())  # type: ignore[union-attr]
        except Exception:  # stdin fechado, capturado pelo pytest, canal quebrado
            pass

    fio = threading.Thread(target=ler, daemon=True)
    fio.start()
    fio.join(prazo_s)
    if not caixa:
        return None
    return caixa[0].strip() or None


def do_ambiente() -> str | None:
    """`KODA_API_TOKEN`, mas **só fora do empacotado**.

    É a conveniência do dev: `KODA_API_TOKEN=x uv run uvicorn …` e a interface do Vite usa
    o mesmo valor. No app instalado o token é sempre sorteado por execução — aceitar um
    valor vindo do ambiente seria aceitar um valor que o código do agente pode ter posto lá.
    """
    if empacotado():
        return None
    valor = os.environ.get("KODA_API_TOKEN")
    return valor.strip() if valor and valor.strip() else None


def preparar() -> str:
    """Resolve o token desta execução. Chamado uma vez, na subida do app.

    Ordem: stdin (o launcher) → `KODA_API_TOKEN` (só em dev) → sorteio. Se alguém já fixou
    o token (o teste, por exemplo), ele é respeitado.
    """
    global _TOKEN
    if _TOKEN is None:
        _TOKEN = do_stdin() or do_ambiente() or sortear()
        _anunciar()
    return _TOKEN


def _anunciar() -> None:
    """Diz no terminal de onde veio o token — só faz sentido em dev, onde não há launcher."""
    if empacotado():
        return
    origem = "KODA_API_TOKEN" if os.environ.get("KODA_API_TOKEN") == _TOKEN else "sorteado agora"
    print(
        f"[koda] token da API local ({origem}): {_TOKEN}\n"
        "[koda] a interface precisa do mesmo valor (VITE_API_TOKEN) fora do app desktop",
        flush=True,
    )
