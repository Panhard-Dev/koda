"""O envelope COSY do Qoder — a assinatura que o cliente dele manda em cada pedido.

Portado do plugin `@magpie-community/opencode-qoder-auth` (0.2.42), que é o que o magpie usa
por baixo. Sem isto, o Qoder recusa tudo que não venha do app dele: o pedido vai assinado com
uma chave AES por requisição, embrulhada na chave RSA pública que o cliente carrega, e o corpo
vai codificado num alfabeto embaralhado.

Três peças:

1. **`user_blob`** — a conta (uid, nome, e-mail, token) em AES-128-CBC, com a chave servindo de
   IV, e essa chave embrulhada em RSA (PKCS#1) com a chave pública do Qoder.
2. **`assinatura`** — `md5(payload + chave + ts + corpo + caminho)`, onde `payload` é o JSON
   com o blob em base64. Vai no `Authorization: Bearer COSY.<payload>.<sig>`.
3. **`codificar_corpo` / `decodificar_corpo`** — o "base64" do cliente (alfabeto próprio, `$`
   de padding) com os terços trocados. O `Encode=1` da URL é isso.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import uuid
from typing import Any

from cryptography.hazmat.primitives import padding as sym_padding
from cryptography.hazmat.primitives.asymmetric import padding as rsa_padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.serialization import load_pem_public_key

#: A chave pública que o cliente do Qoder carrega (1024 bits). Ela embrulha a chave AES de
#: cada requisição — não é segredo, está dentro do app.
RSA_KEY = """-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----"""

#: A versão que o envelope declara. Precisa ser a que o app desktop fala.
COSY_VERSION = "1.1.69"

#: O alfabeto do "base64" do cliente, com `$` no lugar do `=`.
ALFABETO = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"


# ------------------------------------------------------------------ corpo


def _segmentar(dados: bytes) -> str:
    saida = ""
    acumulado = 0
    bits = 0
    for byte in dados:
        acumulado = ((acumulado << 8) | byte) & 0xFFFFFF
        bits += 8
        while bits >= 6:
            bits -= 6
            saida += ALFABETO[(acumulado >> bits) & 63]
    if bits > 0:
        saida += ALFABETO[(acumulado << (6 - bits)) & 63]
    while len(saida) % 4:
        saida += "$"
    return saida


def _trocar_tercos(texto: str) -> str:
    """Troca o primeiro e o último terço — a mesma involução para codificar e decodificar."""
    t = len(texto) // 3
    if not t:
        return texto
    return texto[-t:] + texto[t:len(texto) - t] + texto[:t]


def codificar_corpo(texto: str) -> str:
    return _trocar_tercos(_segmentar(texto.encode("utf-8")))


def decodificar_corpo(conteudo: str) -> str:
    s = _trocar_tercos(conteudo)
    saida = bytearray()
    for inicio in range(0, len(s) - 3, 4):
        valores = [ALFABETO.index(c) for c in s[inicio:inicio + 4] if c != "$"]
        if not valores:
            continue
        acumulado = 0
        for valor in valores:
            acumulado = acumulado * 64 + valor
        quantidade = (6 * len(valores)) // 8
        for k in range(quantidade):
            saida.append((acumulado >> (6 * len(valores) - 8 * (k + 1))) & 255)
    return bytes(saida).decode("utf-8", "replace")


# --------------------------------------------------------------- envelope


def _user_blob(conta: dict[str, Any]) -> tuple[str, str]:
    """A conta cifrada e a chave embrulhada, em base64."""
    bruto = json.dumps(
        {
            "uid": conta["uid"],
            "aid": "",
            "name": conta.get("name") or "",
            "email": conta.get("email") or "",
            "security_oauth_token": conta["access"],
        },
        separators=(",", ":"),
    ).encode("utf-8")
    chave = secrets.token_hex(8).encode("ascii")  # 16 bytes, hex
    cifrador = Cipher(algorithms.AES(chave), modes.CBC(chave)).encryptor()
    preenchedor = sym_padding.PKCS7(128).padder()
    cifrado = cifrador.update(preenchedor.update(bruto) + preenchedor.finalize()) + cifrador.finalize()
    publica = load_pem_public_key(RSA_KEY.encode("ascii"))
    embrulhada = publica.encrypt(chave, rsa_padding.PKCS1v15())
    return base64.b64encode(cifrado).decode(), base64.b64encode(embrulhada).decode()


def cabecalhos(
    url: str,
    conta: dict[str, Any],
    corpo: str,
    *,
    chat: bool = False,
    modelo: dict[str, str] | None = None,
    ts: int | None = None,
) -> dict[str, str]:
    """Os cabeçalhos assinados de um pedido ao Qoder.

    `chat=True` monta o conjunto do `agent_chat_generation` (sem `Cosy-ClientIp`, com o nome da
    máquina e o `X-Model-*`); o resto usa o conjunto do `prepareRequest`.
    """
    import time
    from urllib.parse import urlparse

    if not conta.get("machineId"):
        raise RuntimeError("a conta do Qoder não tem machine id — entre de novo")
    quando = ts if ts is not None else int(time.time())
    info, chave = _user_blob(conta)
    payload = base64.b64encode(
        json.dumps(
            {
                "version": "v1",
                "requestId": str(uuid.uuid4()),
                "info": info,
                "cosyVersion": COSY_VERSION,
                "ideVersion": "",
            },
            separators=(",", ":"),
        ).encode("utf-8")
    ).decode()

    caminho = urlparse(url).path
    if caminho.startswith("/algo"):
        caminho = caminho[5:]
    assinatura = hashlib.md5(
        f"{payload}\n{chave}\n{quando}\n{corpo}\n{caminho}".encode("utf-8")
    ).hexdigest()

    maquina = str(conta["machineId"])
    cabecalhos = {
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
        "Authorization": f"Bearer COSY.{payload}.{assinatura}",
        "Cosy-Business-Product": "app",
        "Cosy-Business-Type": "agent",
        "Cosy-ClientIp": maquina,
        "Cosy-ClientType": "10",
        "Cosy-Data-Policy": "disagree",
        "Cosy-Date": str(quando),
        "Cosy-Key": chave,
        "Cosy-MachineId": maquina,
        "Cosy-MachineToken": maquina,
        "Cosy-MachineType": "5",
        "Cosy-MachineOS": "x86_64_win32",
        "Cosy-Scene": "app",
        "Cosy-User": str(conta["uid"]),
        "Cosy-Version": COSY_VERSION,
        "Login-Version": "v2",
    }
    if chat:
        for nome in ("Cosy-ClientIp", "Cosy-MachineToken", "Cosy-MachineType"):
            cabecalhos.pop(nome, None)
        import socket

        nome_da_maquina = socket.gethostname()
        if nome_da_maquina:
            cabecalhos["Cosy-MachineHostname"] = nome_da_maquina[:96]
        cabecalhos["Accept"] = "text/event-stream"
        cabecalhos["Cache-Control"] = "no-cache"
        if modelo:
            cabecalhos["X-Model-Key"] = str(modelo.get("key") or "")
            cabecalhos["X-Model-Source"] = str(modelo.get("source") or "")
    return cabecalhos
