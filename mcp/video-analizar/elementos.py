"""CLI dos elementos de vídeo — o que o MCP `video-analizar` chama.

Fica em python de propósito: o motor (`app/video.py`) é python, e reimplementar
ffmpeg + Whisper em node seria duas implementações para divergir. O node só fala o
protocolo; quem trabalha é daqui.

Entra um pedido JSON no `stdin` (`caminho`, `quadros`, `pergunta`, `so_transcricao`),
sai o resultado JSON no `stdout`. Diagnóstico vai para o `stderr` — o `stdout` é só do
protocolo.

## Os quadros viajam como base64

O motor devolve os quadros como **bytes de JPEG em memória**, e aqui eles viram
`base64` no campo `jpeg` de cada momento. O node transforma isso no marcador
`KODA_QUADRO:` que o cliente do Koda troca por imagem de verdade no pedido do modelo.
Nenhum quadro é gravado no disco de ninguém.
"""

import base64
import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ / "backend"))

from app.config import Settings  # noqa: E402
from app.video import QUADROS_PADRAO, analisar, elementos  # noqa: E402


def _com_jpeg(resultado: dict) -> dict:
    """Troca os bytes de cada quadro pelo mesmo JPEG em base64 (o que trafega no JSON)."""
    for momento in resultado.get("momentos") or []:
        quadro = momento.get("quadro")
        if isinstance(quadro, (bytes, bytearray)):
            momento["jpeg"] = base64.b64encode(bytes(quadro)).decode("ascii")
            momento["quadro"] = "memória"
    # A lista crua de quadros não vai: quem manda a imagem é `momentos`, e mandar duas
    # vezes dobraria o peso do resultado sem o modelo ver nada a mais.
    resultado.pop("quadros", None)
    return resultado


def main() -> None:
    pedido = json.load(sys.stdin)
    settings = Settings()
    pasta = Path(settings.workspace_path) / ".koda-video"

    if pedido.get("so_transcricao"):
        # Só a fala: um quadrinho de qualquer tamanho já custa um ffmpeg, e para
        # "o que é falado" ele não serve de nada.
        resultado = elementos(pedido["caminho"], pasta, 1, True)
    else:
        resultado = analisar(
            pedido["caminho"],
            pasta,
            int(pedido.get("quadros") or QUADROS_PADRAO),
            str(pedido.get("pergunta", "")),
        )
    print(json.dumps(_com_jpeg(resultado), ensure_ascii=False))


if __name__ == "__main__":
    main()

