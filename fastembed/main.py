# main.py
# The embedding sidecar: a small FastAPI service that runs FastEmbed (ONNX) models on CPU for the Node server.
# Dense models answer /embed, sparse models /sparse-embed, ColBERT-style models /late-interaction-embed.
import os
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional
from fastembed import TextEmbedding, SparseTextEmbedding, LateInteractionTextEmbedding
from functools import lru_cache

app = FastAPI()

DEFAULT_DENSE = "BAAI/bge-small-en-v1.5"

# Some models embed a query and a document differently and lose much of their accuracy without the prefix they
# were trained with. The caller says what a text is (`kind`); the prefix is added here so no client has to know it.
# Only models with no data indexed before this table existed are listed: adding a model here changes its vectors,
# which needs everything embedded with it to be re-indexed.
PREFIXES = {
    # https://ai.google.dev/gemma/docs/embeddinggemma/model_card
    "google/embeddinggemma-300m": {
        "query": "task: search result | query: ",
        "document": "title: none | text: ",
    },
    "nomic-ai/nomic-embed-text-v1.5": {
        "query": "search_query: ",
        "document": "search_document: ",
    },
}

# Models loaded at start so the first request is not the one that downloads them. Comma separated; the memory
# service's model should be in it.
PRELOAD_DENSE = [m.strip() for m in os.environ.get("EMBEDDING_PRELOAD", f"{DEFAULT_DENSE},google/embeddinggemma-300m").split(",") if m.strip()]
PRELOAD_SPARSE = [m.strip() for m in os.environ.get("EMBEDDING_PRELOAD_SPARSE", "prithivida/Splade_PP_en_v1").split(",") if m.strip()]
PRELOAD_LATE = [m.strip() for m in os.environ.get("EMBEDDING_PRELOAD_LATE", "colbert-ir/colbertv2.0").split(",") if m.strip()]


class TextPayload(BaseModel):
    texts: List[str]
    model: Optional[str] = DEFAULT_DENSE
    # "query" or "document"; left out, texts are embedded as given (no prefix).
    kind: Optional[str] = None

class SparsePayload(BaseModel):
    texts: List[str]
    model: Optional[str] = "prithivida/Splade_PP_en_v1"

class LateInteractionPayload(BaseModel):
    texts: List[str]
    model: Optional[str] = "colbert-ir/colbertv2.0"


# Models stay loaded between requests; the cache size bounds memory (EmbeddingGemma alone is about 1.2 GB).
@lru_cache(maxsize=3)
def get_embedding_model(model_name: str) -> TextEmbedding:
    return TextEmbedding(model_name=model_name)

@lru_cache(maxsize=1)
def get_sparse_embedding_model(model_name: str) -> SparseTextEmbedding:
    return SparseTextEmbedding(model_name=model_name)

@lru_cache(maxsize=1)
def get_late_interaction_embedding_model(model_name: str) -> LateInteractionTextEmbedding:
    return LateInteractionTextEmbedding(model_name=model_name)


def with_prefix(model: str, kind: Optional[str], texts: List[str]) -> List[str]:
    prefix = PREFIXES.get(model, {}).get(kind or "")
    return [prefix + t for t in texts] if prefix else texts


for name in PRELOAD_DENSE:
    get_embedding_model(name)
for name in PRELOAD_SPARSE:
    get_sparse_embedding_model(name)
for name in PRELOAD_LATE:
    get_late_interaction_embedding_model(name)


@app.post("/embed")
def get_embeddings(payload: TextPayload):
    """Dense embeddings for a list of texts. `kind` ("query" | "document") selects the model's prefix, if it has one."""
    embed_model = get_embedding_model(payload.model)
    embeddings = list(embed_model.embed(with_prefix(payload.model, payload.kind, payload.texts)))
    return {"embeddings": [e.tolist() for e in embeddings]}

@app.post("/sparse-embed")
def get_sparse_embeddings(payload: SparsePayload):
    """Sparse embeddings (SPLADE, BM25) for a list of texts."""
    embed_model = get_sparse_embedding_model(payload.model)
    embeddings = list(embed_model.embed(payload.texts))
    return {"embeddings": [e.as_dict() for e in embeddings]}

@app.post("/late-interaction-embed")
def get_late_interaction_embeddings(payload: LateInteractionPayload):
    """ColBERT-style token embeddings for a list of texts."""
    embed_model = get_late_interaction_embedding_model(payload.model)
    embeddings = list(embed_model.embed(payload.texts))
    return {"embeddings": [e.tolist() for e in embeddings]}

@app.get("/")
def read_root():
    return {"message": "FastEmbed API is running.", "preloaded": PRELOAD_DENSE, "prefixed": sorted(PREFIXES)}

@app.get("/models")
def get_available_models():
    """Every model this FastEmbed version can run, with dimensions for the dense ones."""
    return {
        "dense": TextEmbedding.list_supported_models(),
        "sparse": SparseTextEmbedding.list_supported_models(),
        "rerank": LateInteractionTextEmbedding.list_supported_models(),
    }
