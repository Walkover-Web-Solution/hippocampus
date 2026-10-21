# Hippocampus Memory: what we built and how it is put together

Maintained beside the code in `src/memory`. [MEMORY.md](MEMORY.md) is the API reference; this file explains the design, so someone can change it with confidence.

## The one idea

Memory is a file system for what agents know. A **space** is a folder (`users/maya`, `teams/acme`, `product-truth`), a **note** is a file at a path in it, every write of a note is a new **version**, and every version is **indexed** three ways automatically: by meaning (embeddings), by exact words (a tsvector), and by the names and links in it (a graph). Agents never choose a storage; they ask one of four questions (what is in this folder, open this, what is similar, what is connected) and write with three verbs (write, edit, learn). Access comes from a token the product signs; Hippocampus never decides what is remembered or who sees it.

Why this shape and not "a vector store with an extraction prompt" (mem0, supermemory): extraction is one writer among several. Products also need a note six agents edit in place, documents beside facts, reading the past, and grants the product controls. Those need files, versions and folders. The vector index is then one index over the files, not the system.

## Where it lives

```
src/memory/
  config.ts        environment -> settings; memoryEnabled() = MEMORY_DATABASE_URL is set
  types.ts         the shapes: Tenant, NoteRow, VersionRow, SearchHit, EntityNode, extraction types, Models, Embedder
  paths.ts         space and path names, grant patterns ("folder/*"), generated paths, slugs
  text.ts          normalisation of names, slots, labels, relations; names found by shape (#channel, @handle, domain); query terms
  chunker.ts       body -> chunks (paragraph, then sentence, ~800 chars, 100 overlap); first sentence as summary
  migrations.ts    the schema, applied in order and recorded in memory_migrations
  db.ts            pg Pool, query/one/withTransaction, Params (placeholder builder), migrateMemory
  auth.ts          Grants, token verification (signers from env or table), memoryAuth middleware, token signing
  usage.ts         per-call metering through AsyncLocalStorage; models and the embedder add tokens to it
  embedder.ts      Embedder over the shared Encoder (EmbeddingGemma in the FastEmbed sidecar, or OpenAI); FakeEmbedder for tests
  llm.ts           the chat model: extract, link, reconcile, distillLesson, summarize; FakeModels for tests
  prompt.ts        the "What you remember" block: rules, notes with dates, connections, lessons, within budget
  store/
    fragments.ts   SQL shared by the stores: which version is current (now or as_of), which notes are in use
    spaces.ts      ensure/find/list/resolve spaces from grants; delete a space
    notes.ts       writeNote (versions, slots, if_version), applyEdits, openNote, listNotes (index + folders), history,
                   confirm, archive, delete by path/source/entity, document rows, pruneEntities
    indexer.ts     the job after every version: chunks, embeddings, summary, names, entities, links; reindex helpers
    search.ts      hybrid search over chunks, rules per slot, recall() = everything an assistant needs before answering
    graph.ts       known names, matches, neighbours, links, entity node, entity listing
    learn.ts       remember (merge), learn (extraction -> notes), learnFromFeedback (lessons)
  service.ts       the verbs as functions over (auth, input): validation, space resolution, index-after-write
  present.ts       the JSON shapes replies and tools share
  tools.ts         the verbs as tool definitions (zod); served as MCP tools and as function definitions
  mcp.ts           stateless MCP server over streamable HTTP, one per request, scoped to the token
  routes.ts        the Express router under /memory; admin.ts the operator routes behind the master key
  queue.ts         jobs for the consumer (index, reindex, document, learn); loaded lazily, inline fallback
  consumer.ts      the RabbitMQ consumer that runs those jobs
  server.ts        a standalone HTTP server serving only /memory (no Mongo, Qdrant, Redis or RabbitMQ)
  cli.ts           memory:migrate, memory:reindex
  eval/            golden cases for the extraction prompts (needs a model key)
  __tests__/       unit tests (no database) and an integration test (needs MEMORY_TEST_DATABASE_URL)
```

The RAG side of Hippocampus (`/collection`, `/resource`, `/search`, Mongo + Qdrant) is untouched. Memory reuses its `Encoder` (embedding models), its `DocumentLoader` (web pages, PDFs, Google Docs, YouTube), its logger, error handler and master-key middleware, and its RabbitMQ consumer scaffolding.

## Data model

