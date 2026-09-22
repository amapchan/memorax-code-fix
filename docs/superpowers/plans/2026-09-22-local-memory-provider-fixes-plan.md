# Local Memory Provider Fixes Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Bring the local memory provider to release quality: fix the Node
engine conflict and the Windows test crash, align runtime behavior with the
approved review (lazy circuit breaker, observability parity, SQLite
hardening, hybrid FTS5+vector retrieval), and rewrite the architecture and
user-facing docs for the local-first memory architecture in the same change
set.

**Spec:** `docs/superpowers/specs/2026-09-22-local-memory-provider-fixes-spec.md`

**Baseline state:** the provider chain already builds and passes 19/20 local
provider tests on Windows (Node v24.15.0); the one failure is the
force-exit crash fixed in Task 2.

## Global Constraints

- No new npm dependencies. FTS5/trigram/`bm25()` ship inside `node:sqlite`
  (verified: bundled SQLite 3.51.3).
- `provider/memorax/` stays untouched; dispatch semantics unchanged.
- Tests import from `dist/` (compiled), run with `node:test` +
  `node:assert/strict`.
- Default tests are fully synthetic: embedding network access goes through
  an injected `fetchImpl` stub. Live Ark API tests require
  `MEMORAX_CODE_LIVE_EMBEDDING_TEST=1` **and** `ARKCODINGPLAN_API_KEY`.
- Node engine floor becomes `>=22.13` (Task 1). All later tasks assume it.
- Documentation edits are part of this change set, not follow-ups: Task 8
  must complete before the branch merges (AGENTS.md §2, ARCHITECTURE.md §9).
- Commit titles: `type:(module) content`, lowercase-kebab branch
  (`fix/provider-local-hardening` suggested); separate mechanical moves from
  behavior changes (Task 7 has its own commit).
- Do not log or commit API keys.

---

### Task 1: Raise the Node engine floor to >=22.13

**Files:**
- Modify: `packages/npm/memorax-code/package.json` — `engines.node` → `>=22.13`
- Audit/modify: every other `package.json` carrying `engines`
- Modify: `packages/ts/memorax-code-backend/package.json` — `@types/node` to a matching major
- Modify: `README.md`, `README.zh.md`, `docs/configuration.md` — Node prerequisite
- Audit: `.github/workflows` Node matrix

- [ ] **Step 1: Audit current declarations**

  Run: `Select-String -Path (Get-ChildItem -Recurse -Filter package.json).FullName -Pattern '"engines"' -Context 0,2`
  and inspect `.github/workflows/*` for `node-version`.
  Expected: authoritative list of every engine declaration and CI Node version.

- [ ] **Step 2: Bump engine floor and type definitions**

  `engines.node` → `>=22.13` in the npm package and any other package that
  declares engines. Bump `@types/node` in the Backend package to the
  matching major and refresh its lockfile entry only (no broad lockfile
  rewrite).

- [ ] **Step 3: Update docs and CI matrix**

  README/README.zh prerequisites and `docs/configuration.md` state Node
  >=22.13 with one sentence of rationale (`node:sqlite`). CI matrix drops
  anything below the floor.

- [ ] **Step 4: Verify**

  Backend profile:
  `npm run typecheck --prefix packages/ts/memorax-code-backend` and
  `npm test --prefix packages/ts/memorax-code-backend`.
  Documentation profile: `make docs-check`.
  Expected: PASS (behavior unchanged).

- [ ] **Step 5: Commit**

  ```
  git add packages/npm/memorax-code/package.json packages/ts/memorax-code-backend/package.json README.md README.zh.md docs/configuration.md .github
  git commit -m "chore:(npm) raise node engine floor to >=22.13 for node:sqlite"
  ```

---

### Task 2: Injectable fetch + synthetic network tests (fix Windows force-exit crash)

**Files:**
- Modify: `packages/ts/memorax-code-backend/src/provider/local/config.ts` — `embedText` gains `fetchImpl?`
- Modify: `packages/ts/memorax-code-backend/test/provider/local/embedding.test.mjs`
- Modify: `packages/ts/memorax-code-backend/test/provider/local/health.test.mjs`
- Modify: `packages/ts/memorax-code-backend/test/provider/local/e2e.test.mjs`

**Interfaces:**
- `embedText(text: string, config: EmbeddingConfig, fetchImpl?: typeof fetch): Promise<EmbeddingResult>`

