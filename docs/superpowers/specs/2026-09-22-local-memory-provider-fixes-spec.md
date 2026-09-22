# Local Memory Provider Fixes Spec

Hardening and correctness fixes for the local memory provider implemented in
[2026-09-22-local-memory-provider-design.md](2026-09-22-local-memory-provider-design.md).
Findings come from a code-level review plus live verification on Windows
(Node v24.15.0, real Ark embedding API): the provider chain builds and the
end-to-end happy path works, but the issues below block release or degrade
production behavior. Where this spec conflicts with the original design, this
spec wins; the original document is amended as noted in [Spec amendments](#spec-amendments).

## P0 — Release blockers

### 1. Node engine floor vs `node:sqlite`

`provider/local/store.ts` statically imports `DatabaseSync` from `node:sqlite`.
The module is imported eagerly through `adapter-dispatch.ts` ←
`automatic-retrieval.ts` / `automatic-writeback.ts` / `cli.ts`, so on a Node
runtime without `node:sqlite` the **entire Backend fails at import time**,
including the memorax provider path. The npm package declares
`engines: node >=20`; Node 20 has no `node:sqlite` at all (it appeared in
22.5 behind a flag and is flag-free in current 22.x LTS).

**Decision (approved): raise the engine floor.**

- `packages/npm/memorax-code/package.json` `engines.node` → `>=22.13`.
- Audit every other `package.json` for `engines` and align.
- Bump `@types/node` in the Backend package to a matching major.
- Update README / README.zh / docs prerequisites and the CI matrix to the new
  floor. State the Node requirement explicitly in onboarding.
- No dynamic-import fallback: static imports stay, one supported floor,
  fail loud at install time.

### 2. Windows test-process crash under `--test-force-exit`

`test/provider/local/embedding.test.mjs` reproducibly aborts the process with
a libuv assertion (`UV_HANDLE_CLOSING`, `src\win\async.c`) when the Backend
test script runs with `--test-force-exit`. Root cause: live undici/fetch
handles race force-exit on Windows. The file passes without force-exit, but
the package's own `npm test` uses force-exit, so Windows CI is red.

**Decision: make the network injectable and stop hitting the network in
default tests.**

- `embedText(text, config, fetchImpl?)` gains an optional fetch parameter
  (defaults to global `fetch`). No behavioral change for production callers.
- All default unit/e2e tests use a stub `fetchImpl`; no live sockets, no
  force-exit race.
- Live Ark API tests become explicit opt-in per CONTRIBUTING ("Real-client or
  MemoraX-backed checks are explicit opt-in tests"): gated on
  `MEMORAX_CODE_LIVE_EMBEDDING_TEST=1` **and** `ARKCODINGPLAN_API_KEY`,
  skipped otherwise. Reported separately from synthetic tests.

### 3. Architecture and documentation rewrite (same change set)

ARCHITECTURE.md still describes the remote-only memory architecture. Per
AGENTS.md §2 and ARCHITECTURE.md §9, the boundary change must land in the
same change set as the behavior. Required edits:

- **§2 system diagram + component table**: provider dispatch owns routing;
  MemoraX becomes an opt-in remote; add the embedding API as a second,
  reviewed outbound edge; register `local-memory.db` as local runtime state.
- **§6.2 state classes**: `local-memory.db` is durable local state shared
  across the Backend and `memorax-cli` processes. The cross-process
  read/modify/write invariant is satisfied by SQLite WAL + `busy_timeout`
  (see P1-5); document that pairing.
- **§6.3 local-only data flow**: register the embedding endpoint as a
  reviewed outbound exception: payload is the text to embed only, the
  service stores nothing, users can disable it (`enabled: false`).
- **§8 test routing**: add `src/provider/local` → `test/provider/local`.
- **Ripple**: SECURITY.md (local data & diagnostics registers the db file and
  the embedding outbound path), `docs/configuration.md` (`[memory].provider`
  in TOML, every `embedding.json` field including `api_key_env` below),
  README + README.zh kept in sync. Verification: Documentation profile
  (`make docs-check`).

## P1 — Production behavior

### 4. Lazy circuit breaker replaces per-call health checks

Current code runs `checkEmbeddingHealth` on **every** writeback and retrieve:
up to 3 × 1000 ms added latency on the synchronous prompt-retrieval path, and
each check is a real paid embedding call (3 on failure). The original spec's
"check once per process startup" was not implemented; `health.ts` is
stateless.

**Decision: lazy circuit breaker — simplest correct semantics, zero extra
API calls.**

- No proactive health check at all. The first real `embedText` call doubles
  as the probe.
- `health.ts` keeps process-lifetime in-memory circuit state keyed by the
  resolved embedding config: first failure opens the circuit; while open,
  embedding is skipped (keyword path) for the rest of the process lifetime;
  a success keeps it closed. State is never persisted; process restart
  re-probes naturally. `memorax-cli` (new process per invocation) re-probes
  per command — same user-visible semantics as the original spec, minus the
  wasted calls.
- Degradation matrix from the original spec is unchanged; only the probe
  mechanism changes.

### 5. Observability parity with the memorax adapter

The local adapter emits no observability or diagnostic events, so retrieval
and writeback disappear from trace and diagnostic history in local mode —
violating the §6.3 data-flow contract and the "identical user experience"
goal.

- Local adapter calls `recordMemoryObservabilityEvent` with the same event
  shapes as the memorax adapter (operation, ok, request slot, response
  receipt id, item counts, context blocks), with `provider_id`
  `memory.local` and receipt ids `local:<idempotencyKey|uuid>`.
- Diagnostic logger fields mirror the memorax path (latency, item counts,
  skip/error reasons).

### 6. SQLite concurrency and serialization hardening

- Open the database with `PRAGMA journal_mode=WAL;` and
  `PRAGMA busy_timeout=2000;` — Backend and `memorax-cli` write the same
  file from different processes; today a concurrent write throws
  `SQLITE_BUSY`.
- Read path: copy the BLOB (`Buffer.from(row.embedding)`) before creating
  the `Float32Array` view. The current view over `emb.buffer` at an
  arbitrary `byteOffset` can throw `RangeError` on 4-byte-misaligned offsets
  and aliases SQLite's internal buffer.
- Write path: `Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)`
  so a view over a larger pooled ArrayBuffer cannot leak extra bytes into
  the BLOB.

## P2 — Retrieval quality and robustness

### 7. Hybrid retrieval: vector + FTS5 BM25 with RRF fusion

Current keyword fallback is `LIKE '%…%'` substring matching. Upgrade to a
real hybrid pipeline. Verified on the shipped runtime: `node:sqlite` bundles
SQLite 3.51.3 with FTS5, `bm25()`, and the `trigram` tokenizer — **no new
dependency**. Measured caveat: trigram requires ≥3 characters per token, so
two-character CJK queries (extremely common) match nothing; the pipeline
must keep a LIKE fallback for short tokens.

- **Schema (idempotent migration on open)**: external-content FTS table
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, content='memories', content_rowid='rowid', tokenize='trigram'
  );
  ```
  maintained by AFTER INSERT/UPDATE/DELETE triggers on `memories`; existing
  databases are backfilled once on open
  (`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')` when the FTS
  row count disagrees with `memories`).
