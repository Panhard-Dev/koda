"""Os elementos de um vídeo — metadados, frames e transcrição.

O que a IA recebe quando alguém manda um vídeo na conversa: os **frames como imagem** (o
modelo vê, quadro por quadro) e a transcrição como texto.

## O motor é o PyAV — dentro do Koda, sem binário de fora

O pacote `av` traz o FFmpeg **embutido** como biblioteca (as DLLs em `av.libs`, ~64 MB).
Nenhum `ffmpeg.exe` da máquina é chamado: o vídeo é lido e decodificado dentro do processo
do backend. Antes isto era `subprocess` no ffmpeg do winget, e bastava o binário do
sistema quebrar para a área de vídeo inteira parar — foi o que aconteceu.

### A ordem de carga das DLLs importa

No Windows, `import av` sozinho falhava com `ERROR_BAD_EXE_FORMAT` na `avformat` — que é
justamente quem **abre o contêiner**. O motivo é a ordem: a `avformat` importa a
`avcodec`, que importa a `avutil`, e pedindo o pacote de uma vez o Windows tenta resolver
a árvore inteira e desiste. Carregando `avutil` → `swresample` → `swscale` → `avcodec` →
`avformat` **antes**, cada carga seguinte encontra tudo pronto e o motor sobe. É o que
`_carregar_dlls()` faz, e é a diferença entre funcionar e não funcionar.

## Cache

Só a **transcrição** (minutos de CPU) é gravada, em
`{workspace}/.koda-video/{chave}/transcricao.json`. Os quadros **nunca** tocam o disco:
saem do decodificador em memória, viram JPEG e vão direto ao contexto do modelo.
"""

from __future__ import annotations

import ctypes
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from . import transcricao

#: Extensões aceitas — as mesmas do seletor do editor. O mime é o do anexo.
EXTENSOES_DE_VIDEO = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".ogv": "video/ogg",
}

#: Quantos quadros o anexo entrega por padrão.
#:
#: Eram 8, e 8 é pouco: num vídeo de um minuto isso é um quadro a cada 7,5s, e o modelo
#: perde justamente o que aconteceu **entre** dois deles — foi assim que um vídeo de três
#: cores apareceu com duas. O quadro sai a 480px e pesa ~1 KB (JPEG), então 16 continua
#: barato no contexto e cobre o vídeo de verdade. O teto da rota segue em 24.
QUADROS_PADRAO = 16

#: Largura dos frames gerados. 480px já dá para ler texto na tela e pesa pouco no pedido.
LARGURA_DO_QUADRO = 480

#: Qualidade do JPEG no PyAV (escala 0-31, **menor é melhor**). 4 dá ~1 KB a 480px.
QUALIDADE_JPEG = 4

#: Tempo máximo da extração de áudio para o Whisper, em segundos.
_TIMEOUT_AUDIO = 300

_av = None
_erro_do_av: str | None = None


def _carregar_dlls() -> None:
    """Põe as DLLs do FFmpeg no processo, na ordem que o carregador do Windows aceita.

    Ver o cabeçalho: sem isto o `import av` falha e não há vídeo. Fora do Windows, ou num
    wheel sem `av.libs`, isto não faz nada — o próprio pacote resolve as bibliotecas, e o
    `import` abaixo é quem diz se o motor ficou de pé.
    """
    try:
        import av  # noqa: F401
    except ImportError:
        pass
    else:
        return

    try:
        base = Path(sys.prefix) / "Lib" / "site-packages" / "av.libs"
        if not base.is_dir():
            return
        for nome in (
            "avutil-61-e540ec7976bbd26a4a94dc737be3001c.dll",
            "swresample-7-4f9462a1fb73b949ccad2774dd941624.dll",
            "swscale-10-9af0a10ad7003982e48548ff39e98465.dll",
            "avcodec-63-2756d4fffb772585dcdece87427716a4.dll",
            "avformat-63-e8c4f8fc30664f2b7e85dcc683bd4b0d.dll",
            "avfilter-12-87c7677b784d3ea4ecceb3e6cae9c9f1.dll",
            "avdevice-63-2b26d22512639c049532c0bc6f6c022f.dll",
        ):
            alvo = base / nome
            if alvo.exists():
                try:
                    ctypes.WinDLL(str(alvo))
                except OSError:
                    # Uma que não carregue não impede as outras — o `import av` diz se o
                    # conjunto ficou utilizável.
                    pass
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(base))
    except Exception:  # noqa: BLE001 — ambiente sem Windows cai aqui e segue
        pass


def _motor():
    """O módulo `av`, carregado sob demanda. `None` quando não há motor."""
    global _av, _erro_do_av
    if _av is not None or _erro_do_av is not None:
        return _av
    _carregar_dlls()
    try:
        import av

        _av = av
    except Exception as erro:  # noqa: BLE001
        _erro_do_av = f"{type(erro).__name__}: {erro}"
    return _av


