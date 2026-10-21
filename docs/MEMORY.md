# Hippocampus Memory

A file system for what agents know. Spaces are folders, notes are files, every write keeps a version, and every note is indexed three ways automatically: by meaning (embeddings), by exact words, and by the names and links in it (a graph). A product names the folders and decides who may open them, in the token it signs. Hippocampus never decides what is remembered or who sees it; it makes both cheap and safe.

Every strong memory system converges on this shape. mem0 and supermemory's "extract facts, store vectors" is one writer onto such a file system; Anthropic's memory tool is a directory the model edits; Letta keeps blocks always in context plus an archive; past.dev adds dated sources and reading the past. Hippocampus is all of them behind six verbs.

Base path: `/memory` on any Hippocampus server with `MEMORY_DATABASE_URL` set. The RAG routes (`/collection`, `/resource`, `/search`) are unchanged and separate.

## Seven use cases, one file system

| Use case | The product does | Hippocampus does |
| --- | --- | --- |
| Six agents, one shared file (product truth, decisions) | Creates a space `product-truth`; gives two agents write and four read | Keeps the file, lets a writer change one paragraph in place, versions every edit, hands readers the index first |
| Per-user memory in a chat | Sends each message to `learn`, or lets viaSocket's chat do it | Extracts short notes into `users/<id>`, merges changes, recalls rules and related notes before each answer |
| Team or account memory | Names a space per team or customer; grants it in the token | Same store; learning sorts personal from shared when told the shared space |
| An agent's own long-term memory across runs | Gives the agent a space `agents/writer` | The agent reads its index at start, writes what it learned at the end |
| Documents: PDFs, pages, policies | Uploads or links them into a space | Stores the document as a long note, chunks it for search, indexes its names like any note |
| Looking back in time | Asks with `as_of` | Answers from the versions that were current then, with dates on every note |
| Forgetting | Deletes a note, a space, everything about a name, or everything from a source | Removes the note, its versions and its index entries; nothing derived survives the source |

## Setup

```properties
MEMORY_DATABASE_URL=postgres://user:pass@host:5432/hippocampus   # Postgres 14+ with the pgvector extension (0.5+)
MEMORY_SIGNERS={"viasocket":"<secret shared with viaSocket>"}     # or register signers through the admin API
MEMORY_EMBEDDING_MODEL=google/embeddinggemma-300m                 # any dense model the Encoder knows; this one is local
MEMORY_EMBEDDING_DIMENSIONS=768                                    # must match the model; changing the model needs a reindex
MEMORY_MAX_DISTANCE=0.72                                           # optional; defaults follow the model (0.8 for OpenAI's)
EMBEDDING_SERVER=http://127.0.0.1:8000                             # the FastEmbed sidecar that runs local models
MEMORY_EXTRACTION_MODEL=claude-haiku-5-5                           # learn, link, merge, lessons, summaries; or an OpenAI model
MEMORY_EXTRACTION_FALLBACK_MODEL=gpt-4.1-mini                      # the other provider, used when the first one fails
ANTHROPIC_API_KEY=...                                              # for a Claude extraction model (the default)
OPENAI_API_KEY=...                                                 # for an OpenAI extraction model (the default fallback)
OPENAI_API_KEY_EMBEDDING=...                                       # only if MEMORY_EMBEDDING_MODEL is an OpenAI model
```

Embeddings come from Google's EmbeddingGemma (open weights, 100+ languages) running on CPU in the FastEmbed sidecar: `cd fastembed && pip install -r requirements.txt && uvicorn main:app` (the `embedding-server` app in `ecosystem.config.js`; the model, 1.2 GB, is downloaded on first start). No text leaves the machine to be embedded. Set `MEMORY_EMBEDDING_MODEL=text-embedding-3-small` and `MEMORY_EMBEDDING_DIMENSIONS=1536` to use OpenAI instead.

Deploying a model change: the Docker image downloads the model at build time (`FASTEMBED_CACHE_PATH`), so nothing is installed by hand and a container does not depend on Hugging Face at start. A database that already holds an index made with another model fails its migration at start (the error is logged and memory writes are rejected), because its vector column has the old size; start once with `MEMORY_EMBEDDING_REINDEX=true` and the server drops the chunks, resizes the column and re-indexes every note (through the memory consumer when a broker is configured). Until that finishes, search finds only word and name matches. An empty index is resized silently.

