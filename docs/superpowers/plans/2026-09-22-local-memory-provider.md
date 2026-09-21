# Local Memory Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the remote MemoraX API as the default memory provider with a fully local SQLite + Ark-embedding implementation, preserving the existing CLI/Skill/Hook user experience.

**Architecture:** New `provider/local/` module alongside existing `provider/memorax/`. A dispatch function routes to the correct provider based on TOML config. SQLite stores memory text + optional vectors; Ark API computes embeddings; health check runs once per process startup with 3-attempt circuit-breaker fallback to keyword search.

**Tech Stack:** TypeScript (compiled to `dist/`), `node:sqlite` (built-in, Node 24+), `smol-toml` (existing config parsing), `node:test` (existing test framework).

**Spec:** `docs/superpowers/specs/2026-09-22-local-memory-provider-design.md`

## Global Constraints

- Node.js 24+ (`node:sqlite` available in Node 22+, tested on 24).
- Config format is TOML (`config.toml`), not JSON. Provider field goes in `[memory]` section.
- Embedding config is a separate JSON file (`embedding.json`).
- Default provider is `"local"`. Remote `"memorax"` is opt-in.
- Existing `provider/memorax/` directory must not be modified.
- Tests import from `dist/` (compiled), not `src/` directly.
- Test framework is `node:test` with `node:assert/strict`.
- E2E tests use real Ark API: `https://ark.cn-beijing.volces.com/api/coding/v3/embeddings`, model `doubao-embedding-vision`, API key from `ARKCODINGPLAN_API_KEY` env var.
- No new npm dependencies.
- Do not log or commit API keys.

---

### Task 1: SQLite Memory Store

**Files:**
- Create: `packages/ts/memorax-code-backend/src/provider/local/store.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/store.test.mjs`

**Interfaces:**
- Consumes: `node:sqlite` `DatabaseSync`
- Produces: `LocalMemoryStore` class with `insertMemory`, `searchByKeyword`, `searchByVector`, `close`

**Step 1: Write the failing test**

Create `test/provider/local/store.test.mjs` with 3 tests:
1. `insertMemory` stores and retrieves (LIKE search on content)
2. idempotency key UNIQUE constraint (second insert with same key throws)
3. `searchByVector` cosine similarity ordering: insert vectors `[1,0,0]` and `[0,1,0]`, query `[1,0,0]`, assert aligned score > 0.99 and orthogonal < 0.01

Test imports `LocalMemoryStore` from `dist/provider/local/store.js`, uses `mkdtemp` for temp dir.

**Step 2: Run test to verify it fails**

Run: `cd packages/ts/memorax-code-backend && npm run build && node --test test/provider/local/store.test.mjs`
Expected: FAIL `Cannot find module`

**Step 3: Write minimal implementation**

Create `src/provider/local/store.ts`:

