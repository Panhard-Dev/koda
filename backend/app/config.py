"""Configuração do backend.

Tudo tem valor padrão, então `uv run uvicorn app.main:app` funciona sem `.env` nenhum:
o provider local responde e o banco nasce em `data/koda.db`.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .identidade import NOME
from .projects import area_de_trabalho

ProviderName = Literal["auto", "local", "host"]


def _provider_padrao() -> ProviderName:
    # O launcher marca apenas o processo filho. Configuracao explicita (inclusive
    # no .env) continua vencendo.
    #
    # **Só existem estes três**: o serviço de modelos oficial (o `c-host.exe`), o `local` que
    # responde offline quando ele não está no ar, e o `auto` que escolhe entre os dois. Não há
    # provider de terceiro — nem chave de outro programa escolhe o provider daqui. Antes havia
    # um caminho OpenAI-compatible, e era ele que fazia o seletor oferecer modelos da casa para
    # um serviço que não os tem (F05 do relatório de QA).
    return "host" if os.environ.get("KODA_BACKEND_PACKAGED") == "1" else "auto"


def _skills_do_koda() -> Path | None:
    """A pasta `skills/` que viaja com o Koda, achada pelo lugar onde este arquivo está.

    Este arquivo mora em `<koda>/backend/app/`, então a pasta é `../../skills` — a mesma
    conta em dev (`koda/skills`) e no instalado (`<instalação>/resources/skills`), sem
    variável de ambiente e sem depender de onde o processo foi aberto. É o mesmo raciocínio
    do `achar_backend` do lançador, que acha o backend ao lado dos recursos.
    """
    pasta = Path(__file__).resolve().parent.parent.parent / "skills"
    return pasta if pasta.is_dir() else None


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
    skills_dir: Path | None = Field(default_factory=_skills_do_koda)
    """A pasta `skills/` que **vem com o Koda** — ao lado do backend, no projeto ou no
    instalado.

    O instalador traz `skills/` como recurso, e o backend mora em
    `<koda>/backend/app/`, então a pasta é sempre `../../skills` a partir daqui: a mesma
    conta vale em dev (`koda/skills`) e no instalado (`<instalação>/resources/skills`), sem
    variável de ambiente e sem depender de onde o processo foi aberto.

    Sem isto o app instalado nasceria sem skill nenhuma: `.agents/skills` do projeto e
    `~/.agents/skills` são pastas de quem desenvolve, e não existem na máquina de quem só
    instalou. `None` quando a pasta não existe (é o caso de um checkout sem as skills).
    """
    tools_deny: str = ""
    acesso_livre: bool = False
    """Libera as ferramentas de arquivo para mexer fora da pasta de trabalho.

    Desligado (padrão), `read_file`, `write_file`, `edit_file`, `list_dir`,
    `delete_file` e os linters só enxergam o que está dentro do workspace. É a
    proteção contra o modelo ser convencido por uma página lida na web a mexer em
    algo do sistema. O `shell`/`terminal` continua podendo tudo — é o que ele é.
    """
    max_steps: int = 0
    """Teto de passos do modelo por tarefa. **0 = sem teto**, como o projeto de origem.

    Ele não tem teto de turno por padrão, e a razão é conhecida: teto
    fixo trunca tarefa grande no meio, em silêncio. Este número já foi 12 e depois 100, e
    100 não é "tarefa grande": montar um projeto, refatorar um módulo ou rodar uma bateria
    de testes passa disso no meio de trabalho legítimo. Quem impede um loop sem fim é o
    botão de parar, o teto de tempo da tarefa (`tool_timeout_s`) e o contador de respostas
    vazias do loop — não a contagem de passos.
    """
    tool_timeout_s: int = 0
    """Orçamento de tempo da tarefa inteira, em segundos (0 = **sem limite**).

    Era 1800 s (meia hora), e uma tarefa grande de verdade estoura isso: o agente fechava
    com "o tempo da tarefa acabou antes de terminar" no meio do trabalho. O dono foi
    explícito: a tarefa vai até acabar, não importa o tamanho. O que impede um loop sem fim
    é o botão de parar, o contador de respostas vazias e o de provedor fora do ar.
    """
    # --- Tetos de saída das ferramentas (os mesmos do projeto de origem) --------------
    # A referência de comportamento do Koda é esse projeto, e estes são os números dele:
    # `tools/tool_output_limits.py` publica max_bytes 50_000, max_lines 2_000 e
    # max_line_length 2_000, e `tools/file_tools.py` usa file_read_max_chars 100_000. O
    # Koda teve números próprios (4 000 / 12 000 / 800) enquanto as ideias ainda estavam
    # sendo portadas; agora são os mesmos, e continuam ajustáveis por aqui.
    tool_output_limit: int = 50_000
    """Quanto da saída de cada ferramenta fica na tela e no histórico."""
    tool_output_max_bytes: int = 50_000
    """Teto da saída que uma ferramenta devolve ao modelo."""
    tool_output_max_lines: int = 2_000
    """Teto de linhas de uma listagem ou busca."""
    tool_output_max_line_length: int = 2_000
    """Teto de **uma** linha na leitura de arquivo."""
    file_read_max_chars: int = 100_000
    """Teto de leitura de um arquivo ou anexo por vez (`file_read_max_chars`)."""

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

    max_tool_calls: int = 0
    """Teto de chamadas de ferramenta por tarefa. **0 = sem teto**, como o projeto de origem.

    Mesma razão do `max_steps`: tarefa grande faz dezenas de chamadas legítimas, e parar no
    meio por contagem é o modelo ficando sem como terminar o que começou. Configure um valor
    positivo só quando quiser um teto explícito numa instalação.
    """
    tool_call_timeout_s: int = 120
    """Tempo máximo de uma chamada de ferramenta, em segundos (0 = sem teto explícito).

    Comandos longos do terminal devolvem uma olhada após este prazo e continuam sob o
    lifecycle próprio do processo; subprocessos de execução direta são encerrados no prazo.
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

    host_modelos_com_visao: str = Field(
        default="liz-4,liz-3-flash,koda-1,layze-2",
        validation_alias=AliasChoices("KODA_HOST_VISAO", "HOST_VISAO"),
    )
    """Ids do host que **enxergam imagem**, separados por vírgula — lista **curada**.

    O host publica `images` por modelo em `/v1/models`, mas **não dá para confiar nele**: o
    `liz-nano` é anunciado com `images: true` e o upstream por trás responde 400 («model
    "mai-experimental" not supported for vision»), porque o modelo real por trás do id varia
    conforme o pool do host. Mandar imagem para quem o host diz que enxerga, mas o upstream
    não, derruba o pedido inteiro. Por isso a lista é medida e editada à mão: modelo fora
    dela recebe o anexo pelos metadados, em vez de o pedido falhar.

    Ajustável por `KODA_HOST_VISAO`.
    """

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

    def aceita_imagem(self, model: str) -> bool:
        """O modelo enxerga imagem? Decide se o anexo de imagem vai **no corpo** do pedido.

        Compara pelo id do catálogo do host (`liz-4`). Um id vazio cai no modelo padrão do
        host, que é o que o provider vai usar de verdade.
        """
        alvo = model or self.host_model
        return alvo in {item.strip() for item in self.host_modelos_com_visao.split(",") if item.strip()}

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