Extraction can have a second model: `MEMORY_EXTRACTION_FALLBACK_MODEL=gpt-4.1-mini` behind `MEMORY_EXTRACTION_MODEL=claude-haiku-5-5` means an Anthropic outage or rate limit costs one warning line, not a lost memory. Each provider needs its key.

The schema is created on start (`MEMORY_AUTO_MIGRATE=false` to run `npm run memory:migrate` yourself). Long notes and documents are indexed by the memory consumer: `npm run memory-consumer`, or the `memory-consumer` app in `ecosystem.config.js`. Without a broker, indexing runs inside the request.

`MEMORY_FAKE_MODELS=true` runs without any API key: embeddings are hashed from words and nothing is learned. For tests and local tries.

## Access: the token

Every call carries a short-lived HS256 JWT, as `Authorization: Bearer <token>`, signed by a registered signer:

```json
{
  "iss": "viasocket",
  "sub": "users/maya",
  "org": "4310",
  "project": "projbbi6QqVU",
  "spaces": { "users/maya": "write", "teams/acme": "write", "product-truth": "read", "customers/*": "read" },
  "iat": 1760000000,
  "exp": 1760003600
}
```

| Claim | Meaning |
| --- | --- |
| `iss` | The signer: `viasocket`, or the product's own issuer registered through `/memory/admin/signers`. Its secret verifies the token. |
| `sub` | Who is calling, recorded as who wrote a note. Any string; the user's space name is a good choice. |
| `org`, `project` | The product's own tenant ids (`org_id` and `project_id` are accepted too). With `iss` they make the tenant every row carries. |
| `spaces` | Up to 50 grants, each `"read"`, `"append"` or `"write"`. `read` sees the space. `append` adds notes and changes the caller's own, but never replaces or deletes a note someone else created: a change to another's note is added beside it, with who says so. `write` may change and delete anything. A name is segments of letters, digits and `_ . @ -` joined by `/`. `"folder/*"` grants everything under a folder, `"*"` every space. The most specific grant for a space wins. |
| `exp` | Required. A token is never accepted for longer than `MEMORY_TOKEN_MAX_AGE` (7 days by default). |

Hippocampus takes the tenant and grants from the token only, never from the request body. A space not granted is a `403` before anything runs. There is no magic "me": private memory is a folder the product names, such as `users/<id>`, granted only to that user's tokens. Identity never enters Hippocampus.

