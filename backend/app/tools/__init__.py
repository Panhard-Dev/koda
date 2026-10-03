"""Ferramentas locais do Koda: o catálogo e os handlers.

O laço do agente **não** mora mais aqui — ele é `app/agent/loop.py`. Este pacote é o
sistema de ferramentas: catálogo, schemas e despacho.
"""

from . import ferramentas

__all__ = ["ferramentas"]
