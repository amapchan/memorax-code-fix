# Local Memory Provider Design

Replace the remote MemoraX API as the default memory provider with a fully
local implementation. Memory data stays on the user's machine; the only
outbound call is to an embedding API for vector computation (never stores
content). When the embedding service is unavailable, the system degrades to
pure keyword search without crashing.

## Goals

- Default provider is `"local"`. Remote `"memorax"` remains available as an
  opt-in fallback but is no longer the default path.
- User-facing experience is unchanged: CLI commands, Skill triggers, and Hook
  automatic retrieval/writeback behave identically from the user's perspective.
- Memory storage is fully local (SQLite single file at
  `~/.memorax-code/local-memory.db`).
- Embedding computation uses an external API configured via
  `~/.memorax-code/embedding.json`. The API computes vectors only; it never
  stores memory content.
- When embedding is unavailable, retrieval degrades to SQLite LIKE keyword
  matching. The system runs fully offline.

## Architecture

### Provider dispatch

A new dispatch function routes memory operations to the correct provider
based on configuration:

```
invokeMemoryProvider(run, request, options)
  ├── provider === "memorax" → invokeMemoraxMemoryProvider (existing)
  └── provider === "local"   → invokeLocalMemoryProvider (new)
```

Callers in `automatic-retrieval.ts`, `automatic-writeback.ts`, and `cli.ts`
replace direct calls to `invokeMemoraxMemoryProvider` with the dispatch
function. The adapter interface signature and return format are identical
for both providers.

### File layout

New files:

```
provider/
├── local/
│   ├── adapter.ts       # Local provider implementing the same interface
│   ├── config.ts        # Provider selection + embedding config loading
│   ├── embedding.ts     # Ark embedding API client
│   ├── health.ts        # Startup health check + circuit state
│   └── store.ts         # SQLite storage layer
└── adapter-dispatch.ts  # Provider routing
```

Modified files:

```
memory/automatic-retrieval.ts   # Call dispatch instead of memorax adapter
memory/automatic-writeback.ts   # Call dispatch instead of memorax adapter
memory/cli.ts                   # Call dispatch instead of memorax adapter
config/memorax-code.ts          # Add provider field
```

Untouched: `provider/memorax/` (entire directory), all 6 client adapters,
Skill source files, npm packaging, lifecycle.

## Storage Layer

SQLite database at `~/.memorax-code/local-memory.db`.

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  repository_slug TEXT,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'semantic',
  embedding BLOB,
  embedding_dimensions INTEGER,
  embedding_model TEXT,
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_user
  ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_type
  ON memories(user_id, memory_type);
```

- Vectors are stored as BLOB (serialized Float32Array). Retrieval loads all
  embeddings for a user_id and computes cosine similarity in memory. No
  external vector database.
- `idempotency_key UNIQUE` prevents duplicate writes, matching the existing
  automatic-writeback idempotency mechanism.
- `repository_slug` is nullable: supports per-repository filtering and
  global search.

## Embedding Client

Calls an OpenAI-compatible `/embeddings` endpoint to convert text into a
Float32Array vector.

### Configuration file: `~/.memorax-code/embedding.json`

```json
{
  "$schema": "embedding-config.v1",
  "enabled": true,
  "api_key": "ARKCODINGPLAN_API_KEY",
  "base_url": "https://ark.cn-beijing.volces.com/api/coding/v3",
  "model": "doubao-embedding-vision",
  "timeout_ms": 5000
}
```

| Field | Required | Description |
|---|---|---|
| `enabled` | Yes | `false` disables embedding entirely; retrieval uses LIKE keyword matching only |
| `api_key` | No | Can be an environment variable name (resolved at runtime) or a literal value; defaults to `ARKCODINGPLAN_API_KEY` env var |
| `base_url` | No | Default Ark API; user can point to any OpenAI-compatible `/embeddings` endpoint |
| `model` | No | Default `doubao-embedding-vision` |
| `timeout_ms` | No | Default 5000 |

Priority: config file > environment variable > code default.

If the file does not exist, defaults apply: enabled=true, api_key from
`ARKCODINGPLAN_API_KEY` env var, base_url from Ark default. The file is
re-read on each invocation (matching existing `memoraxConfigFromEnv`
behavior). No Backend restart required after changes.

## Health Check and Degradation

The embedding service is checked once per process startup:

```
Backend process starts
  → Read embedding.json
  → enabled === false ?
      → Always use keyword mode for this process lifetime
  → enabled === true ?
      → Run health check: 3 attempts × 1000ms timeout each
      → Any attempt returns HTTP 200 → available for this process lifetime
      → All 3 fail → keyword mode for this process lifetime
      → Next process start re-checks
