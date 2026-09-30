"""Configuração do backend.

Tudo tem valor padrão, então `uv run uvicorn app.main:app` funciona sem `.env` nenhum:
o provider local responde e o banco nasce em `data/koda.db`.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .identidade import NOME
from .projects import area_de_trabalho

ProviderName = Literal["auto", "local", "openai", "host"]


def _provider_padrao() -> ProviderName:
    # O launcher marca apenas o processo filho. Configuracao explicita (inclusive
    # no .env) continua vencendo; OPENAI_* de outros apps nao escolhe o instalado.
    return "host" if os.environ.get("KODA_BACKEND_PACKAGED") == "1" else "auto"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env",),
        env_prefix="KODA_",
        extra="ignore",
        # Sem isto, campo com `validation_alias` só aceitaria o nome alternativo: o
        # construtor `Settings(cloud_url="...")` seria ignorado em silêncio e o valor
        # viria do ambiente. Os testes (e quem embute o Koda) passam pelo nome do campo.
        validate_by_name=True,
    )

    provider: ProviderName = Field(default_factory=_provider_padrao)
    database_path: Path = Path("data/koda.db")
    # `http://tauri.localhost` é a origem que o app desktop (Tauri/WebView2) usa
    # quando roda empacotado; no dev a interface vem do Vite, nas portas 5173.
    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://tauri.localhost,https://tauri.localhost"
    )
    local_stream_delay_ms: int = 18

    assistente: str = NOME
    """Nome com que o assistente se identifica nas respostas.

    O host injeta uma persona própria na conversa; este é o nome que o Koda manda valer
    (ver `identidade.py`) — e o mesmo que aparece na resposta padrão quando o modelo só
    sabia se apresentar.
    """
    # Ferramentas: o agente é o comportamento normal do Koda (área de código).
    tools: bool = True
    workspace: Path | None = None
    tools_deny: str = ""
    acesso_livre: bool = False
    """Libera as ferramentas de arquivo para mexer fora da pasta de trabalho.

    Desligado (padrão), `read_file`, `write_file`, `edit_file`, `list_dir`,
    `delete_file` e os linters só enxergam o que está dentro do workspace. É a
    proteção contra o modelo ser convencido por uma página lida na web a mexer em
    algo do sistema. O `shell`/`terminal` continua podendo tudo — é o que ele é.
    """
    max_steps: int = 0
    """Teto de passos de uma mensagem do agente. **0 = sem teto.**

    Era 12, e 12 não é "tarefa grande": montar um projeto, refatorar um módulo ou rodar uma
    bateria de testes passa disso no meio de trabalho legítimo — e o agente parava com a
    tarefa pela metade. Projeto gigante não cabe em número fixo de passos, então o padrão é
    não ter teto. Quem impede um loop sem fim é o tempo abaixo, o botão de parar e o
    contador de respostas vazias do loop.
    """
    tool_timeout_s: int = 0
    """Orçamento de tempo da tarefa inteira, em segundos (0 = **sem limite**).

    Era 1800 s (meia hora), e uma tarefa grande de verdade estoura isso: o agente fechava
    com "o tempo da tarefa acabou antes de terminar" no meio do trabalho. O dono foi
    explícito: a tarefa vai até acabar, não importa o tamanho. O que impede um loop sem fim
    é o botão de parar, o contador de respostas vazias e o de provedor fora do ar.
    """
    tool_output_limit: int = 4000

    # --- Tetos do `shell` (processo), separados de propósito -------------------------
    # Antes os três prazos estavam amarrados: `tempo_limite` limitava só cada **olhada**, o
    # travamento era "três olhadas" (doze minutos com o polling de 240 s) e não havia teto
    # absoluto de verdade. Aqui cada um é o seu.
    comando_timeout_s: int = 600
    """Teto **total** de um comando, em segundos (0 = sem teto).

    É o prazo do processo, e não muda por `continuar`: o backend é a autoridade do
    lifecycle. Passou dele, o comando é morto e o resultado volta.
    """
    comando_inatividade_s: int = 300
    """Quanto tempo **sem escrever nada** já caracteriza travamento, em segundos.

    Medido em segundos, não em olhadas: comando vivo mas mudo por cinco minutos está
    esperando entrada, em laço mudo, ou morto por dentro. Antes eram "três olhadas", o que
    com polling de 240 s dava doze minutos.
    """
    comando_olhada_s: int = 240
    """De quanto em quanto tempo um comando longo devolve a palavra ao modelo."""

    max_tool_calls: int = 400
    """Teto de **chamadas de ferramenta** numa tarefa (0 = sem teto).

    Rede de segurança contra o modelo em laço: `max_steps` é 0 por decisão do projeto
    (tarefa grande não cabe em número fixo de passos), mas uma tarefa que chama quatrocentas
    ferramentas já não está progredindo — está girando.
    """
    contexto_tokens: int = 1_000_000
    """Quanto a conversa pode ocupar, em tokens, antes de ser compactada em resumo.

    O agente reenvia o histórico inteiro a cada passo. Num projeto grande isso vira o
    problema principal: cada saída de ferramenta entra na conta e, depois de dezenas de
    passos, o pedido passa do que o provedor aceita — e a tarefa morre no meio. Ao chegar
    neste teto, o que já foi resolvido é resumido (ver `contexto.py`).

    O padrão é **1 milhão**, que é a janela que os modelos do serviço aceitam. O teto
    existe para o pedido não passar do que o provedor aguenta; compactar antes disso joga
    fora contexto que ainda cabia — era o defeito do padrão antigo, de 200 mil. **Zero**
    desliga a compactação: o histórico vai inteiro, como antes.
    """

    # Busca na web: só o Bing, raspando a página de resultados. Sem chave, sem serviço
    # no meio e sem plano B — se o Bing bloquear, a busca volta vazia.

    # Retentativas do agente quando quem falha é o provedor, não a tarefa.
    retry_attempts: int = 3
    """Última cartada: espera essa janela e tenta uma vez mais (0 desliga)."""
    retry_final_wait_s: int = 12

    # Chaves sem prefixo, como todo mundo espera encontrar no .env.
    openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENAI_API_KEY", "KODA_OPENAI_API_KEY"),
    )
    openai_base_url: str = Field(
        default="https://api.openai.com/v1",
        validation_alias=AliasChoices("OPENAI_BASE_URL", "KODA_OPENAI_BASE_URL"),
    )
    openai_model: str = Field(
        default="gpt-4o-mini",
        validation_alias=AliasChoices("OPENAI_MODEL", "KODA_OPENAI_MODEL"),
    )
    model_map: str = "{}"

    # Serviço de modelos oficial (Liz): é o host em `host/c-host.exe`, que publica o
    # catálogo em /v1/models e recebe a conversa em /v1/chat/completions.
    host_url: str = Field(
        default="http://127.0.0.1:21128/v1",
        validation_alias=AliasChoices("HOST_URL", "KODA_HOST_URL"),
    )
    host_model: str = Field(
        default="liz-4",
        validation_alias=AliasChoices("HOST_MODEL", "KODA_HOST_MODEL"),
    )
    """Modelo padrão do serviço, para id que ele não reconheça (ou vazio)."""

    host_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("HOST_KEY", "KODA_HOST_KEY"),
    )
    """Chave de cliente do host, para o build que exige uma.

    O `c-host.exe` com autorização remota recusa quem não manda chave: 401. O host aberto
    não olha o cabeçalho. Sem nada aqui o `Authorization` simplesmente não vai, então o
    padrão continua funcionando com o host aberto; com o host fechado, isto é o que faz o
    agente voltar a ter ferramentas em vez de cair no provider local.
    """

    # --- Nuvem (Koda Cloud) ---
    # O backend na nuvem é um extra: aviso de atualização, changelog e catálogo publicado.
    # O Koda funciona inteiro sem ele — toda falha da nuvem vira "indisponível" e a tela
    # segue como está. Vazio desliga.
    cloud_url: str = Field(
        default="https://koda-cloud-api.studiosluxgames.workers.dev",
        validation_alias=AliasChoices("KODA_CLOUD_URL", "KODA_BACKEND_URL"),
    )
    cloud_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices("KODA_CLOUD_TOKEN", "KODA_BACKEND_TOKEN"),
    )
    """Token do app na nuvem (opcional). Vai só no cabeçalho, nunca na URL nem no log."""
    cloud_timeout_s: float = Field(default=5.0, ge=0.5, le=30.0)
    cloud_canal: Literal["stable", "beta"] = "stable"
    cloud_versao: str = ""
    """Versão a comparar com a publicada. Vazio usa a versão deste backend."""
    cloud_download_hosts: str = ""
    """Domínios aceitos no link de download que a nuvem devolve (vazio = qualquer HTTPS)."""
    cloud_check_on_start: bool = False
    """Consulta a nuvem ao subir. Desligado por padrão: nada de saída de rede sem pedido."""
    download_dir: str = ""
    """Pasta onde o instalador baixado é salvo. Vazio usa a pasta de downloads do sistema."""

    @field_validator("cloud_url")
    @classmethod
    def _conferir_url_da_nuvem(cls, value: str) -> str:
        """Só HTTPS, sem credenciais embutidas e sem barra sobrando no fim.

        `http://` escapa apenas em endereço local (desenvolvimento); qualquer outro host é
        recusado na configuração, e não em tempo de requisição.
        """
        limpo = (value or "").strip().rstrip("/")
        if not limpo:
            return ""
        partes = urlsplit(limpo)
        if partes.scheme not in ("http", "https") or not partes.hostname:
            raise ValueError("KODA_CLOUD_URL precisa ser uma URL http(s) completa")
        if partes.username or partes.password:
            raise ValueError("KODA_CLOUD_URL não aceita usuário/senha no endereço")
        local = partes.hostname in ("localhost", "127.0.0.1", "::1")
        if partes.scheme != "https" and not local:
            raise ValueError("KODA_CLOUD_URL precisa ser HTTPS")
        return limpo

    @property
    def cloud_download_permitidos(self) -> list[str]:
        return [item.strip().lower() for item in self.cloud_download_hosts.split(",") if item.strip()]

    @property
    def origins(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def model_aliases(self) -> dict[str, str]:
        """Modelo da interface -> modelo do provedor (opcional)."""
        try:
            data = json.loads(self.model_map or "{}")
        except json.JSONDecodeError:
            return {}
        return {str(key): str(value) for key, value in data.items()} if isinstance(data, dict) else {}

    def resolve_model(self, model: str, padrao: str | None = None) -> str:
        """Modelo da interface (liz-nano, koda-1…) para o nome do provedor."""
        return self.model_aliases.get(model, padrao or self.openai_model)

    @property
    def workspace_path(self) -> Path:
        """Pasta onde as ferramentas trabalham.

        O padrão é a **Área de Trabalho** de quem está usando, em qualquer PC: é onde a
        pessoa vê o que o agente fez, sem precisar procurar. `KODA_WORKSPACE` manda mais
        que isso, e o projeto escolhido no prompt box manda mais que os dois.
        """
        if self.workspace:
            return Path(self.workspace).expanduser().resolve()
        return area_de_trabalho()

    @property
    def tools_negadas(self) -> set[str]:
        return {item.strip() for item in self.tools_deny.split(",") if item.strip()}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