Two signers from day one: viaSocket, for products on the AI skill (viaSocket's backend turns an embed token into this token), and a product's own key, for anyone else.

### Registering a signer (operator, master key)

```http
POST /memory/admin/signers
x-api-key: <MASTER_API_KEY>
{ "issuer": "acme-app", "name": "Acme App", "org_id": "optional: pin to one org" }

201 { "issuer": "acme-app", "secret": "<shown once>" }
```

`POST /memory/admin/token` mints a token for a known signer, for curl and MCP clients. `GET /memory/admin/signers`, `DELETE /memory/admin/signers/:issuer`, `POST /memory/admin/migrate`, `POST /memory/admin/reindex` and `GET /memory/admin/usage` complete the operator API.

## The data model

| Thing | What it is | Who shapes it |
| --- | --- | --- |
| Space | A folder inside a tenant: `users/maya`, `teams/acme`, `agents/writer`, `product-truth`, `customers/bloom.com`. Created on first write. | The product |
| Note | One file: a path, a title, a Markdown body, a kind (`note`, `rule`, `fact`, `lesson`, `doc`, or the product's own word), labels, `valid_from` and `valid_to`, who wrote it, where it came from (`source`) | The product, an agent, or extraction |
| Version | Every write makes a new version; the note's current pointer moves; old versions stay readable | Hippocampus, always on |
| Index | Per version, automatic: chunks with embeddings (a short note is one chunk), a word index, the names and links in it | Hippocampus, never the source of truth |

A fact is a one-line note; a 40-page policy is a note that is chunked for search and summarised for the index. Rules carry a `slot` (`tone`, `language`) and live at `rules/<slot>`: one live rule per slot in a space, a new one replacing the old as a new version.

## The verbs

Every reply is JSON. Errors are `{ "status": "error", "message": "...", "success": false }` with the HTTP status that says why: `400` a bad field, `401` the token, `403` a space not granted, `404` nothing there, `409` a stale `if_version` or an ambiguous edit, `503` memory off.

### What is in this folder: `GET /memory/spaces`, `GET /memory/index`

```http
GET /memory/spaces
{ "spaces": [{ "name": "users/maya", "access": "write", "notes": 12, "updated_at": "..." }, ...] }

GET /memory/index?space=product-truth&path=pricing&as_of=2026-10-01T00:00:00Z&kind=doc&labels=billing
{ "spaces": ["product-truth"], "path": "pricing", "folders": ["pricing/regions"],
  "notes": [{ "space": "product-truth", "path": "pricing/plans", "kind": "doc", "title": "Plans", "summary": "Starter is $10 a month.", "labels": [], "version": 3, "status": "active", "valid_to": null, "updated_at": "...", "confirmed": 1, ... }] }
```

`space` or `spaces` (comma separated); without either, every space the token can read. `path` narrows to a folder. `all=true` lists archived notes too.

### Show me this: `GET /memory/open`, `GET /memory/history`

```http
GET /memory/open?space=product-truth&path=pricing/plans[&as_of=...][&version=2]
{ "note": { ...index fields..., "body": "# Plans\n\nStarter is $10 a month. ...", "document": null } }

GET /memory/history?space=product-truth&path=pricing/plans
{ "versions": [{ "version": 1, "title": "Plans", "summary": "...", "body": "...", "written_by": "users/maya", "change": "write", "created_at": "..." }, ...] }
```

### What is similar or relevant: `POST /memory/search`

```http
POST /memory/search
{ "query": "When does Acme launch?", "spaces": ["users/maya", "teams/acme"], "top_k": 5 }

{ "prompt": "## What you remember\n...Rules:\n- (tone) Prefers a casual tone.\n\nRelevant notes:\n- Acme launches Product X on November 3. (teams/acme/facts/acme-launch-3f2a, as of 12 Oct 2026)\n\nConnections:\n- acme: → launches product x; → uses hubspot",
  "rules": [...], "results": [{ ...note..., "excerpt": "Acme launches Product X on November 3.", "distance": 0.31, "score": 0.84 }],
  "connections": [{ "name": "acme", "phrases": ["→ launches product x", "→ uses hubspot"], "links": [...] }],
  "lessons": [...] }
```

Ranking combines meaning (cosine distance), exact words, names shared with the query, names one link away in the graph, and how often a note was confirmed; the best chunk of each note stands for the note. `spaces` are in order of precedence: when the same rule slot is set in several, the first wins. `kinds`, `labels` and `as_of` narrow it; `prompt: false` gives a plain search without rules, lessons and the block. The `prompt` is ready to paste into a system prompt: rules first, dated notes, connections, lessons, within about a thousand tokens.

### What is connected to this: `GET /memory/entity/:name`, `GET /memory/entities`

```http
GET /memory/entity/acme?spaces=teams/acme&as_of=2026-10-01T00:00:00Z
{ "entity": { "name": "acme", "type": "organisation", "notes": [...], "links": [{ "subject": "acme", "relation": "uses", "object": "hubspot", "space": "teams/acme", "path": "facts/...", "as_of": "...", "until": null }], "connected": [{ "name": "hubspot", "links": 2 }] } }

GET /memory/entities?space=teams/acme&q=ac
{ "entities": [{ "name": "acme", "type": "organisation", "notes": 7 }] }
```

Names are lowercase as remembered (`acme`, `bloom salons`, `#payments`); URL-encode spaces and `#`. `POST /memory/entity` with `{ "name" }` does the same for tool calls.

### Keep this: `PUT /memory/notes` (write), `PATCH /memory/notes` (edit), `POST /memory/notes` (remember), `POST /memory/learn`

Write the whole note, create or replace:

```http
PUT /memory/notes
{ "space": "product-truth", "path": "pricing/plans", "title": "Plans", "body": "# Plans\n\nStarter is $10 a month.", "kind": "doc", "labels": ["billing"], "if_version": 2 }

201 { "created": true, "note": { ...with body... }, "indexed": "indexed" }
```

`if_version` is the version you read; a stale one is refused with `409` so two agents cannot silently race. `valid_from`, `valid_to`, `source` (`{ "type", "id" }`), `confidence`, `entities` and `relations` (to skip the linking model call) are optional. `indexed` is `indexed`, `queued` (a long body, by the consumer) or `failed`.

Edit in the middle, the way a person edits a file; each edit is its own version:

```http
PATCH /memory/notes
{ "space": "product-truth", "path": "pricing/plans", "if_version": 3,
  "ops": [{ "op": "str_replace", "old": "Starter is $10", "new": "Starter is $12" }, { "op": "append", "text": "Enterprise: ask sales." }] }
```

Ops: `str_replace` (`old` must appear exactly once), `insert` (`line`: after that many lines, 0 for the top), `append`, `prepend`, `delete`. `title`, `labels`, `valid_to`, `kind` and `slot` can change in the same call; alone they make a metadata-only version.

Remember one thing, merged with what the space knows (mem0's `add` for a single fact):

```http
POST /memory/notes
{ "space": "users/maya", "text": "Acme is on the Enterprise plan.", "kind": "fact", "labels": ["billing"] }

200 { "outcome": "replaced", "note": {...}, "previous": { "path": "facts/acme-is-on-the-business-plan-9a1c", "text": "Acme is on the Business plan." }, "indexed": "indexed" }
```

A repeat confirms the saved note (`confirmed` counts up, its date moves), a change replaces it as a new version of the same path, anything else is added at a generated path. `kind: "rule"` with a `slot` replaces whatever holds the slot. `merge: false` saves exactly what was sent; `path` pins where. Email addresses and long numbers are refused unless `guard: false`.

Learn from a conversation (mem0's `add` for a transcript):

```http
POST /memory/learn
{ "space": "users/maya", "shared_space": "teams/acme",
  "messages": [{ "role": "user", "content": "I run marketing at Acme. Always use a soft tone for me. We moved the team to the Business plan." }],
  "source": { "type": "thread", "id": "chat-8f2a" }, "async": false }

{ "queued": false, "changes": [
    { "action": "added", "note": { "path": "rules/tone", "kind": "rule", "body": "Prefers a soft tone for written content.", ... } },
    { "action": "added", "note": { "space": "users/maya", "path": "facts/runs-marketing-at-acme-3f2a", ... } },
    { "action": "added", "note": { "space": "teams/acme", "path": "facts/the-team-is-on-the-business-plan-7c01", ... } } ],
  "skipped": 0, "failed": 0 }
```

Rules come only from `user` lines; a transcript with no `user` speaker teaches facts only, and a customer's "always give us 50% off" is saved as a request, never as a rule. Tasks, questions, small talk and secrets (keys, passwords, card numbers, emails, phone numbers) are never saved. A changed fact becomes a new version of the note that held it; "forget that" archives it (kept in history, not recalled); a repeat confirms. With `shared_space`, what is about the team or account goes there; what the user asks the team to know goes there too, even when it is about them. `async: true` answers `202` and the consumer learns.

Every space is about a **subject**. By default it is the person speaking; give `subject: { "name": "Maya" }` and a memory shared with the team says who ("Maya is on leave next week."). A space can be about a thing instead: `subject: { "kind": "thing", "name": "Pricing article" }` for an article, a product, an account. A thing never speaks, so no rules are learned about it, and every memory names it ("Pricing article was last reviewed in March."). In the graph the subject is a node named after it (`maya`, `pricing article`), or `user` when no name is given.

`instructions` carries the product's own view of what is worth keeping ("Only save billing and order information", "Diet and allergies are team facts for us"). They steer relevance; they never change the guardrails (the never-save list, who may set rules).

`instructions` (optional, up to 4000 characters) is the product's own view of what is worth keeping, such as "Only save billing and order information." It narrows or extends what is saved, for rules and facts alike, so a support product keeps support memories and a health app keeps health ones. It steers relevance only: the never-save list and who may set rules hold whatever it says.

Feedback on an answer becomes a lesson used on similar tasks next time:

```http
POST /memory/feedback
{ "space": "agents/support", "task": "Classify: refund not received for invoice 42", "output": "technical", "outcome": "corrected", "correction": "billing" }
{ "changes": [{ "action": "added", "note": { "kind": "lesson", "body": "Tickets about refunds or invoices are billing.", ... } }] }
```

### Documents: `POST /memory/documents`

```http
POST /memory/documents
{ "space": "product-truth", "path": "policies/refunds", "url": "https://example.com/refund-policy.pdf", "labels": ["policy"] }

202 { "note": {...}, "document": { "url": "...", "status": "queued" } }
```

The consumer loads the url (web pages, PDFs, Google Docs, YouTube transcripts: the loaders Hippocampus already has), saves the text as the note's next version and indexes it in chunks. `GET /memory/open` shows `document.status`: `queued`, `loading`, `indexed` or `error`. With `content` instead of `url`, the text is saved at once.

### Forget this: `DELETE /memory/notes`, `/memory/spaces`, `/memory/entity/:name`, `/memory/source`

```http
DELETE /memory/notes      { "space": "users/maya", "path": "facts/acme-plan-9a1c" }   -> { "deleted": 1 }
DELETE /memory/notes      { "space": "users/maya", "path": "...", "archive": true }    -> stops using it, keeps history
DELETE /memory/spaces     { "space": "users/maya" }                                   -> everything about this user
DELETE /memory/entity/acme?spaces=teams/acme                                          -> every note that names or links acme
DELETE /memory/source     { "type": "thread", "id": "chat-8f2a" }                     -> everything derived from that thread
```

Deleting removes the note, its versions, chunks, names and links. Fields in the body or the query string both work.

## For a model: MCP and function definitions

`POST /memory/mcp` is a stateless MCP server over streamable HTTP with the same verbs as tools (`memory_spaces`, `memory_index`, `memory_open`, `memory_search`, `memory_entity`, `memory_write`, `memory_edit`, `memory_remember`, `memory_learn`, `memory_delete`), authorised by the same bearer token. Point Claude Desktop, Cursor or an agent framework at it:

```json
{ "mcpServers": { "memory": { "url": "https://hippocampus.example.com/memory/mcp", "headers": { "Authorization": "Bearer <memory token>" } } } }
```

`GET /memory/tools` returns the same tools as OpenAI-style function definitions, each with the HTTP method and url to call, for a product that runs its own model.

How an agent uses it, concretely: `memory_index("product-truth")` gives it twelve titles; it opens two, searches `teams/acme` for "launch", writes its draft into `agents/writer/drafts/launch-email`, and edits one line of `product-truth/pricing` a human marked wrong. Nothing in its prompt says "vector" or "graph".

## Versioning and accuracy

- Append-only. A write never destroys; the current pointer moves, the old version stays with who wrote it and when. `history` lists versions; `as_of` on index, open, search and entity reads a space as it stood at a moment.
- A write may carry `if_version`; a stale one is refused. Edits change one phrase or line, so parallel writers do not overwrite each other.
- A changed fact is a new version; recall shows only the current one, with its date beside it, so a stale fact looks stale.
- Every learned note points to its source; delete the source and its notes go with it.
- Only the subject's own words set a rule. Secrets are never extracted. A request is recorded as a request. Low-confidence extractions are skipped.
- `valid_to` ends a note's use without deleting it ("on leave until Oct 30").

What Hippocampus does not do: lock files, merge conflicting edits, or decide which of two agents is right. A refused stale write tells the agent to read again; the product's workflow decides the rest.

## Metering

One row per call in `memory_usage`: issuer, org, project, caller, verb and the model tokens it used. `GET /memory/admin/usage?issuer=viasocket&from=2026-10-01` sums them per tenant and verb.

## Testing

```bash
npm test -- src/memory                                        # unit: grants, tokens, paths, chunking, edits, prompt
MEMORY_TEST_DATABASE_URL=postgres://... npm test -- integration   # end to end on a real Postgres, fake models
npm run memory:eval                                           # golden cases for the extraction prompts (needs the model's key)
MEMORY_EXTRACTION_MODEL=claude-haiku-5-5 npm run memory:eval  # the same cases on a candidate model, before making it the default
```
