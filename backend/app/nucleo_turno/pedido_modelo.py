"""Port parcial de core/src/client_common.rs: Prompt e detalhes de imagem.

Derivado do projeto aberto, licença Apache-2.0; veja LICENCA e AVISOS.
"""
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any


@dataclass
class PedidoModelo:
    entrada: list[dict[str, Any]] = field(default_factory=list)
    ferramentas: list[dict[str, Any]] = field(default_factory=list)
    ferramentas_paralelas: bool = False
    instrucoes_base: str = ''
    esquema_saida: Any = None
    esquema_estrito: bool = True
    cache_ttl: Any = None
    programa_acesso: Any = None

    def entrada_formatada(self, *, responses_lite: bool = False,
                          suporta_imagem_original: bool = False,
                          detalhe_padrao: str = 'high') -> list[dict[str, Any]]:
        entrada = deepcopy(self.entrada)
        for item in entrada:
            tipo = item.get('type')
            if tipo == 'message':
                partes = item.get('content')
            elif tipo in ('function_call_output', 'custom_tool_call_output'):
                partes = item.get('output')
                if isinstance(partes, dict):
                    partes = partes.get('content')
            else:
                continue
            if not isinstance(partes, list):
                continue
            for parte in partes:
                if not isinstance(parte, dict) or parte.get('type') != 'input_image':
                    continue
                if responses_lite:
                    parte.pop('detail', None)
                elif parte.get('detail') == 'original' and not suporta_imagem_original:
                    parte['detail'] = detalhe_padrao
        return entrada
