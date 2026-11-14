"""Port de truncate_middle_chars de utils/string/src/truncate.rs (Apache-2.0)."""


def limitar_saida(texto: str, max_bytes: int) -> str:
    if max_bytes < 0:
        raise ValueError('limite deve ser não negativo')
    dados = texto.encode('utf-8')
    if len(dados) <= max_bytes:
        return texto
    esquerda = max_bytes // 2
    direita = max_bytes - esquerda
    alvo_cauda = len(dados) - direita
    prefixo = []
    sufixo = []
    removidos = 0
    posicao = 0
    for caractere in texto:
        fim = posicao + len(caractere.encode('utf-8'))
        if fim <= esquerda:
            prefixo.append(caractere)
        elif posicao >= alvo_cauda:
            sufixo.append(caractere)
        else:
            removidos += 1
        posicao = fim
    return ''.join(prefixo) + f'…{removidos} chars truncated…' + ''.join(sufixo)


def limitar_tokens(texto: str, max_tokens: int) -> tuple[str, int | None]:
    """Port de truncate_middle_with_token_budget; tokens estimados por bytes."""
    if max_tokens < 0:
        raise ValueError('limite deve ser não negativo')
    dados = texto.encode('utf-8')
    max_bytes = max_tokens * 4
    if len(dados) <= max_bytes:
        return texto, None
    esquerda, direita = max_bytes // 2, max_bytes - max_bytes // 2
    prefixo = dados[:esquerda].decode('utf-8', errors='ignore')
    sufixo = dados[len(dados)-direita:].decode('utf-8', errors='ignore') if direita else ''
    removidos = (len(dados) - max_bytes + 3) // 4
    return f'{prefixo}…{removidos} tokens truncated…{sufixo}', (len(dados) + 3) // 4
