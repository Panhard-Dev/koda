"""Cliente de conversa Kiro e leitura incremental do Amazon EventStream."""

from __future__ import annotations

import json
import re
import struct
import uuid
import zlib
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .providers.base import ProviderError, TransientProviderError


MAX_EVENTO = 8 * 1024 * 1024
MAX_FERRAMENTAS = 2 * 1024 * 1024


def _cabecalhos_binarios(bruto: bytes) -> dict[str, Any]:
    campos: dict[str, Any] = {}
    pos = 0
    while pos < len(bruto):
        tamanho = bruto[pos]
        pos += 1
        if pos + tamanho + 1 > len(bruto):
            raise ProviderError("cabeçalho EventStream incompleto")
        try:
            nome = bruto[pos:pos + tamanho].decode("utf-8")
        except UnicodeDecodeError as erro:
            raise ProviderError("nome de cabeçalho EventStream inválido") from erro
        pos += tamanho
        tipo = bruto[pos]
        pos += 1
        if tipo in (0, 1):
            valor: Any = tipo == 0
        elif tipo in (2, 3, 4, 5, 8, 9):
            largura = {2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16}[tipo]
            if pos + largura > len(bruto):
                raise ProviderError("valor EventStream incompleto")
            valor = bruto[pos:pos + largura]
            pos += largura
        elif tipo in (6, 7):
            if pos + 2 > len(bruto):
                raise ProviderError("comprimento EventStream incompleto")
            largura = int.from_bytes(bruto[pos:pos + 2], "big")
            pos += 2
            if pos + largura > len(bruto):
                raise ProviderError("valor EventStream incompleto")
            valor = bruto[pos:pos + largura]
            pos += largura
            if tipo == 7:
                try:
                    valor = valor.decode("utf-8")
                except UnicodeDecodeError as erro:
                    raise ProviderError("texto de cabeçalho EventStream inválido") from erro
        else:
            raise ProviderError(f"tipo de cabeçalho EventStream desconhecido: {tipo}")
        if nome in campos:
            raise ProviderError("cabeçalho EventStream duplicado")
        campos[nome] = valor
    return campos


