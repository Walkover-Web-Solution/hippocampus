# Team memory POC

Experiments for a memory service that stores personal and team memory consistently and correctly.
Several storage approaches run through the same chat-session datasets and are scored the same way.
This folder is fenced off from hippocampus: the root build, Docker image and `npm test` ignore it,
and each approach keeps its dependencies in its own `package.json`.

## Setup

```bash
docker compose -f docker-compose.memory.yml up -d   # Postgres+pgvector :5433, Neo4j :7688 (browser :7475)
npm run memory:install                              # per-approach dependencies
# .env: see the MEMORY_* block in .env.example
#   MEMORY_LLM_PROVIDER=gemini + GEMINI_API_KEY (or openai + OPENAI_API_KEY)
#   OPENROUTER_API_KEY for the Jev variants
npm run memory:check                                # verify provider + Jev before a run
```

## Commands

| Command | What it does |
|---|---|
| `npm run memory:check` | Check the LLM provider (chat, structured output, embeddings) and Jev |
| `npm run memory:typecheck` | Type-check the POC |
| `npm run memory:test` | Unit tests (no Docker, no network) |
| `npm run memory:test:integration` | Store/graph/approach wiring against Docker with fake OpenAI/Jev. **Resets the databases — don't run during an eval.** |
| `npm run memory:eval -- --approach=naive,claims-pg+gate+router,temporal-kg+vecmatch` | Run the evaluation, write `memory-eval-reports/<time>/report.md` (rewritten after each approach) |
| `npm run memory:compare -- <report dir> [more dirs] [--only=failures] [--category=<name>]` | Line up reports question by question: who passed, why others failed, per-category totals |

`memory:eval` flags: `--set=dev|heldout|all` (default dev), `--ingest=exchange|notes`, `--only=scenarios|datasets`,
`--scenario=<ids>`, `--repeat=N`, `--topK=N`, `--parallel` (one process per store; temporal-kg variants share Neo4j
and run in turn), `--offline` (hash embeddings, no answerer/judge, naive only).

Speed: Gemini calls take 3–6 s and runs are sequential per approach. `--parallel` plus
`MEMORY_LLM_REASONING_EFFORT=low` (applied to every approach) makes dev iterations several times faster;
keep the model default for final comparisons.

## Team deployment

The MCP server runs as the pm2 app `memory-mcp` in the hippocampus image (port 7800, one instance). For the team:

1. A Neo4j 5 instance for it alone (e.g. `neo4j:5.26-community` with a volume). Postgres isn't needed for temporal-kg.
2. A persistent volume at `/app/.memory-data`. It holds `mcp/world.json` (the roster: people, teams, memberships;
   copied from `mcp/world.example.json` on first start, re-read on every request) and the request log.
3. Environment: `MEMORY_LLM_PROVIDER`, `GEMINI_API_KEY`, `MEMORY_REMOTE_EMBED_URL`, `OPENROUTER_API_KEY` (Jev gate),
   `MEMORY_MCP_NEO4J_URL`, `MEMORY_NEO4J_USER`, `MEMORY_NEO4J_PASSWORD`, `MEMORY_MCP_HOST=0.0.0.0`,
   `MEMORY_MCP_PUBLIC_URL`, `MEMORY_MCP_VERSIONS=<the one version>`, `MEMORY_MCP_TOKENS=<person-id>:<token>,...`
   and `MEMORY_MCP_UI=false` (see `.env.example`).
4. Route port 7800 (HTTPS in front); `GET /health` for checks.

`MEMORY_MCP_ALIASES=engram:<version>` gives the version a short name in URLs (`/mcp/engram`); memories stay stored
under the version itself.

An admin (role `admin` in `world.json`) adds a teammate and gets their token with
`curl -X POST <public url>/admin/people -H "Authorization: Bearer <admin token>" -H "content-type: application/json" -d '{"name":"Priya Sharma","email":"priya@company.com","aliases":["Priya"]}'`.
The person joins the default team (or `"team": "<id>"`); the response holds their token and the command they run:
`claude mcp add --transport http memory "<public url>/mcp/engram" --header "Authorization: Bearer <their token>"`.
Calling it again with the same email issues a new token and the old one stops working. Issued tokens are stored only as
hashes (`.memory-data/mcp/tokens.json`). The token decides who is speaking; a `person` in the URL is ignored.

## Approaches

The registry (`approaches/registry.ts`) keeps the five methods that held up, plus the control:

| Name | Idea |
|---|---|
| `naive` | Control: embed raw messages, cosine recall. No LLM at write time. Also backs the offline tests. |
| `claims-pg+gate+router` | Subject–predicate–value claims in an append-only Postgres log (supersede, dispute, as-of), with the Jev ingest gate (`core/gate.ts`) and Jev query router (`claims-pg/router.ts`). |
| `temporal-kg+vecmatch` | Graphiti-style temporal knowledge graph on Neo4j (facts invalidated, never deleted), with Jev entity matching (`core/entity-match.ts`) over word, typo, prefix and embedding candidates. |
| `temporal-kg+vecmatch+rank+serial+lexical` | Plus named-entity boosting, per-scope serialized commits with disputes, and embedding-free reads (write-time question expansion, full-text search). |
| `temporal-kg+vecmatch+rank+serial+crowd+gemma+link` | Vector reads with EmbeddingGemma on the team's FastEmbed service (`MEMORY_REMOTE_EMBED_URL`), host crowding with one-hop candidates, and entity linking by description. |
| `temporal-kg+vecmatch+rank+serial+crowd+gemma+link+consolidate` | The same with working memory: messages wait in a buffer and are consolidated in batches; `dream()` merges entities and retires outdated facts. |

The approach classes still take the options of earlier rounds (ppr, hybrid, checker, fuse, …), which the
integration tests exercise; only the registry is trimmed.

Jev (`typesafe/jev-1.13` via OpenRouter, see `work/jev`) answers typed yes/no and choice questions with calibrated
probabilities in ~0.7 s; calls are cached in `.memory-data/jev-cache`. Each claims-pg variant uses its own Postgres schema.

## Layout

- `core/` — shared contract (`types.ts`), identity and scope rules, OpenAI wrapper, embeddings, shared answerer and judge.
  Approaches may import only `core/` and their own folder (enforced by `__tests__/boundaries.test.ts`).
- `approaches/<name>/` — one folder per approach; register it in `approaches/registry.ts`.
- `eval/` — runner, report, note-taker (`--ingest=notes`), small TS scenarios, and `datasets/` (see its README).

## Held-out data

`eval/datasets/{globex,initech,vandelay}` are the held-out sets. Don't read them or their per-question reports
while tuning prompts; run them at the end with frozen prompts.
