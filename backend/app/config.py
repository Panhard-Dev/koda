"""Configuração do backend.

Tudo tem valor padrão, então `uv run uvicorn app.main:app` funciona sem `.env` nenhum:
o provider local responde e o banco nasce em `data/koda.db`.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .identidade import NOME

ProviderName = Literal["auto", "local", "openai", "gemini"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env",),
        env_prefix="KODA_",
        extra="ignore",
    )

    provider: ProviderName = "auto"
    database_path: Path = Path("data/koda.db")
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
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
    max_steps: int = 12
    """Orçamento de tempo de uma tarefa do agente, em segundos (0 = sem limite)."""
    tool_timeout_s: int = 120
    tool_output_limit: int = 4000

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

    # Serviço de modelos: publica o catálogo em /v1/models e recebe a conversa em
    # /v1/chat/completions.
    gemini_proxy_url: str = Field(
        default="http://127.0.0.1:21128/v1",
        validation_alias=AliasChoices("GEMINI_PROXY_URL", "KODA_GEMINI_PROXY_URL"),
    )
    gemini_model: str = Field(
        default="liz-nano",
        validation_alias=AliasChoices("GEMINI_MODEL", "KODA_GEMINI_MODEL"),
    )
    """Perfil usado no serviço, quando ele trabalha com mais de um; vazio deixa ele escolher."""
    gemini_profile: str | None = None
    """Onde o serviço publica os perfis disponíveis — de onde sai a troca de perfil."""
    gemini_web_url: str = Field(
        default="http://127.0.0.1:21128",
        validation_alias=AliasChoices("GEMINI_WEB_URL", "KODA_GEMINI_WEB_URL"),
    )

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
        """Pasta onde as ferramentas trabalham (padrão: a raiz do projeto)."""
        if self.workspace:
            return Path(self.workspace).expanduser().resolve()
        return Path(__file__).resolve().parents[2]

    @property
    def tools_negadas(self) -> set[str]:
        return {item.strip() for item in self.tools_deny.split(",") if item.strip()}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