- **Pipeline**:
  1. Vector candidates (circuit closed only): cosine over the user's stored
     vectors, candidate gate `score >= 0.1`, top 20.
  2. Keyword candidates: every query token ≥3 chars → FTS5 `MATCH` ranked by
     `bm25()`, top 20; any shorter token or any FTS error → LIKE fallback
     (unchanged behavior for that branch).
  3. Fuse with Reciprocal Rank Fusion (`k = 60`), cut by rank at `top_k = 6`.
     No absolute score threshold after fusion — RRF scores are rank-based;
     the existing fixed `minScore` becomes only the vector candidate gate.
- **Rerank hook, interface only**: pipeline shape is
  `candidates → fuse → [rerank?: (query, candidates) → candidates] → top_k`.
  The hook defaults to undefined; no reranker is implemented. This keeps the
  door open for a data-driven reranker later without a pipeline rewrite.

### 8. Repository-scope recall semantics (product decision)

`repository_slug` is stored but never used in search. Decision:

- Scoped queries (scope carries a slug — Hook paths):
  `WHERE user_id = ? AND (repository_slug = ? OR repository_slug IS NULL)` —
  repository memories plus global memories.
- Unscoped queries (CLI without a slug): all rows for the user.
- Applies identically to vector and keyword candidate queries. Documented in
  ARCHITECTURE.md scope section; a future `global_search` toggle is out of
  scope.

