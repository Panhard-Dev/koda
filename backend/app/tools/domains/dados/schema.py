"""Ferramentas de dados reais: clima, câmbio, imagens com licença e memória durável.

Todas devolvem **dado**, não opinião: o modelo recebe números e URLs verificáveis e pode
desenhar a interface com eles. As três de rede usam serviços públicos sem chave
(Open-Meteo, Frankfurter e Openverse) e host fixo — não aceitam URL arbitrária.
"""

from __future__ import annotations

from ....contracts.tools import _def

DEFINICOES = [
    _def(
        "clima",
        "Previsão do tempo real (Open-Meteo, sem chave). Informe `cidade` ou `lat`/`lon`. "
        "Devolve temperatura, sensação, umidade, vento, chuva e previsão diária. Use os "
        "números retornados em KodaMetric/KodaTable/KodaChart; não invente clima.",
        {
            "cidade": {"type": "string", "description": "ex.: São Paulo, Recife, Lisboa"},
            "lat": {"type": "number", "description": "latitude, se não houver cidade"},
            "lon": {"type": "number", "description": "longitude, se não houver cidade"},
            "dias": {"type": "integer", "description": "1 a 7 dias de previsão (padrão 5)"},
        },
        [],
    ),
    _def(
        "cotacao",
        "Câmbio de referência do Banco Central Europeu via Frankfurter (sem chave). "
        "Converte `valor` de `moeda` para `alvo` e devolve a taxa do dia e a data. "
        "Moedas em código ISO de 3 letras (USD, BRL, EUR, GBP, JPY…).",
        {
            "moeda": {"type": "string", "description": "moeda de origem (padrão USD)"},
            "alvo": {"type": "string", "description": "moeda de destino (padrão BRL)"},
            "valor": {"type": "number", "description": "quanto converter (padrão 1)"},
        },
        [],
    ),
    _def(
        "buscar_imagens",
        "Busca imagens com licença aberta no Openverse e devolve título, autor, licença, "
        "URL da imagem e página de origem. Use as URLs em KodaImage com `alt` e crédito. "
        "Não baixa nem hospeda a imagem.",
        {
            "consulta": {"type": "string", "description": "o que procurar"},
            "quantidade": {"type": "integer", "description": "1 a 10 resultados (padrão 6)"},
        },
        ["consulta"],
    ),
    _def(
        "memoria",
        "Memória durável e local do Koda (arquivo `data/memoria.json`, nunca sai da máquina). "
        "`salvar` grava/atualiza uma chave, `listar` devolve tudo, `buscar` filtra por termo "
        "e `excluir` remove pelo id. Use para preferências e fatos que a pessoa pediu para "
        "lembrar; não guarde segredo, senha nem token.",
        {
            "acao": {
                "type": "string",
                "description": "salvar | listar | buscar | excluir",
            },
            "chave": {"type": "string", "description": "nome curto do fato (salvar)"},
            "valor": {"type": "string", "description": "o fato em si (salvar)"},
            "id": {"type": "string", "description": "id do item (excluir)"},
            "termo": {"type": "string", "description": "texto a procurar (buscar)"},
        },
        ["acao"],
    ),
]