class LeitorEventStream:
    """Decodifica quadros divididos entre pacotes e verifica os dois CRC32."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    def receber(self, bloco: bytes) -> list[tuple[dict[str, Any], Any]]:
        self._buffer.extend(bloco)
        saida = []
        while len(self._buffer) >= 12:
            tamanho, cabecalhos, crc_preludio = struct.unpack(">III", self._buffer[:12])
            if tamanho < 16 or tamanho > MAX_EVENTO or cabecalhos > tamanho - 16:
                raise ProviderError("tamanho EventStream inválido")
            if zlib.crc32(self._buffer[:8]) & 0xFFFFFFFF != crc_preludio:
                raise ProviderError("preâmbulo EventStream corrompido")
            if len(self._buffer) < tamanho:
                break
            quadro = bytes(self._buffer[:tamanho])
            del self._buffer[:tamanho]
            if zlib.crc32(quadro[:-4]) & 0xFFFFFFFF != int.from_bytes(quadro[-4:], "big"):
                raise ProviderError("mensagem EventStream corrompida")
            headers = _cabecalhos_binarios(quadro[12:12 + cabecalhos])
            conteudo = quadro[12 + cabecalhos:-4]
            try:
                dados = json.loads(conteudo) if conteudo else {}
            except (ValueError, UnicodeDecodeError) as erro:
                raise ProviderError("evento Kiro não contém JSON válido") from erro
            saida.append((headers, dados))
        return saida

    def terminar(self) -> None:
        if self._buffer:
            raise ProviderError("Kiro interrompeu um evento binário no meio")


class SeparadorPensamento:
    """Separa tags de pensamento mesmo quando chegam divididas entre eventos."""

    def __init__(self) -> None:
        self._buffer = ""
        self.pensando = False

    def receber(self, texto: str, *, final: bool = False) -> list[tuple[bool, str]]:
        self._buffer += texto
        partes: list[tuple[bool, str]] = []
        while self._buffer:
            tag = "</thinking>" if self.pensando else "<thinking>"
            pos = self._buffer.find(tag)
            if pos >= 0:
                if pos:
                    partes.append((self.pensando, self._buffer[:pos]))
                self._buffer = self._buffer[pos + len(tag):]
                self.pensando = not self.pensando
                continue
            fim = len(self._buffer) if final else max(0, len(self._buffer) - len(tag) + 1)
            if fim:
                partes.append((self.pensando, self._buffer[:fim]))
                self._buffer = self._buffer[fim:]
            break
        return partes


def _texto(conteudo: Any) -> str:
    if isinstance(conteudo, str):
        return conteudo
    if isinstance(conteudo, list):
        return "\n".join(str(item.get("text") or "") for item in conteudo if isinstance(item, dict) and item.get("text"))
    return "" if conteudo is None else str(conteudo)


def _esquema(objeto: Any) -> Any:
    if isinstance(objeto, list):
        return [_esquema(valor) for valor in objeto]
    if isinstance(objeto, dict):
        return {chave: _esquema(valor) for chave, valor in objeto.items()
                if chave != "additionalProperties" and not (chave == "required" and valor == [])}
    return objeto


def _ferramentas(ferramentas: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, str]]:
    specs, nomes, retorno = [], {}, {}
    for item in ferramentas:
        funcao = item.get("function") or item
        original = str(funcao.get("name") or "").strip()
        if not original or original in nomes:
            continue
        nome = re.sub(r"[^a-zA-Z0-9_-]", "_", original)[:64] or "ferramenta"
        base = nome
        numero = 1
        while nome in retorno:
            sufixo = f"_{numero}"
            nome = base[:64 - len(sufixo)] + sufixo
            numero += 1
        nomes[original] = nome
        retorno[nome] = original
        schema = _esquema(funcao.get("parameters") or {"type": "object", "properties": {}})
        if not isinstance(schema, dict):
            schema = {}
        schema["type"] = "object"
        if not isinstance(schema.get("properties"), dict):
            schema["properties"] = {}
        if isinstance(schema.get("required"), list):
            schema["required"] = list(dict.fromkeys(chave for chave in schema["required"]
                                                    if isinstance(chave, str) and chave in schema["properties"]))
            if not schema["required"]:
                del schema["required"]
        specs.append({"toolSpecification": {"name": nome,
                      "description": str(funcao.get("description") or f"Ferramenta {original}")[:10000],
                      "inputSchema": {"json": schema}}})
    return specs, nomes, retorno


def _modelo(modelo: str) -> str:
    nome = re.sub(r"-(thinking|agentic)$", "", modelo, flags=re.IGNORECASE)
    nome = re.sub(r"-(thinking|agentic)$", "", nome, flags=re.IGNORECASE)
    return nome


def _corpo(modelo: str, mensagens: list[dict[str, Any]], ferramentas: list[dict[str, Any]],
           conta: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    specs, nomes, retorno = _ferramentas(ferramentas)
    modelo = _modelo(modelo)
    turnos: list[dict[str, Any]] = []

    def usuario() -> dict[str, Any]:
        if not turnos or "userInputMessage" not in turnos[-1]:
            turnos.append({"userInputMessage": {"content": "", "modelId": modelo, "origin": "AI_EDITOR"}})
        return turnos[-1]["userInputMessage"]

    for item in mensagens:
        role = item.get("role")
        if role in {"system", "developer", "user", "tool"}:
            alvo = usuario()
            if role == "tool":
                tool_id = str(item.get("tool_call_id") or "")
                if not tool_id:
                    raise ProviderError("resultado de ferramenta sem identificação")
                contexto = alvo.setdefault("userInputMessageContext", {})
                contexto.setdefault("toolResults", []).append({
                    "toolUseId": tool_id, "status": "error" if item.get("is_error") or item.get("status") == "error" else "success",
                    "content": [{"text": _texto(item.get("content"))}],
                })
            else:
                texto = _texto(item.get("content"))
                if texto:
                    if role in {"system", "developer"}:
                        texto = f"<instructions>\n{texto}\n</instructions>"
                    alvo["content"] = "\n\n".join(v for v in (alvo["content"], texto) if v)
                if isinstance(item.get("content"), list):
                    for bloco in item["content"]:
                        if not isinstance(bloco, dict) or bloco.get("type") != "image_url":
                            continue
                        imagem = bloco.get("image_url") or {}
                        url = imagem.get("url") if isinstance(imagem, dict) else imagem
                        achado = re.fullmatch(r"data:image/(png|jpeg|gif|webp);base64,([a-zA-Z0-9+/=]+)", str(url or ""))
                        if achado:
                            alvo.setdefault("images", []).append({"format": achado.group(1), "source": {"bytes": achado.group(2)}})
                        elif str(url or "").startswith("data:"):
                            raise ProviderError("formato de imagem não aceito pelo Kiro")
                        elif url:
                            alvo["content"] += f"\n[Imagem: {url}]"
        elif role == "assistant":
            if not turnos:
                usuario()["content"] = "Continue."
            if "assistantResponseMessage" not in turnos[-1]:
                turnos.append({"assistantResponseMessage": {"content": ""}})
            alvo = turnos[-1]["assistantResponseMessage"]
            texto = _texto(item.get("content"))
            if texto:
                alvo["content"] = "\n\n".join(v for v in (alvo["content"], texto) if v)
            for chamada in item.get("tool_calls") or []:
                funcao = chamada.get("function") or {}
                try:
                    entrada = json.loads(funcao.get("arguments") or "{}")
                except (TypeError, ValueError) as erro:
                    raise ProviderError("argumentos inválidos no histórico de ferramenta") from erro
                if not isinstance(entrada, dict):
                    raise ProviderError("argumentos de ferramenta precisam ser um objeto")
                original = str(funcao.get("name") or "")
                alvo.setdefault("toolUses", []).append({"toolUseId": str(chamada.get("id") or ""),
                                                          "name": nomes.get(original, original), "input": entrada})
    if not turnos or "userInputMessage" not in turnos[-1]:
        raise ProviderError("o Kiro precisa de uma mensagem ou resultado de ferramenta ao final")
    for turno in turnos:
        if "userInputMessage" in turno:
            usuario_atual = turno["userInputMessage"]
            if not usuario_atual["content"]:
                usuario_atual["content"] = "Continue com os resultados das ferramentas."
        elif not turno["assistantResponseMessage"]["content"]:
            turno["assistantResponseMessage"]["content"] = "..."
    atual = turnos.pop()["userInputMessage"]
    if specs:
        atual.setdefault("userInputMessageContext", {})["tools"] = specs
    corpo: dict[str, Any] = {"conversationState": {"chatTriggerType": "MANUAL", "conversationId": str(uuid.uuid4()),
                               "currentMessage": {"userInputMessage": atual}, "history": turnos},
                             "inferenceConfig": {"maxTokens": 32000}}
    arn = (conta.get("specific") or {}).get("profileArn")
    if arn:
        corpo["profileArn"] = arn
    return corpo, retorno


def _endpoints(conta: dict[str, Any]) -> list[str]:
    especificos = conta.get("specific") or {}
    regiao = str(especificos.get("region") or "us-east-1")
    if not re.fullmatch(r"[a-z0-9-]+", regiao):
        raise ProviderError("região da conta Kiro inválida")
    return [f"https://q.{regiao}.amazonaws.com/generateAssistantResponse",
            f"https://codewhisperer.{regiao}.amazonaws.com/generateAssistantResponse",
            "https://runtime.us-east-1.kiro.dev/generateAssistantResponse"]


def _headers(conta: dict[str, Any], url: str) -> dict[str, str]:
    especificos = conta.get("specific") or {}
    token = str(especificos.get("apiKey") or conta.get("access") or "")
    cabecalhos = {"authorization": f"Bearer {token}", "x-amz-sso-bearer": token,
                  "content-type": "application/json", "accept": "application/vnd.amazon.eventstream",
                  "user-agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0", "x-amz-user-agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
                  "amz-sdk-request": "attempt=1; max=3", "amz-sdk-invocation-id": str(uuid.uuid4()),
                  "x-amzn-kiro-agent-mode": "spec", "x-amzn-codewhisperer-machine-id": "kiro-desktop"}
    metodo = especificos.get("authMethod")
    if metodo == "api_key":
        cabecalhos["TokenType"] = "API_KEY"
    elif metodo == "external_idp":
        cabecalhos["TokenType"] = "EXTERNAL_IDP"
    if especificos.get("profileArn"):
        cabecalhos["x-amzn-codewhisperer-profile-arn"] = str(especificos["profileArn"])
    if "//codewhisperer." in url:
        cabecalhos["x-amz-target"] = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
    return cabecalhos


def _sse(delta: dict[str, Any] | None = None, *, motivo: str | None = None, usage: dict[str, int] | None = None) -> str:
    evento: dict[str, Any] = {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": motivo}]}
    if usage:
        evento["usage"] = usage
    return "data: " + json.dumps(evento, ensure_ascii=False)


async def linhas(conta: dict[str, Any], modelo: str, mensagens: list[dict[str, Any]],
                 ferramentas: list[dict[str, Any]], ao_limite: Any = None) -> AsyncIterator[str]:
    corpo, nomes = _corpo(modelo, mensagens, ferramentas, conta)
    urls = _endpoints(conta)
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=20.0)) as cliente:
        for indice, url in enumerate(urls):
            emitiu = False
            try:
                async with cliente.stream("POST", url, headers=_headers(conta, url), json=corpo) as resposta:
                    if resposta.status_code in {401, 403, 404, 500, 502, 503, 504} and indice + 1 < len(urls):
                        await resposta.aread()
                        continue
                    if resposta.status_code == 429:
                        if ao_limite:
                            ate = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
                            ao_limite(conta, ate, "limite de uso atingido")
                        raise TransientProviderError("a conta Kiro está sem cota agora")
                    if resposta.status_code >= 400:
                        detalhe = (await resposta.aread()).decode("utf-8", "replace")
                        raise ProviderError(f"Kiro respondeu HTTP {resposta.status_code}: {detalhe[:300]}")
                    leitor = LeitorEventStream()
                    separador = SeparadorPensamento()
                    chamadas: dict[str, dict[str, Any]] = {}
                    uso: dict[str, int] = {}
                    motivo = ""
                    teve_saida = False
                    async for bloco in resposta.aiter_bytes():
                        for headers, dados in leitor.receber(bloco):
                            if headers.get(":message-type") in {"error", "exception"}:
                                detalhe = dados.get("message") if isinstance(dados, dict) else "erro do serviço"
                                raise ProviderError(f"Kiro interrompeu a resposta: {detalhe}")
                            tipo = headers.get(":event-type")
                            if not isinstance(dados, dict) and not (tipo == "toolUseEvent" and isinstance(dados, list)):
                                continue
                            if tipo in {"assistantResponseEvent", "codeEvent", "reasoningContentEvent"}:
                                conteudo = dados.get("reasoningContentEvent") if tipo == "reasoningContentEvent" else dados
                                texto = (conteudo.get("text") or conteudo.get("content") or "") if isinstance(conteudo, dict) else str(conteudo or "")
                                if texto:
                                    teve_saida = True
                                    if tipo == "assistantResponseEvent":
                                        for pensamento, parte in separador.receber(str(texto)):
                                            emitiu = True
                                            yield _sse({"reasoning_content" if pensamento else "content": parte})
                                    else:
                                        emitiu = True
                                        yield _sse({"reasoning_content" if tipo == "reasoningContentEvent" else "content": texto})
                            elif tipo == "toolUseEvent":
                                valores = dados.get("toolUseEvent") or dados if isinstance(dados, dict) else dados
                                valores = valores if isinstance(valores, list) else [valores]
                                for item in valores:
                                    if not isinstance(item, dict) or not item.get("name"):
                                        raise ProviderError("Kiro devolveu ferramenta sem nome")
                                    id_chamada = str(item.get("toolUseId") or "")
                                    if not id_chamada:
                                        raise ProviderError("Kiro devolveu ferramenta sem identificação")
                                    parcial = chamadas.setdefault(id_chamada, {"name": str(item["name"]), "input": None})
                                    if parcial["name"] != item["name"]:
                                        raise ProviderError("o nome da ferramenta Kiro mudou durante a resposta")
                                    entrada = item.get("input")
                                    anterior = parcial["input"]
                                    if isinstance(entrada, str) and (anterior is None or isinstance(anterior, str)):
                                        parcial["input"] = (anterior or "") + entrada
                                    elif isinstance(entrada, dict) and (anterior is None or isinstance(anterior, dict)):
                                        parcial["input"] = entrada
                                    elif entrada is not None:
                                        raise ProviderError("o formato dos argumentos Kiro mudou durante a resposta")
                                    if len(json.dumps(parcial["input"])) > MAX_FERRAMENTAS:
                                        raise ProviderError("argumentos de ferramenta Kiro grandes demais")
                            elif tipo in {"messageStopEvent", "metadataEvent", "MetadataEvent"}:
                                meta = dados.get("metadataEvent") or dados.get("metadata") or dados
                                if isinstance(meta, dict):
                                    motivo = str(meta.get("stopReason") or meta.get("stop_reason") or motivo)
                            elif tipo == "metricsEvent":
                                meta = dados.get("metricsEvent") or dados
                                uso = {"prompt_tokens": int(meta.get("inputTokens") or 0),
                                       "completion_tokens": int(meta.get("outputTokens") or 0)}
                    leitor.terminar()
                    for pensamento, parte in separador.receber("", final=True):
                        emitiu = True
                        yield _sse({"reasoning_content" if pensamento else "content": parte})
                    motivo_normal = re.sub(r"(?<!^)(?=[A-Z])", "_", motivo).lower().replace("-", "_")
                    if (motivo_normal in {"refusal", "cancelled", "pause_turn", "malformed_model_output", "invalid_model_output"}
                            or any(palavra in motivo_normal for palavra in ("content_filter", "guardrail", "safety", "policy", "blocked"))):
                        raise ProviderError(f"Kiro não concluiu a resposta: {motivo_normal}")
                    if motivo_normal in {"tool_use", "tool_calls"} and not chamadas:
                        raise ProviderError("Kiro pediu uma ferramenta sem enviar a chamada")
                    for posicao, (identificador, parcial) in enumerate(chamadas.items()):
                        try:
                            entrada = json.loads(parcial["input"]) if isinstance(parcial["input"], str) else parcial["input"]
                        except ValueError as erro:
                            raise ProviderError("Kiro devolveu argumentos de ferramenta incompletos") from erro
                        if not isinstance(entrada, dict):
                            raise ProviderError("Kiro devolveu argumentos de ferramenta inválidos")
                        teve_saida = True
                        emitiu = True
                        yield _sse({"tool_calls": [{"index": posicao, "id": identificador, "type": "function",
                                     "function": {"name": nomes.get(parcial["name"], parcial["name"]),
                                                  "arguments": json.dumps(entrada, ensure_ascii=False)}}]})
                    if not teve_saida:
                        raise ProviderError("Kiro encerrou a resposta sem conteúdo")
                    final = ("length" if separador.pensando or motivo_normal in {"max_tokens", "max_output_tokens", "model_context_window_exceeded"}
                             else "tool_calls" if chamadas else "stop")
                    yield _sse(motivo=final, usage=uso)
                    yield "data: [DONE]"
                    return
            except httpx.RequestError as erro:
                if emitiu or indice + 1 >= len(urls):
                    raise TransientProviderError(f"não consegui falar com o Kiro: {erro}") from erro
        raise ProviderError("nenhum dos endereços do Kiro aceitou a conta")