```

Health state is in-memory only, not persisted. Process restart = fresh check.

For `memorax-cli` (which spawns a new process per invocation), health check
runs on every CLI call. This is correct behavior for CLI: one check per
user command.

### Degradation matrix

| Scenario | Writeback | Retrieve |
|---|---|---|
| `enabled: false` (user explicit) | Text only | LIKE keyword matching |
| `enabled: true`, startup check passes | Vector + text | Vector search |
| `enabled: true`, startup check fails | Text only | LIKE keyword matching |

No background re-vectorization: old rows without embeddings become
searchable by keyword only. They gain vectors when re-written.

## Adapter Behavior

### Writeback

1. Receive messages (user/assistant dialogue turns)
2. Extract idempotency key from context
3. Generate summary text from first 512 chars of content
4. Call `embedding.embedText(summary)` for vector
5. SQLite INSERT (embedding nullable)
6. Return `{ ok: true, result: { dispatch_receipt, tool_result_payload } }`

Local mode stores raw text directly with `memory_type = "semantic"` by
default. The Skill can guide explicit `memory add --type "procedural"`
commands for higher-quality facts.

### Retrieve / Query

1. Receive query text
2. If embedding available: embed query → load user's vectors → cosine
   similarity → filter by min_score → return top_k
3. If embedding unavailable: SQLite LIKE keyword matching → return top_k
4. Format as context_blocks (`<memories>` XML), identical to memorax output

## Provider Configuration

In `~/.memorax-code/config.json`:

```json
{
  "memory": {
    "provider": "local"
  }
}
```

Environment variable override: `MEMORAX_CODE_MEMORY_PROVIDER=local`.

Priority: env var > config file > default `"local"`.

Existing users who never configured a provider will now default to local
mode. The remote memorax provider remains available by setting
`"provider": "memorax"`.

## Testing

### End-to-end (delivery verification)

Real SQLite file + mocked Ark embedding. Simulates complete user operation
chains:

| Scenario | Verification |
|---|---|
| Out-of-box (no embedding.json, no API key) | Startup → circuit-break → keyword mode, CLI search returns empty without error |
| CLI write + search | 3 items stored via `memorax-cli add`, `memorax-cli search` returns relevant results in memorax format |
| Hook auto-writeback | Simulated Hook writeback command → SQLite contains data, idempotency dedup works |
| Hook auto-retrieve | Simulated Hook retrieve → context_blocks non-empty, prompt_fragments correct format |
| Config switch | provider=local → write/search → switch to memorax → dispatch routes correctly, no cross-contamination |
| Embedding enabled | embedding.json + mock Ark 200 → vector search path works end-to-end |
| Embedding circuit-break | Mock Ark timeout 3× → keyword mode, no crash, LIKE path returns results |
| Restart recovery | Circuit-break → restart process → fresh health check |

### Unit tests

Per-module coverage in `test/provider/local/`:

- `store.ts`: CRUD, idempotency dedup, BLOB serialization, LIKE search
- `embedding.ts`: config parsing, API mock, timeout/error handling
- `health.ts`: 3-attempt logic, pass/fail paths, enabled=false skip
- `adapter.ts`: writeback flow, retrieve vector/keyword paths, output format
- `adapter-dispatch.ts`: provider routing, config priority

### Not tested

- Real LLM distillation quality
- Large-scale performance

### Existing tests unaffected

`test/provider/memorax/` remains untouched. `test/app/` composition-root
tests gain one provider-dispatch case.

