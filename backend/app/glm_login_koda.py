"""Login de dispositivo GLM e recuperação da chave do plano do usuário."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx


def _json(resposta: httpx.Response) -> Any:
    if resposta.status_code >= 400:
        raise RuntimeError(f"GLM recusou o pedido (HTTP {resposta.status_code})")
    dados = resposta.json()
    if not isinstance(dados, dict) or dados.get("success") is False or dados.get("code") not in (None, 0, 200, "0", "200"):
        raise RuntimeError("GLM devolveu um erro durante o login")
    return dados.get("data", dados)


def iniciar(cliente: httpx.Client, config: dict[str, Any], segredo: str) -> dict[str, Any]:
    dados = _json(cliente.post(config["device"], headers={"authorization": f"Bearer {segredo}"},
                               json={"provider": config["provider_id"]}))
    if not isinstance(dados, dict) or not dados.get("flow_id") or not dados.get("authorize_url"):
        raise RuntimeError("GLM não devolveu os dados necessários para entrar")
    return dados


def consultar(cliente: httpx.Client, config: dict[str, Any], segredo: str, flow_id: str) -> dict[str, Any]:
    dados = _json(cliente.get(f"{config['poll'].rstrip('/')}/{quote(flow_id, safe='')}",
                              headers={"authorization": f"Bearer {segredo}"}))
    if not isinstance(dados, dict):
        raise RuntimeError("GLM devolveu uma sessão inválida")
    return dados


def chave_do_plano(cliente: httpx.Client, config: dict[str, Any], token: str) -> tuple[str, str]:
    login = _json(cliente.post(config["business_login"], json={"token": token}))
    business = (login.get("access_token") or login.get("accessToken")) if isinstance(login, dict) else None
    if not business:
        raise RuntimeError("GLM não devolveu o token da conta")
    cabecalhos = {"authorization": f"Bearer {business}"}
    base = config["api"].rstrip("/")
    usuario = _json(cliente.get(base + "/api/biz/customer/getCustomerInfo", headers=cabecalhos))
    organizacoes = usuario.get("organizations", []) if isinstance(usuario, dict) else []
    elegiveis = []
    for org in organizacoes:
        if not isinstance(org, dict) or not org.get("organizationId"):
            continue
        projetos = [p for p in org.get("projects", []) if isinstance(p, dict) and p.get("projectId") and str(p.get("projectType", "")) != "2"]
        if projetos:
            elegiveis.append((org, projetos))
    if not elegiveis:
        raise RuntimeError("GLM não devolveu um projeto elegível para o plano")
    org, projetos = next((item for item in elegiveis if str(item[0].get("organizationName", "")).lower() == "default"), elegiveis[0])
    projeto = next((p for p in projetos if str(p.get("projectName", "")).lower() == "default"), projetos[0])
    url = f"{base}/api/biz/v1/organization/{quote(str(org['organizationId']), safe='')}/projects/{quote(str(projeto['projectId']), safe='')}/api_keys"
    chaves = _json(cliente.get(url, headers=cabecalhos))
    entrada = next((item for item in chaves if isinstance(item, dict) and item.get("name") == config["key_name"]), None) if isinstance(chaves, list) else None
    if not entrada:
        entrada = _json(cliente.post(url, headers=cabecalhos, json={"name": config["key_name"]}))
    chave = entrada.get("apiKey") if isinstance(entrada, dict) else None
    if not chave:
        raise RuntimeError("GLM não devolveu a chave do plano")
    resposta = _json(cliente.get(f"{url}/copy/{quote(str(chave), safe='')}", headers=cabecalhos))
    segredo = resposta.get("secretKey") if isinstance(resposta, dict) else None
    if not segredo:
        raise RuntimeError("GLM não devolveu o segredo da chave")
    return f"{chave}.{segredo}", str(business)