- `LocalMemoryStore` class wrapping `DatabaseSync` from `node:sqlite`
- Constructor creates memories table:
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
  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(user_id, memory_type);
  ```
- `insertMemory(params: InsertMemoryParams): string` — generates UUID via `crypto.randomUUID()`, inserts row, returns id
  - `InsertMemoryParams`: `{ scope: Pick<RepositoryMemoryScope, "effectiveUserId" | "repositorySlug">, content: string, memoryType: string, idempotencyKey: string, sessionId?: string, embedding: Buffer | null, embeddingDimensions: number | null, embeddingModel: string | null }`
- `searchByKeyword({scope, query, topK}): StoredMemory[]` — `LIKE '%' || query || '%'` on content, `ORDER BY updated_at DESC`, `LIMIT topK`
- `searchByVector({scope, queryVector, topK, minScore}): StoredMemory[]` — loads all rows with embeddings for user, deserializes BLOB to `Float32Array`, computes cosine similarity, sorts desc, filters minScore, slices topK. Returns with `score` field
- `close(): void`

`StoredMemory`: `{ id, content, memoryType, embedding: Buffer|null, embeddingDimensions: number|null, embeddingModel: string|null, createdAt, updatedAt, score?: number }`

`cosineSimilarity(a: Float32Array, b: Float32Array): number` — dot / (sqrt(normA) * sqrt(normB)), returns 0 if denom is 0.

Serialization: `Buffer.from(float32Array.buffer)` to store; `new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)` to read.

**Step 4: Run test to verify it passes**

Expected: PASS all 3

**Step 5: Commit**

```
git add src/provider/local/store.ts test/provider/local/store.test.mjs
git commit -m "feat:(backend) add local memory SQLite store"
```

---

### Task 2: Embedding Config and Client

**Files:**
- Create: `packages/ts/memorax-code-backend/src/provider/local/config.ts`
- Create: `packages/ts/memorax-code-backend/src/provider/local/embedding.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/embedding.test.mjs`

**Interfaces:**
- Produces: `loadEmbeddingConfig(home: string, env?: Record<string, string|undefined>): EmbeddingConfig`
  - `EmbeddingConfig: { enabled: boolean, apiKey: string, baseUrl: string, model: string, timeoutMs: number }`
- Produces: `embedText(text: string, config: EmbeddingConfig): Promise<EmbeddingResult>`
  - `EmbeddingResult = { ok: true, vector: Float32Array, dimensions: number, model: string } | { ok: false, error: string }`

**Step 1: Write the failing test**

Tests for `loadEmbeddingConfig`:
1. Returns defaults when file missing (enabled=true, model=doubao-embedding-vision, timeoutMs=5000, baseUrl=https://ark.cn-beijing.volces.com/api/coding/v3)
2. Reads custom values from `embedding.json` (enabled=false, custom api_key/base_url/model/timeout_ms)
3. `api_key` field resolves env var names: if value matches `/^[A-Z][A-Z0-9_]+$/` treat as env var name and resolve from env

Tests for `embedText`:
1. Real Ark API test (skip if no `ARKCODINGPLAN_API_KEY`): assert ok=true, vector.length=2048
2. Failure with invalid key: assert ok=false, error present

**Step 2: Run test to verify it fails**

**Step 3: Write minimal implementation**

`config.ts`:
- `loadEmbeddingConfig` reads `{home}/embedding.json` (JSON.parse)
- Merges with defaults: `DEFAULT = { enabled: true, apiKey: "", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "doubao-embedding-vision", timeoutMs: 5000 }`
- `api_key` resolution: if value matches `/^[A-Z][A-Z0-9_]+$/` treat as env var name, resolve from env; else use literal. If still empty, fall back to `env.ARKCODINGPLAN_API_KEY`.

`embedding.ts`:
- `embedText` sends POST to `{baseUrl}/embeddings` with headers `Authorization: Bearer {apiKey}`, `Content-Type: application/json`
- Body: `{ model, input: text }`
- Timeout via `AbortController` + `setTimeout(config.timeoutMs)`
- Parse `response.data[0].embedding` as `Float32Array`
- Return `{ ok: true, vector, dimensions, model }` or `{ ok: false, error }`

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```
git add src/provider/local/config.ts src/provider/local/embedding.ts test/provider/local/embedding.test.mjs
git commit -m "feat:(backend) add embedding config and Ark API client"
```

---

### Task 3: Health Check

**Files:**
- Create: `packages/ts/memorax-code-backend/src/provider/local/health.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/health.test.mjs`

**Interfaces:**
- Consumes: `embedText` from Task 2
- Produces: `checkEmbeddingHealth(config: EmbeddingConfig): Promise<boolean>`

**Step 1: Write the failing test**

Tests:
1. Returns true for valid Ark API (skip if no `ARKCODINGPLAN_API_KEY`)
2. Returns false for unreachable endpoint (`http://localhost:1`, timeoutMs=500)
3. Returns false when `config.enabled=false`