### 9. Explicit `api_key_env` in `embedding.json`

The `/^[A-Z][A-Z0-9_]+$/` heuristic misreads all-uppercase literal keys as
environment variable names. Replace with an explicit field:

- Resolution priority: `api_key_env` (names an env var) → `api_key`
  (literal) → `ARKCODINGPLAN_API_KEY` env default.
- The regex heuristic is removed. The feature is unreleased on this branch,
  so no migration path is needed; `docs/configuration.md` documents only the
  new behavior.

### 10. File layout per the original design

Restore the designed module split: `embedding.ts` owns `embedText` and
`EmbeddingResult`; `config.ts` keeps only `loadEmbeddingConfig`;
`health.ts` imports from `embedding.ts`. Configuration parsing no longer
lives in the same module as an outbound network client.

## Out of scope (recorded decisions)

- **Writeback content distillation**: local mode stores raw joined dialogue;
  summarization quality work is a separate spec. This is the highest-leverage
  future quality improvement.
- **Reranker model**: hook interface only (P2-7). Revisit with usage data
  when per-user memory volume or measured precision justifies it.
- **Vector indexing** beyond brute force: unnecessary at personal-memory
  scale.

## Testing

Default suite is fully synthetic (stub `fetchImpl`); live Ark tests are
opt-in (P0-2).

- `store.ts`: WAL/busy-timeout pragmas applied, FTS migration on an
  old-shape database, trigger sync on insert, BLOB round-trip through a
  copied buffer, FTS ≥3-char hit, 2-char LIKE fallback.
- `health.ts`: circuit opens on first failure and stays open for the process;
  success keeps it closed; `enabled: false` never probes.
- `embedding.ts`: config parsing incl. `api_key_env` priority; stub-fetch
  success/HTTP-error/timeout paths.
- `adapter.ts`: writeback/retrieve with stub fetch; observability event
  shapes match the memorax adapter; RRF ordering across vector + keyword
  candidates; scope filter (repo + global rows returned, other-repo rows
  excluded); no-embedding degradation.
- `adapter-dispatch.ts`: routing and config priority (unchanged semantics).
- e2e: out-of-box without key; write → hybrid retrieve; idempotency dedup;
  provider switch isolation; opt-in live Ark vector path.

## Spec amendments

This spec amends `2026-09-22-local-memory-provider-design.md`:

- "Health Check and Degradation": proactive 3-attempt startup check → lazy
  circuit breaker (P1-4).
- "File layout": `embedText` lives in `embedding.ts`, not `config.ts`
  (P2-10).
- "Retrieve / Query": LIKE-only fallback → hybrid vector + FTS5 BM25 with
  RRF fusion (P2-7); fixed `min_score` becomes a vector candidate gate, not
  a post-fusion filter.
- "Embedding Client" configuration: `api_key` env-name heuristic → explicit
  `api_key_env` (P2-9).
- Storage layer: WAL + busy_timeout required (P1-6); FTS5 external-content
  table added (P2-7).