```
memory_signers      who may sign tokens: issuer -> secret (also from MEMORY_SIGNERS)
memory_spaces       (issuer, org_id, project_id, name)            one folder of one tenant
memory_notes        (space_id, path) unique; kind, slot, labels, status, valid_from/to, source, written_by,
                    confidence, evidence_count, current_version_id
memory_note_versions (note_id, version) append-only; title, summary, body, names[], written_by, change, indexed_at
memory_documents    the original of a long note loaded from a url: url, status, error, bytes
--- derived, rebuilt from the versions ---
memory_chunks       (version_id, ordinal) text, embedding vector(N), search_text tsvector
memory_entities     (space_id, name) type                       a node of the graph
memory_note_entities (version_id, entity_id)                      which names a version mentions
memory_entity_links (version_id, subject, relation, object)       a link a version states
--- metering ---
memory_usage        one row per call: tenant, caller, verb, tokens
```

Three decisions behind it:

- **Source of truth and indexes are separate tables.** Notes and versions are what the product owns; chunks, entities and links are derived from a version's body and can be dropped and rebuilt (`POST /memory/admin/reindex`, `npm run memory:reindex`). Changing the embedding model is a reindex, not a migration.
- **Everything hangs off a version.** Chunks, names and links belong to the version they were read from. That is what makes `as_of` work: the version current at a moment carries the index that was true then. Old versions keep their chunks, so storage grows with history; a pruning job for non-current chunks is the obvious future addition.
- **Tenant is (issuer, org, project).** Two products can both have an org "1" without ever seeing each other, because the signer is part of the key. Every store query filters by space ids resolved from the token's grants, never by anything in the request body.

Folders are implicit: a path such as `drafts/launch-email` sits in the folder `drafts`, and `index` lists the next level of folders under a prefix, like `ls`. There is no folder table and no per-folder permission; grants are per space, with `folder/*` wildcards on space names. A product that wants finer permissions names finer spaces (`teams/acme/decisions`).

Rules are notes with `kind: rule` and a `slot`; they live at `rules/<slot>`, so "one live rule per slot" is "one note per path", and a partial unique index guards the slot across other paths too.

## The write path

```
PUT/POST/PATCH /memory/notes, POST /memory/learn, POST /memory/documents
  -> memoryAuth: verify token, resolve tenant + grants, open a usage context
  -> service: validate names and body, resolve the space (403 if not granted; created on first write)
  -> store/notes.writeNote, in one transaction:
       lock the note row (if any); check if_version; archive another note holding the same slot;
       insert the note if new; insert version N+1; move current_version_id; update metadata
  -> indexAfterWrite:
       short body: store/indexer.indexVersion inline (embed chunks, summary, names, entities, links)
       long body: publish an "index" job; the consumer runs the same function
       broker down: inline; inline failure: queued; both failing: "failed" in the reply
```

`remember` adds a merge step before the write: search the space for the nearest notes of the same kind; an exact repeat (distance <= 0.05) confirms without a model call; otherwise the model decides duplicate / replaces / new. `learn` runs the extraction prompt over the conversation with the space's rules, related facts and known names, then applies each operation through `remember`, a new version of the referenced note, or an archive.

## The read path

`search` (and `recall`, which `search` uses when `prompt` is not false):

1. Embed the query once. Find which of its words are names the graph knows; fetch their neighbours and links.
2. One SQL query over `memory_chunks` joined to the version that is current (now or at `as_of`) and to notes in use in the resolved spaces: the 300 nearest chunks by cosine distance, each scored as `(1 - distance) + 0.15·min(names shared, 3) + 0.08·min(neighbours shared, 2) + min(keyword rank, 0.2) + 0.03·min(confirmations - 1, 5)`; the best chunk per note; a distance cut-off with a small margin for chunks that share a name or a word.
3. Rules: every rule in use, then one per slot by space precedence (the order of `spaces` in the request, or the grant order).
4. Lessons: a second small search over `kind: lesson`.
5. The prompt block: header, rules, notes with path and date, connections, lessons, trimmed to about 4000 characters by dropping the least valuable lines first.

`entity` reads the graph for one name: notes whose current version names it or links it, the links in and out, and the neighbours counted by links. `index` and `open` are plain reads with the same "current version" and "in use" rules.

## Access and metering

A token is an HS256 JWT. `verifyMemoryToken` reads `iss`, finds the signer's secret (environment first, then `memory_signers`, cached a minute), verifies, and builds `Grants` from `spaces`. `Grants.accessTo(space)` picks the most specific matching pattern (exact beats `folder/*` beats `*`). The middleware leaves the result in `res.locals.memoryAuth` and, when the response finishes, writes one `memory_usage` row with the model tokens the call used (counted in an AsyncLocalStorage store by the embedder and the chat model).

Operator routes (`/memory/admin/*`) use the server's existing master key: migrate, signers, mint a token, reindex, usage.

## Models

Two model interfaces, both swappable in one place:

