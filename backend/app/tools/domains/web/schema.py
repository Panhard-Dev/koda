"""Schema das ferramentas de web.

Cada ferramenta declara **aqui** o próprio nome, a descrição e os argumentos (`_def`). O
registro (`tools/registry.py`) junta os schemas dos domínios — ele não guarda lista própria.
É o que faz a ferramenta nova entrar no domínio dela em vez de engordar um arquivo central.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def("web_search", "Pesquisa no Bing e devolve vários resultados. Use isto para descobrir na web; para ler uma página já conhecida use `url_reader`. Em pesquisa ampla, use consultas diferentes para achar fontes em mais domínios.", {"consulta": {"type": "string"}}, ["consulta"]),
    _def("url_reader", "Baixa uma URL pública (http/https) conhecida e devolve o texto da página. Use isto para abrir uma página específica; para descobrir na web use `web_search`.", {"url": {"type": "string"}}, ["url"]),
    _def("browser", "Alias de url_reader: abre uma URL e devolve o texto.", {"url": {"type": "string"}}, ["url"]),
    _def(
        "download_file",
        "Baixa uma URL http(s) para um arquivo dentro da pasta de trabalho.",
        {"url": {"type": "string"}, "destino": {"type": "string"}},
        ["url", "destino"],
    ),
    _def(
        "upload_file",
        "Envia um arquivo da pasta de trabalho para uma URL http(s) (PUT).",
        {"caminho": {"type": "string"}, "url": {"type": "string"}},
        ["caminho", "url"],
    ),
]