def motor_disponivel() -> tuple[bool, str]:
    """O decodificador está de pé? Devolve `(ok, motivo)` — o motivo é para a tela."""
    if _motor() is not None:
        return True, ""
    return False, _erro_do_av or "o decodificador de vídeo não está disponível"


def _meta(caminho: Path) -> dict[str, object]:
    """Duração, largura, altura e fps — lidos pelo motor embutido.

    Não chama `ffprobe` de fora: o PyAV já sabe tudo isto ao abrir o contêiner, e um
    binário externo era mais uma peça para faltar na máquina.
    """
    av = _motor()
    if av is None:
        raise RuntimeError(motor_disponivel()[1])
    try:
        with av.open(str(caminho)) as container:
            if not container.streams.video:
                raise RuntimeError("este arquivo não tem faixa de vídeo")
            stream = container.streams.video[0]
            duracao = float(container.duration or 0) / 1_000_000
            if not duracao and stream.duration:
                duracao = float(stream.duration * stream.time_base)
            taxa = stream.average_rate
            return {
                "duracao": round(duracao, 1),
                "largura": int(stream.width or 0),
                "altura": int(stream.height or 0),
                "fps": f"{taxa.numerator}/{taxa.denominator}" if taxa else "",
            }
    except RuntimeError:
        raise
    except Exception as erro:  # noqa: BLE001
        raise RuntimeError(f"não consegui ler este vídeo: {erro}") from erro


def _chave(caminho: Path, quadros: int) -> str:
    """A chave deste vídeo (nesta contagem de quadros), para o cache da transcrição."""
    estado = caminho.stat()
    marca = f"{caminho}|{estado.st_size}|{estado.st_mtime_ns}|{quadros}"
    return hashlib.sha1(marca.encode("utf-8", "replace")).hexdigest()[:20]


def _quadro_para_jpeg(av, quadro, largura: int) -> bytes:
    """Um quadro decodificado vira JPEG, **sem Pillow**.

    O caminho óbvio (`frame.to_image()` + `save`) depende do Pillow, que não está no
    runtime do Koda — e instalar mais um pacote para isto seria trocar uma dependência por
    outra. O próprio FFmpeg embutido já tem o codificador MJPEG, usado **direto**: o
    pacote que sai do `encode` já é o arquivo JPEG inteiro, sem contêiner em volta (o
    muxer `image2` quer um caminho de arquivo de verdade, e aqui não há arquivo nenhum).
    """
    from fractions import Fraction

    imagem = quadro.reformat(width=largura, format="yuvj420p")
    codec = av.CodecContext.create("mjpeg", "w")
    codec.width = imagem.width
    codec.height = imagem.height
    codec.pix_fmt = "yuvj420p"
    codec.time_base = Fraction(1, 25)
    codec.open()
    pacotes = codec.encode(imagem)
    if not pacotes:
        raise RuntimeError("o codificador não devolveu imagem para este quadro")
    return bytes(pacotes[0])


def extrair_quadros(caminho: Path, quadros: int, duracao: float) -> list[bytes]:
    """Os quadros como **bytes de JPEG, em memória** — um a cada (duração/quadros).

    O decodificador lê o vídeo e cada quadro é reduzido a 480px e codificado em JPEG em
    memória. Nada toca o disco e nenhum programa de fora é chamado.

    A amostragem é por **tempo alvo**: em vez de pular N quadros (o que depende do fps do
    arquivo e erra a conta em vídeo de taxa variável), pede-se o quadro mais próximo de
    cada instante `(i + 0.5) * duração / quadros`. É o mesmo critério do editor de vídeo,
    então o que a pessoa vê na timeline é o que o modelo recebe.
    """
    av = _motor()
    if av is None:
        raise RuntimeError(motor_disponivel()[1])
    if quadros < 1:
        return []

    alvos = [((i + 0.5) * duracao / quadros) for i in range(quadros)]
    if not duracao:
        alvos = [0.0] * quadros

    saida: list[bytes] = []
    with av.open(str(caminho)) as container:
        stream = container.streams.video[0]
        # O alvo só avança, então basta comparar com o instante de cada quadro decodificado.
        proximo = 0
        for quadro in container.decode(stream):
            if proximo >= len(alvos):
                break
            instante = float(quadro.time or 0)
            if instante >= alvos[proximo]:
                saida.append(_quadro_para_jpeg(av, quadro, LARGURA_DO_QUADRO))
                proximo += 1

    if not saida:
        # Nenhum quadro decodificável: devolver vazio é a verdade, e quem chama já trata.
        return []
    # Vídeo mais curto que a amostragem: repete o último para a contagem bater — quem
    # consome espera N quadros, não "N ou menos".
    while len(saida) < quadros:
        saida.append(saida[-1])
    return saida