- `Embedder`: wraps the shared `Encoder`, so any dense model it knows works. The default is `google/embeddinggemma-300m` (768 dimensions), Google's open multilingual model, run as ONNX on CPU by the FastEmbed sidecar (`fastembed/main.py`, `EMBEDDING_SERVER`), so embedding costs nothing per token and no memory text leaves the machine; OpenAI's models remain available with `OPENAI_API_KEY_EMBEDDING`. Chunks are embedded as documents and queries as queries: EmbeddingGemma was trained with the prefixes `task: search result | query: ` and `title: none | text: `, which the sidecar adds (without them related and unrelated memories overlap in distance). `MEMORY_EMBEDDING_DIMENSIONS` must match the model (checked against the model's known size on first use); the vector column is created with it. The distance cut-off (`MEMORY_MAX_DISTANCE`) follows the model: 0.72 for EmbeddingGemma, 0.8 for OpenAI, from measurements in `config.ts`.
- Why EmbeddingGemma 300M and not EmbeddingGemma 2 (October 2026): on text the two are equal (MTEB multilingual 61.15 vs 61.36; English 69.67 vs 68.46); EmbeddingGemma 2 adds images, audio, video, an 8K context and better code retrieval, none of which memory notes need, and it has no ONNX build yet, so it would need PyTorch instead of the sidecar. The `kind` plumbing is model-independent; when fastembed ships it, adding it is one entry in `Encoder` and `EMBEDDING_DEFAULTS` plus a reindex.
- `Models`: the chat model behind extraction, linking, merge decisions, lessons and summaries, each a strict-JSON call with a schema, each answer re-checked before use. Prompts are in `llm.ts`; `npm run memory:eval` runs golden cases against them.
- Hand-written prompts are how every extraction-based memory service works, not a quirk: mem0 ships a fact-extraction prompt and an ADD/UPDATE/DELETE/NONE update prompt (our one extract call covers both, plus rules vs facts, slots, shared routing, expiry, injection defenses and secrets), and supermemory and past.dev run the same shape behind their APIs; Letta's agent-edits-its-own-memory paradigm is served here by the write and edit verbs, extraction being one writer among several. The learn call's optional `instructions` is the mem0 `custom_instructions` parity knob: the product steers relevance ("only save billing and order information"), fenced as data in the prompt, while the never-save list and who may set rules stay enforced. Two providers share the prompts and schemas, chosen by the model name: OpenAI (chat completions with a strict `json_schema`; `temperature: 0` on the non-reasoning models, nothing on gpt-5 and later) and Anthropic (messages with a `json_schema` output format at `MEMORY_EXTRACTION_EFFORT`, low by default). Enum values are lower-cased before checking because Anthropic does not guarantee their casing.
- Which extraction model: the default is `claude-haiku-5-5` with `gpt-4.1-mini` behind it, chosen on the eval (18/18 twice each; `gpt-5.4-nano` failed the same two cases both runs, missing a recorded request and normalising "acme inc" instead of "acme", so it is out). Haiku costs $0.10/$0.50 per million tokens against gpt-4.1-mini's $0.40/$1.60 and is a 2026 model; it is a little slower per call (about 0.4s vs 0.3s), which is fine since learn runs inside the request only for short bodies. The two are different providers, so the fallback also survives one provider's outage. Re-score with `npm run memory:eval` before changing it; `gpt-5.4-mini` ($0.75/$4.50) is the next step up if quality ever needs it. Decision models that only pick from fixed answers (TypeSafe's Jev) fit one call, `reconcile`, not the ones that write text.

`MEMORY_FAKE_MODELS=true` swaps both for deterministic fakes (word-hash embeddings, no extraction) so the integration test and a laptop need no keys.

## Processes and deployment

| Process | Runs | Needs |
| --- | --- | --- |
| `api-server` (existing) | everything, with `/memory` mounted | Mongo, Qdrant, Redis, RabbitMQ, plus Postgres for memory |
| `memory:server` (new) | only `/memory` | Postgres with pgvector, model keys; RabbitMQ optional |
| `memory-consumer` (new) | index, document, learn and reindex jobs | Postgres, RabbitMQ, model keys |

Postgres 14+ with pgvector 0.5+ (for HNSW). The schema is applied at start (`MEMORY_AUTO_MIGRATE`) or by `npm run memory:migrate`.

## What is deliberately not here (yet)

- Arbitrary metadata filters (only `labels`, up to 10 tags). A `metadata jsonb` column is the natural addition.
- Export and import of a space (as Markdown or JSON). Worth adding before selling it, so nobody is locked in.
- Client SDKs and webhooks. HTTP, MCP and function definitions are the interfaces today.
- Consolidation or decay jobs, reranking with the ColBERT sidecar, pruning of non-current chunks.
- A public benchmark number (LongMemEval or BEAM). The eval covers the prompts, not recall quality end to end.
- User management, dashboards, approval flows: the product's side by design.

## Testing

- `npm test -- src/memory`: grants and tokens, names and paths, chunking, edits, the prompt block.
- `MEMORY_TEST_DATABASE_URL=... npm test -- integration`: write, edit, if_version, index, open, history, grants, search with rules precedence and connections, entity and graph, remember with merge, as_of, forgetting by note, name, source and space, on a real Postgres with fake models.
- `npm run memory:eval`: the extraction, merge and lesson prompts against the real model.
- A smoke script (mount the router without a database) checks auth, tools, MCP initialize and tools/list, and validation order.

## Running it on a developer machine (Windows, no admin rights)

What was done on 20 Oct 2026 and can be repeated anywhere:

1. PostgreSQL: the portable zip from EDB (`postgresql-17.7-1-windows-x64-binaries.zip`, no installer), extracted to `D:	ools\pgsql\pgsql`.
2. pgvector: cloned `pgvector/pgvector` at `v0.8.1` and built it with the Visual Studio 2022 Build Tools (`vcvarsall.bat x64`, then `nmake /F Makefile.win` and `nmake /F Makefile.win install` with `PGROOT` set to the extracted folder). The EDB zip does not bundle pgvector.
3. A cluster owned by the current user: `initdb -D D:	ools\pgsql\data -U postgres -A trust`, started with `pg_ctl ... -o "-p 5432" start`; databases `hippocampus` and `hippocampus_test`. `D:	ools\pgsql\postgres.cmd start|stop|status|psql` wraps this; it is not a service, so start it again after a reboot.
4. `.env` in the repo (gitignored): `MEMORY_DATABASE_URL=postgres://postgres@localhost:5432/hippocampus`, `MEMORY_TEST_DATABASE_URL=...hippocampus_test`, `MEMORY_SIGNERS`, `MASTER_API_KEY`, the OpenAI keys.
5. `npm run memory:migrate`, then `npm run memory:server` (port 4478, only `/memory`), `MEMORY_TEST_DATABASE_URL=... npm test -- integration`, `npm run memory:eval`.

Docker Desktop and WSL both need administrator rights and a reboot, which is why the portable build was used.

## Change log

- 2026-10-20: first version: schema, six verbs, MCP, consumer, admin, docs, tests. Memory moved here from viaSocket's backend, which now only mints tokens and calls `/memory/search`, `/memory/learn` and `/memory/feedback`.
- 2026-10-20: standalone `memory:server`; the queue and Redis are loaded lazily so a memory-only process needs neither. Verified end to end on a local PostgreSQL 17.7 + pgvector 0.8.1 (integration suite 5/5) and with the real models: the HTTP run (22/22: write, learn into personal and shared spaces, search with the prompt block, graph, merge, edit, as_of, feedback, usage), the prompt eval (18/18 on gpt-4.1-mini), and the viaSocket side against a local backend (embed token to memory token, direct writes, grant refusals, chat with recall, feedback).
- 2026-10-20: extraction prompt: memories about the user start with the verb, never with "User"; unexpected errors on the memory routes answer 500 with a plain message instead of the provider's text.
- 2026-10-21: `learn` takes optional `instructions`, the product's own view of what is worth keeping (mem0 `custom_instructions` parity), fenced as data in the extraction prompt; relevance only, the guardrails hold. Threaded like `user_name` (service, queue job, LearnInput, ExtractionContext); two golden cases guard it.
- 2026-10-21: `MEMORY_EXTRACTION_FALLBACK_MODEL` answers when the first extraction model throws; `migrateMemory` checks the vector column's size against the configured model and, with `MEMORY_EMBEDDING_REINDEX=true`, resizes it and re-indexes (otherwise the mismatch is logged as an error and writes fail); the Docker image bakes EmbeddingGemma and bge-small into `fastembed/models`.
- 2026-10-21: the extraction model can be a Claude model: `ChatModels` (was `OpenAiModels`) routes by model name to an OpenAI or an Anthropic provider behind one JSON interface; the eval runs whichever model is configured and prints its time. On the eval the default moved to `claude-haiku-5-5` with `gpt-4.1-mini` as the cross-provider fallback (both 18/18 twice; a quarter of the cost).
- 2026-10-21: embeddings move to Google's EmbeddingGemma 300M in the FastEmbed sidecar (fastembed 0.9, Python 3.10+, so the Docker image is now bookworm). The Encoder and Embedder take a `kind` (query or document) and the sidecar adds the model's prefixes; the distance cut-off follows the model. Existing deployments on text-embedding-3-small keep working by setting the model and 1536 dimensions explicitly; switching means `POST /memory/admin/reindex`.