- [ ] **Step 1: Write the failing test**

  Add to `embedding.test.mjs`: a stub `fetchImpl` returning a canned
  `{ data: [{ embedding: [0.1, 0.2, ...] }] }` response — assert vector
  parsing without any socket; a stub returning HTTP 401 — assert
  `{ ok: false }`. Gate every live Ark test behind
  `MEMORAX_CODE_LIVE_EMBEDDING_TEST=1` and `ARKCODINGPLAN_API_KEY`.

- [ ] **Step 2: Run test to verify it fails**

  Run: `cd packages/ts/memorax-code-backend; .\node_modules\.bin\tsc.cmd; node --test test/provider/local/embedding.test.mjs`
  Expected: FAIL (embedText ignores injected fetch).

- [ ] **Step 3: Implement**

  Thread `fetchImpl` (default global `fetch`) through `embedText` in
  `config.ts` (it moves to `embedding.ts` in Task 7 — implement in place
  now to keep this commit behavioral-only). Convert all default tests to
  stub fetch; wrap live tests in the opt-in gate.

- [ ] **Step 4: Verify the crash is gone**

  Run: `npm test --prefix packages/ts/memorax-code-backend` (uses
  `--test-force-exit`) on Windows.
  Expected: all PASS, no libuv assertion, no live sockets in the default
  suite.

- [ ] **Step 5: Commit**

  ```
  git add packages/ts/memorax-code-backend/src/provider/local/config.ts packages/ts/memorax-code-backend/test/provider/local
  git commit -m "fix:(backend) inject fetch into embedding client and make network tests synthetic"
  ```

---

### Task 3: Lazy circuit breaker replaces per-call health checks

**Files:**
- Modify: `packages/ts/memorax-code-backend/src/provider/local/health.ts`
- Modify: `packages/ts/memorax-code-backend/src/provider/local/adapter.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/health.test.mjs`
- Test: `packages/ts/memorax-code-backend/test/provider/local/adapter.test.mjs`

**Interfaces:**
- `embeddingCircuit: { isOpen(config: EmbeddingConfig): boolean; recordSuccess(config): void; recordFailure(config): void; resetForTests(): void }`
  (process-lifetime, in-memory, keyed by resolved config fingerprint)

- [ ] **Step 1: Write the failing test**

  `health.test.mjs`: with a stub fetch that fails once then succeeds —
  after `recordFailure` the circuit `isOpen`; `resetForTests` clears it;
  `enabled: false` configs never probe. `adapter.test.mjs`: retrieve with a
  failing stub fetch falls back to keyword results **without** a second
  fetch call on the next retrieve (assert stub call count stays 1).

- [ ] **Step 2: Run test to verify it fails**

  Expected: FAIL (adapter calls `checkEmbeddingHealth` per operation).

- [ ] **Step 3: Implement**

  Rewrite `health.ts` as the circuit-state module above. In `adapter.ts`
  delete both `checkEmbeddingHealth` call sites; writeback/retrieve call
  `embedText` only when `!circuit.isOpen(config)`, then record the outcome.
  Degradation matrix unchanged.

- [ ] **Step 4: Verify**

  `npm test --prefix packages/ts/memorax-code-backend`
  Expected: PASS; stub call counts prove one probe per process.

- [ ] **Step 5: Commit**

  ```
  git add packages/ts/memorax-code-backend/src/provider/local/health.ts packages/ts/memorax-code-backend/src/provider/local/adapter.ts packages/ts/memorax-code-backend/test/provider/local
  git commit -m "fix:(backend) replace per-call health checks with lazy embedding circuit breaker"
  ```

---

### Task 4: Observability parity for the local adapter

**Files:**
- Modify: `packages/ts/memorax-code-backend/src/provider/local/adapter.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/adapter.test.mjs`

- [ ] **Step 1: Write the failing test**

  Capture the injected `observability` hook during writeback and retrieve;
  assert the event shape matches the memorax adapter's
  (`recordMemoryObservabilityEvent` fields: operation, ok, request slot,
  response receipt id/items/contextBlocks) with `provider_id`
  `memory.local`.

- [ ] **Step 2: Run test to verify it fails**

  Expected: FAIL (no events emitted).

- [ ] **Step 3: Implement**

  Emit observability events on success and failure paths, mirroring
  `provider/memorax/adapter.ts`; receipt ids `local:<idempotencyKey|uuid>`;
  diagnostic fields (latency, counts, skip/error) match the memorax path.

- [ ] **Step 4: Verify**

  `npm test --prefix packages/ts/memorax-code-backend`
  Expected: PASS including existing memorax observability contracts.

- [ ] **Step 5: Commit**

  ```
  git add packages/ts/memorax-code-backend/src/provider/local/adapter.ts packages/ts/memorax-code-backend/test/provider/local/adapter.test.mjs
  git commit -m "fix:(backend) emit observability events from local memory adapter"
  ```

