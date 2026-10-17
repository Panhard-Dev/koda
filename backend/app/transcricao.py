"""Transcrição de fala — o que a coluna do editor de vídeo mostra.

O áudio chega como **WAV 16 kHz mono**, exportado pelo próprio front: ele já decodifica
o arquivo inteiro para desenhar a onda, e reexportar daí evita ffmpeg no servidor — e
evita também que o backend precise ler o arquivo de vídeo do disco.

O motor é o **faster-whisper** (CTranslate2, sem torch): em CPU, o modelo `base` em
`int8` transcreve português em velocidade suficiente para um vídeo de alguns minutos.
O modelo é carregado **uma vez** e fica no processo — a primeira chamada paga o
download do HuggingFace, as seguintes não.

O WAV é decodificado **aqui**, com `wave` + numpy, e entregue ao Whisper como array.
Não é perfeição, é remendo necessário: o PyAV que veio junto no venv desta máquina é
uma build quebrada (`av 19.0.1` — versão que não existe no PyAV oficial) e o
`decode_audio` dele morre com `TypeError` no `metadata_errors`. WAV PCM a gente lê
sem ele.
"""

from __future__ import annotations

import tempfile
import threading
import wave
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    from faster_whisper import WhisperModel

#: O modelo, carregado na primeira transcrição. `small` em `int8` em CPU: o `base` foi
#: medido no vídeo de teste do dono (com legenda queimada) e erra o que importa —
#: "padeira" virava "paderem", "The Witch's Bakery" virava "Weets bakery". O `small`
#: acertou os dois. Custa ~2,5x o tempo do base (~2x tempo real em CPU); `medium` é o
#: próximo degrau, se um dia a paciência pedir.
_MODELO = "small"

#: Idiomas e formato pedidos ao modelo. `condition_on_previous_text=False` é a minha
#: correção para o defeito que o dono descreveu — "faz certo mas vai ficando ruim":
#: com o contexto ligado, um erro no minuto 1 ensina o modelo a repetir a família de
#: erro dele no minuto 5. Sem ele, cada janela é julgada sozinha. O `initial_prompt`
#: segura o português do Brasil e a pontuação.
_IDIOMA = "pt"
_PROMPT_INICIAL = (
    "Transcrição em português do Brasil, com pontuação. Nomes próprios ficam como estão."
)

_modelo: WhisperModel | None = None
_trava = threading.Lock()


def _carregar() -> WhisperModel:
    global _modelo
    if _modelo is None:
        from faster_whisper import WhisperModel

        _modelo = WhisperModel(_MODELO, device="cpu", compute_type="int8")
    return _modelo


def _ler_wav(caminho: Path) -> np.ndarray:
    """As amostras do WAV como `float32` em [-1, 1] — o formato que o Whisper engole.

    Só PCM 16 bits, que é o único formato que o front exporta (e o único que o `wave`
    da stdlib lê sem dependência). Outra profundidade levanta `wave.Error` e a rota
    devolve 400 — melhor isso do que transcrever um áudio remapeado errado.
    """
    with wave.open(str(caminho), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("o WAV precisa ser PCM 16 bits mono")
        quadros = w.readframes(w.getnframes())
    return np.frombuffer(quadros, dtype=np.int16).astype(np.float32) / 32768.0


def transcrever(wav: bytes) -> list[dict[str, object]]:
    """Os segmentos da fala: início, fim e texto de cada um.

    `beam_size=5` agora dá — em CPU a busca em feixe custa mais, e o `small` com
    `beam_size=1` (greedy) trocava palavras por pressa. As três travas de qualidade
    (`small`, contexto desligado, prompt inicial) foram medidas no vídeo de teste do
    dono, que tem legenda queimada para conferir.
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav)
        caminho = Path(tmp.name)
    try:
        modelo = _carregar()
        segmentos, _info = modelo.transcribe(
            _ler_wav(caminho),
            language=_IDIOMA,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt=_PROMPT_INICIAL,
        )
        return [
            {
                "inicio": round(seg.start, 1),
                "fim": round(seg.end, 1),
                "texto": seg.text.strip(),
            }
            for seg in segmentos
            if seg.text.strip()
        ]
    finally:
        caminho.unlink(missing_ok=True)