**Step 2: Run test to verify it fails**

**Step 3: Write minimal implementation**

`health.ts`:
- `checkEmbeddingHealth`: if `!config.enabled` return `false`
- Override `timeoutMs` to 1000 for health checks
- Loop 3 attempts: call `embedText("health-check", config)`. If ok, return `true`.
- After 3 failures return `false`

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```
git add src/provider/local/health.ts test/provider/local/health.test.mjs
git commit -m "feat:(backend) add embedding health check with circuit breaker"
```

---

### Task 4: Local Memory Adapter

**Files:**
- Create: `packages/ts/memorax-code-backend/src/provider/local/adapter.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/adapter.test.mjs`

**Interfaces:**
- Consumes: `LocalMemoryStore` (Task 1), `loadEmbeddingConfig` (Task 2), `embedText` (Task 2), `checkEmbeddingHealth` (Task 3)
- Produces: `invokeLocalMemoryProvider(run, request, options)` with same signature and return type as `invokeMemoraxMemoryProvider` from `provider/memorax/adapter.ts`

**Step 1: Write the failing test**

Tests:
1. `writeback` stores content, then `retrieve` finds it (LIKE search on content includes key terms)
2. `retrieve` returns `contextBlocks` with `<memories>` XML format matching memorax output
3. `retrieve` without `repositoryScope` fails with error containing `"scope"`
4. `writeback` with duplicate idempotencyKey accepted (no-op), subsequent retrieve shows exactly 1 result

**Step 2: Run test to verify it fails**

**Step 3: Write minimal implementation**

`adapter.ts`: `invokeLocalMemoryProvider(run, request, options)`:

- Check `options.repositoryScope` exists, fail closed if not: `{ ok: false, error: "memory scope is required for local memory provider" }`
- Open `LocalMemoryStore` at `{home}/local-memory.db` (home from `options.env?.MEMORAX_CODE_HOME` or `defaultMemoraxCodeHome`)
- Dispatch on `request.operation`:
  - `"writeback"`: extract `idempotencyKey` from `context.idempotencyKey`, messages from `context.messages` array. Join message contents as `"role: content"`. Try embedding: `loadEmbeddingConfig`, if enabled+apiKey, `checkEmbeddingHealth`, if healthy `embedText` on first 512 chars. Insert into store. Catch UNIQUE constraint as accepted duplicate (return ok).
  - `"retrieve"` or `"query"`: extract query from `request.query` or `run.prompt`. If embedding available (config enabled + apiKey + health check passes), embed query, `searchByVector` with minScore=0.3, topK=6. If no results or embedding unavailable, fallback to `searchByKeyword`. Format results as `<memories><facts>` XML matching memorax format.
- Close store in `finally` block
- Return format: `MemoraxInvocationResult` with `tool_result_payload: { answer, items, contextBlocks }` and `dispatch_receipt: { accepted, receipt_id, summary }`

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```
git add src/provider/local/adapter.ts test/provider/local/adapter.test.mjs
git commit -m "feat:(backend) add local memory adapter implementing memorax interface"
```

---

### Task 5: Provider Dispatch and Config Switch

**Files:**
- Create: `packages/ts/memorax-code-backend/src/provider/adapter-dispatch.ts`
- Modify: `packages/ts/memorax-code-backend/src/config/memorax-code.ts` — add `provider` field to `memory` type + normalize + default template
- Modify: `packages/ts/memorax-code-backend/src/memory/automatic-retrieval.ts` — swap invoke call
- Modify: `packages/ts/memorax-code-backend/src/memory/automatic-writeback.ts` — swap invoke call
- Modify: `packages/ts/memorax-code-backend/src/memory/cli.ts` — swap invoke call
- Test: `packages/ts/memorax-code-backend/test/provider/local/dispatch.test.mjs`