---

### Task 5: SQLite WAL, busy timeout, and BLOB copy hardening

**Files:**
- Modify: `packages/ts/memorax-code-backend/src/provider/local/store.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/store.test.mjs`

- [ ] **Step 1: Write the failing test**

  `store.test.mjs`: after open, `PRAGMA journal_mode` returns `wal` and
  `PRAGMA busy_timeout` returns `2000`; a vector written from a
  `Float32Array` view over a larger pooled buffer round-trips with exact
  length and values (no slab leakage); a stored BLOB read back produces a
  correctly aligned `Float32Array` regardless of source offset.

- [ ] **Step 2: Run test to verify it fails**

  Expected: FAIL on pragmas (and potentially on alignment).

- [ ] **Step 3: Implement**

  In the `LocalMemoryStore` constructor: `PRAGMA journal_mode=WAL;` and
  `PRAGMA busy_timeout=2000;` before table creation. Write path:
  `Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)`.
  Read path: `const copy = Buffer.from(row.embedding)` before constructing
  the `Float32Array` view.

- [ ] **Step 4: Verify**

  `npm test --prefix packages/ts/memorax-code-backend`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```
  git add packages/ts/memorax-code-backend/src/provider/local/store.ts packages/ts/memorax-code-backend/test/provider/local/store.test.mjs
  git commit -m "fix:(backend) enable WAL and busy timeout and copy embedding buffers in local store"
  ```

---

### Task 6: Hybrid retrieval — FTS5 BM25 + vector with RRF fusion

**Files:**
- Modify: `packages/ts/memorax-code-backend/src/provider/local/store.ts`
- Modify: `packages/ts/memorax-code-backend/src/provider/local/adapter.ts`
- Test: `packages/ts/memorax-code-backend/test/provider/local/store.test.mjs`
- Test: `packages/ts/memorax-code-backend/test/provider/local/adapter.test.mjs`
- Test: `packages/ts/memorax-code-backend/test/provider/local/e2e.test.mjs`

**Interfaces:**
- `searchHybrid({ scope, query, queryVector?: Float32Array, topK, candidateLimit? }): StoredMemory[]`
- Rerank hook shape (interface only, default undefined):
  `rerank?: (query: string, candidates: StoredMemory[]) => StoredMemory[]`

- [ ] **Step 1: Write the failing test**

  `store.test.mjs`:
  1. Migration: open a database pre-populated with the old shape (memories
     only); assert `memories_fts` is created and backfilled.
  2. FTS hit: insert "fstab 挂载配置修复流程", query "挂载配置" (≥3 chars)
     returns it via FTS rank.
  3. Short-token fallback: query "挂载" (2 chars) still returns it via the
     LIKE branch.
  4. Scope filter: rows from another `repository_slug` are excluded;
     `repository_slug IS NULL` (global) rows are included in scoped
     queries.

  `adapter.test.mjs`: RRF ordering — a document strong only in vector and
  one strong only in keyword both outrank an unrelated document; rerank
  hook receives fused candidates when provided.

- [ ] **Step 2: Run test to verify it fails**

  Expected: FAIL (`searchHybrid` and the FTS table do not exist).

- [ ] **Step 3: Implement**

  `store.ts`:
  - Idempotent migration on open: create `memories_fts` external-content
    table (`content='memories'`, `content_rowid='rowid'`,
    `tokenize='trigram'`), AFTER INSERT/UPDATE/DELETE triggers, and rebuild
    when FTS row count disagrees with `memories`.
  - `searchHybrid`: vector candidates (when `queryVector` given, gate
    cosine ≥ 0.1, top 20) + keyword candidates (all query tokens ≥3 chars
    → FTS5 `MATCH` ordered by `bm25()`, top 20; any shorter token or FTS
    error → LIKE branch) → RRF (`k = 60`) → rank cutoff at `topK`.
  - All candidate queries filter
    `user_id = ? AND (repository_slug = ? OR repository_slug IS NULL)` when
    the scope carries a slug; `user_id = ?` otherwise.

  `adapter.ts`: route retrieve through `searchHybrid`; embed the query only
  when the circuit is closed; pass the optional rerank hook through options
  (undefined by default); drop the post-fusion absolute `minScore`.

- [ ] **Step 4: Verify**

  `npm test --prefix packages/ts/memorax-code-backend`
  Expected: PASS, including the degradation e2e (no key → LIKE/FTS path).

- [ ] **Step 5: Commit**

  ```
  git add packages/ts/memorax-code-backend/src/provider/local/store.ts packages/ts/memorax-code-backend/src/provider/local/adapter.ts packages/ts/memorax-code-backend/test/provider/local
  git commit -m "feat:(backend) add hybrid FTS5 and vector retrieval with RRF fusion"
  ```