def _transcrever_video(caminho: Path, destino: Path) -> list[dict[str, object]]:
    """A transcrição da fala, com cache.

    O áudio sai pelo motor embutido, em WAV 16k mono, para um arquivo **temporário** — o
    Whisper em `transcricao` quer os bytes, e o decodificador entrega melhor por arquivo.
    O WAV some no fim do `with`; o que fica é só o JSON com as falas, que é texto leve, e
    existe porque a transcrição custa minutos de CPU: sem cache, cada análise de vídeo
    longo pagaria tudo de novo.
    """
    cache = destino / "transcricao.json"
    if cache.exists():
        return json.loads(cache.read_text("utf-8"))

    av = _motor()
    if av is None:
        raise RuntimeError(motor_disponivel()[1])

    with tempfile.TemporaryDirectory(prefix="koda-audio-") as tmp:
        wav = Path(tmp) / "audio.wav"
        with av.open(str(caminho)) as container:
            if not container.streams.audio:
                # Vídeo **sem faixa de áudio** (tela gravada muda, GIF virou mp4) não tem o
                # que transcrever. Devolver vazio é a verdade — e não derruba os quadros,
                # que não dependem de som nenhum.
                cache.write_text("[]", "utf-8")
                return []
            fluxo = container.streams.audio[0]
            with av.open(str(wav), mode="w", format="wav") as saida:
                destino_audio = saida.add_stream("pcm_s16le", rate=16000)
                destino_audio.layout = "mono"
                for quadro in container.decode(fluxo):
                    quadro.pts = None
                    for remontado in destino_audio.encode(quadro):
                        saida.mux(remontado)
        segmentos = transcricao.transcrever(wav.read_bytes())

    cache.write_text(json.dumps(segmentos, ensure_ascii=False), "utf-8")
    return segmentos


def assinatura_de_video(dados: bytes) -> str | None:
    """O mime do vídeo pela assinatura, ou `None` se não é vídeo.

    Mesma disciplina do `anexos.validar`: não confiar na extensão. `.mp4`/`.mov` são
    família ISO-BMFF (`ftyp` no offset 4); `.webm`/`.ogv` são Matroska.
    """
    if dados[4:8] == b"ftyp":
        return "video/mp4"
    if dados[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    return None


def elementos(
    caminho: str,
    pasta_do_cache: Path,
    quadros: int = QUADROS_PADRAO,
    com_transcricao: bool = True,
) -> dict[str, object]:
    """Tudo que a IA precisa ver de um vídeo.

    `quadros` vem como **bytes de JPEG em memória** (ver `extrair_quadros`): quem consome
    transforma em `data:` URL e o modelo vê a imagem. `caminho` só é usado para ler o
    vídeo; nenhum quadro é gravado no PC.

    `pasta_do_cache` guarda **apenas a transcrição**. `com_transcricao=False` pula o
    Whisper, para quem só quer os quadros.
    """
    alvo = Path(caminho)
    if not alvo.is_file():
        raise FileNotFoundError(f"vídeo não encontrado: {caminho}")
    destino = pasta_do_cache / _chave(alvo, quadros)
    destino.mkdir(parents=True, exist_ok=True)

    meta = _meta(alvo)
    duracao = float(meta["duracao"] or 0)

    resultado: dict[str, object] = {
        "caminho": str(alvo),
        "duracao_s": meta["duracao"],
        "largura": meta["largura"],
        "altura": meta["altura"],
        "fps": meta["fps"],
        "quadros": extrair_quadros(alvo, quadros, duracao),
    }
    if com_transcricao:
        resultado["transcricao"] = _transcrever_video(alvo, destino)
    return resultado


def momentos_do_video(
    base: dict[str, object], pergunta: str = ""
) -> list[dict[str, object]]:
    """Cada quadro com o segundo dele e a fala daquele instante.

    É o formato que a IA consome de uma vez: em vez de cruzar lista de quadros com lista
    de falas, cada momento já vem montado — `{tempo_s, quadro, fala}`, com `quadro` sendo
    os **bytes** da imagem.
    """
    duracao = float(base.get("duracao_s") or 0)
    gerados = list(base.get("quadros") or [])
    falas = list(base.get("transcricao") or [])
    momentos: list[dict[str, object]] = []
    for indice, quadro in enumerate(gerados):
        tempo = ((indice + 0.5) * duracao / max(len(gerados), 1))
        fala = next(
            (f["texto"] for f in falas if float(f["inicio"]) <= tempo <= float(f["fim"])),
            "",
        )
        momentos.append({"tempo_s": round(tempo, 1), "quadro": quadro, "fala": fala})
    return momentos


def analisar(
    caminho: str,
    pasta_do_cache: Path,
    quadros: int = QUADROS_PADRAO,
    pergunta: str = "",
) -> dict[str, object]:
    """Os elementos **com os momentos**: cada quadro com o segundo dele e a fala daquele
    instante.

    `pergunta`, quando vem, é devolvida no resultado: é o que a pessoa quer com o vídeo, e
    a IA precisa vê-la amarrada aos elementos para responder **ela**, não o vídeo em geral.
    """
    base = elementos(caminho, pasta_do_cache, quadros, True)
    resultado = {**base, "momentos": momentos_do_video(base, pergunta)}
    if pergunta.strip():
        resultado["pergunta"] = pergunta.strip()
    return resultado