**Interfaces:**
- Produces: `invokeMemoryProvider(run, request, options)` dispatches to local or memorax based on config
- Priority: env `MEMORAX_CODE_MEMORY_PROVIDER` > config.toml `[memory].provider` > default `"local"`

**Step 1: Add provider field to TOML config**

In `src/config/memorax-code.ts` `MemoraxCodeConfig` type, inside `memory` section add: `provider?: string`.
In `normalizeMemoraxCodeConfig` memory section add: `provider: stringField(memory, "provider")`.
In `renderDefaultMemoraxCodeConfig` under `[memory]` add: `provider = "local"`.

**Step 2: Write dispatch function**

Create `src/provider/adapter-dispatch.ts`:

```typescript
import { invokeMemoraxMemoryProvider } from "./memorax/adapter.js";
import { invokeLocalMemoryProvider } from "./local/adapter.js";
import { loadMemoraxCodeConfig, defaultMemoraxCodeHome } from "../config/memorax-code.js";

export async function invokeMemoryProvider(run, request, options) {
  const env = options.env ?? process.env;
  const envProvider = env.MEMORAX_CODE_MEMORY_PROVIDER?.trim();
  const fileProvider = loadMemoraxCodeConfig(defaultMemoraxCodeHome(env)).memory?.provider;
  const provider = envProvider || fileProvider || "local";
  if (provider === "local") return invokeLocalMemoryProvider(run, request, options);
  return invokeMemoraxMemoryProvider(run, request, options);
}
```

**Step 3: Write failing dispatch test**

Test: default dispatch goes to local (works without API key for keyword search). Env override `MEMORAX_CODE_MEMORY_PROVIDER=memorax` routes to memorax (fails on missing `MEMORAX_CODE_MEMORAX_API_KEY`).

**Step 4: Swap call sites**

In `automatic-retrieval.ts`: replace `import { invokeMemoraxMemoryProvider } from "../provider/memorax/adapter.js"` with `import { invokeMemoryProvider } from "../provider/adapter-dispatch.js"`. Replace all `invokeMemoraxMemoryProvider(...)` calls with `invokeMemoryProvider(...)`.
Same in `automatic-writeback.ts` and `cli.ts`.

**Step 5: Run all existing tests for no regressions**

Run: `npm run build && npm test`
Expected: all PASS

**Step 6: Commit**

```
git add src/provider/adapter-dispatch.ts src/config/memorax-code.ts src/memory/automatic-retrieval.ts src/memory/automatic-writeback.ts src/memory/cli.ts test/provider/local/dispatch.test.mjs
git commit -m "feat:(backend) add provider dispatch with local as default"
```

---

### Task 6: E2E Tests with Real Ark API

**Files:**
- Test: `packages/ts/memorax-code-backend/test/provider/local/e2e.test.mjs`

**Step 1: Write E2E tests**

Scenario 1 — Full flow with real Ark embedding (skip if no `ARKCODINGPLAN_API_KEY`):
- Writeback 2 messages with idempotencyKey `"e2e-wb-1"`
- Keyword retrieve finds the content
- Vector retrieve (if embedding available) also finds content with different query
- Duplicate writeback (same key, different content) accepted
- Final retrieve shows exactly 1 result (no duplicates)

Scenario 2 — Out-of-box without API key:
- Set `ARKCODINGPLAN_API_KEY` to empty string in env
- Writeback works (text only, no embedding)
- Keyword retrieve returns results

Scenario 3 — Config switch:
- Default dispatch uses local provider (works without API key)
- Set `MEMORAX_CODE_MEMORY_PROVIDER=memorax` in env
- Dispatch to memorax fails on missing `MEMORAX_CODE_MEMORAX_API_KEY` (proving dispatch works)

**Step 2: Run E2E tests**

Run: `npm run build && node --test test/provider/local/e2e.test.mjs`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: all PASS

**Step 4: Commit**

```
git add test/provider/local/e2e.test.mjs
git commit -m "test:(backend) add E2E tests for local memory provider with real Ark API"
```