---

### Task 7: `api_key_env` config field + embedding.ts module split

**Files:**
- Modify: `packages/ts/memorax-code-backend/src/provider/local/config.ts` — drop regex heuristic, add `api_key_env`
- Create: `packages/ts/memorax-code-backend/src/provider/local/embedding.ts` — receives `embedText`/`EmbeddingResult`
- Modify: `packages/ts/memorax-code-backend/src/provider/local/health.ts`, `adapter.ts` — import updates
- Test: `packages/ts/memorax-code-backend/test/provider/local/embedding.test.mjs`

- [ ] **Step 1: Write the failing test**

  `embedding.test.mjs`: `api_key_env: "MY_KEY"` resolves from
  `env.MY_KEY`; literal `api_key` is used verbatim even when all-uppercase;
  priority `api_key_env` > `api_key` > `ARKCODINGPLAN_API_KEY`.

- [ ] **Step 2: Run test to verify it fails**

  Expected: FAIL (heuristic treats the literal as an env name).

- [ ] **Step 3: Implement**

  Two commits, mechanical first:
  a. Move `embedText`/`EmbeddingResult` from `config.ts` to `embedding.ts`;
     update imports in `health.ts`/`adapter.ts`; no behavior change.
  b. Implement `api_key_env` priority and delete the regex heuristic.

- [ ] **Step 4: Verify**

  `npm test --prefix packages/ts/memorax-code-backend`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```
  git add packages/ts/memorax-code-backend/src/provider/local
  git commit -m "refactor:(backend) split embedding client out of local config module"
  git commit -m "fix:(backend) add explicit api_key_env resolution for embedding config"
  ```

---

### Task 8: Architecture and documentation rewrite (merge gate)

**Files:**
- Modify: `ARCHITECTURE.md` — §2 diagram/component table, §6.2 state classes,
  §6.3 local-only outbound exception, §8 test routing (`src/provider/local`
  → `test/provider/local`)
- Modify: `SECURITY.md` — register `local-memory.db` and the embedding
  outbound path under local data & diagnostics
- Modify: `docs/configuration.md` — `[memory].provider` (TOML), every
  `embedding.json` field including `api_key_env`, degradation behavior,
  hybrid retrieval notes, Node >=22.13
- Modify: `README.md`, `README.zh.md` — local-first memory onboarding,
  bilingual sync

- [ ] **Step 1: Rewrite ARCHITECTURE.md memory boundaries**

  Provider dispatch owns routing; MemoraX is opt-in remote; embedding API is
  a reviewed outbound exception (payload = text to embed, nothing stored,
  user-disableable); `local-memory.db` is durable cross-process state whose
  locking invariant is satisfied by WAL + `busy_timeout`; scope recall
  semantics from spec §P2-8 are recorded.

- [ ] **Step 2: Update SECURITY.md and configuration docs**

- [ ] **Step 3: Sync README bilingual onboarding**

- [ ] **Step 4: Verify**

  Documentation profile: `make docs-check`.
  Expected: PASS (links, public paths, shipped-doc registration, README
  sync).

- [ ] **Step 5: Commit**

  ```
  git add ARCHITECTURE.md SECURITY.md docs/configuration.md README.md README.zh.md
  git commit -m "docs:(architecture) rewrite memory boundaries for local-first provider"
  ```

---

### Task 9: Full verification sweep

- [ ] **Step 1: Backend profile**

  `npm run typecheck --prefix packages/ts/memorax-code-backend` and
  `npm test --prefix packages/ts/memorax-code-backend`
  Expected: all PASS on Windows with `--test-force-exit`.

- [ ] **Step 2: Trace/local-only boundary**

  `make test-npm-package` — the new embedding outbound path must be
  documented (Task 8) and trace-core modules stay network-free.
  Expected: PASS.

- [ ] **Step 3: Opt-in live Ark e2e (reported separately)**

  `MEMORAX_CODE_LIVE_EMBEDDING_TEST=1 node --test --test-timeout=10000 "test/provider/local/*.test.mjs"`
  from `packages/ts/memorax-code-backend`.
  Expected: PASS; record platform and scenarios in the handoff; redact
  output.

- [ ] **Step 4: Broad cross-layer (pre-merge)**

  `make test`
  Expected: PASS.

- [ ] **Step 5: Handoff report**

  Per AGENTS.md §6: behavior changes, verification performed, checks not
  run (notably native Windows package smoke and real-client suites),
  remaining risk, worktree state.
