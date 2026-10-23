# main.py
# Import necessary libraries, similar to how you'd use `require` in Node.js
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Literal, Optional
from fastembed import TextEmbedding, SparseTextEmbedding, LateInteractionTextEmbedding
from functools import lru_cache

# Create an instance of the FastAPI app, like `const app = express();`
app = FastAPI()

InputType = Literal["query", "document"]

# Prompt templates for models that expect different prefixes for queries and documents.
# fastembed does not add these itself. Models that are not listed here are embedded as-is,
# so existing collections keep producing the same vectors.
PROMPT_TEMPLATES = {
    "google/embeddinggemma-300m": {
        "query": "task: search result | query: {text}",
        "document": "title: none | text: {text}",
    },
    "Qwen/Qwen3-Embedding-0.6B": {
        "query": "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{text}",
    },
    "Qwen/Qwen3-Embedding-0.6B-Q": {
        "query": "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{text}",
    },
}

def apply_prompt(texts: List[str], model_name: str, input_type: Optional[InputType]) -> List[str]:
    template = PROMPT_TEMPLATES.get(model_name, {}).get(input_type) if input_type else None
    if not template:
        return texts
    return [template.format(text=text) for text in texts]

# This is a Pydantic model. It's used for request body validation.
# Think of it like a schema definition with Joi or Zod.
class TextPayload(BaseModel):
    texts: List[str]
    model: Optional[str] = "BAAI/bge-small-en-v1.5"
    # Optional: "query" or "document". Only affects models listed in PROMPT_TEMPLATES.
    input_type: Optional[InputType] = None

class SparsePayload(BaseModel):
    texts: List[str]
    model: Optional[str] = "prithivida/Splade_PP_en_v1"

class LateInteractionPayload(BaseModel):
    texts: List[str]
    model: Optional[str] = "colbert-ir/colbertv2.0"

# Cache models to avoid reloading them on every request
@lru_cache(maxsize=2)
def get_embedding_model(model_name: str) -> TextEmbedding:
    # Limit ONNX runtime threads to 1 to reduce idle CPU usage
    return TextEmbedding(model_name=model_name)

@lru_cache(maxsize=1)
def get_sparse_embedding_model(model_name: str) -> SparseTextEmbedding:
    # Limit ONNX runtime threads to 1 to reduce idle CPU usage
    return SparseTextEmbedding(model_name=model_name)

@lru_cache(maxsize=1)
def get_late_interaction_embedding_model(model_name: str) -> LateInteractionTextEmbedding:
    # Limit ONNX runtime threads to 1 to reduce idle CPU usage
    return LateInteractionTextEmbedding(model_name=model_name)

# Initialize the default embedding model. This might take a moment the first time.
# It's like creating a service instance that you'll reuse.
get_embedding_model("BAAI/bge-small-en-v1.5")
get_sparse_embedding_model("prithivida/Splade_PP_en_v1")
get_late_interaction_embedding_model("colbert-ir/colbertv2.0")


# Define a POST endpoint. This is like `app.post('/embed', (req, res) => { ... });`
@app.post("/embed")
def get_embeddings(payload: TextPayload):
    """
    Takes a list of texts and returns their embeddings.
    """
    # The request body is automatically parsed and validated into the `payload` object.
    # If the request body doesn't match the `TextPayload` model, FastAPI returns a 422 error.
    
    # Generate embeddings for the texts in the payload.
    embed_model = get_embedding_model(payload.model)
    texts = apply_prompt(payload.texts, payload.model, payload.input_type)
    embeddings = list(embed_model.embed(texts))
    
    # The list of embeddings is automatically converted to a JSON response.
    # FastAPI handles the `res.json()` part for you.
    return {"embeddings": [e.tolist() for e in embeddings]}

@app.post("/sparse-embed")
def get_sparse_embeddings(payload: SparsePayload):
    """
    Takes a list of texts and returns their sparse embeddings.
    """
    # Generate sparse embeddings for the texts in the payload.
    embed_model = get_sparse_embedding_model(payload.model)
    embeddings = list(embed_model.embed(payload.texts))
    
    # The list of sparse embeddings is automatically converted to a JSON response.
    return {"embeddings": [e.as_dict() for e in embeddings]}

@app.post("/late-interaction-embed")
def get_late_interaction_embeddings(payload: LateInteractionPayload):
    """
    Takes a list of texts and returns their ColBERT embeddings.
    """
    # Generate ColBERT embeddings for the texts in the payload.
    embed_model = get_late_interaction_embedding_model(payload.model)
    embeddings = list(embed_model.embed(payload.texts))
    
    # The list of ColBERT embeddings is automatically converted to a JSON response.
    return {"embeddings": [e.tolist() for e in embeddings]}

# Add a root endpoint for health checks, like a simple `app.get('/', ...)`
@app.get("/")
def read_root():
    return {"message": "FastEmbed API is running."}

@app.get("/models")
def get_available_models():
    """
    Returns a list of available models for each category.
    """
    return {
        "dense": TextEmbedding.list_supported_models(),
        "sparse": SparseTextEmbedding.list_supported_models(),
        "rerank": LateInteractionTextEmbedding.list_supported_models(),
    }