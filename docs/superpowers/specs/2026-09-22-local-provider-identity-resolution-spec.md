# Local Provider Identity Resolution Spec

**Goal:** With the default `provider = "local"`, the system needs no MemoraX
credentials: repository scope resolution, Hook automatic writeback/retrieval,
and `memorax-cli` status/search/add all work offline out of the box.
`provider = "memorax"` keeps strict, fail-closed credential validation.

**Background:** `memoraxConfigFromEnv` unconditionally requires
`MEMORAX_CODE_MEMORAX_API_KEY` and `MEMORAX_CODE_MEMORAX_USER_ID`.
`resolveConfiguredRepositoryMemory(ForSession)` gates on its success and
returns `config_missing`, so in local mode every Hook memory operation is
silently skipped for users without a MemoraX account (proven by the
out-of-box case in
`test/clients/codex/codex-local-memory-e2e.test.mjs`).

**Decision:** Option 2 — make `memoraxConfigFromEnv` provider-aware. The
alternative (a local identity fallback inside `repository-session.ts` plus a
new `MEMORAX_CODE_LOCAL_USER_ID` knob) was rejected because it only fixes the
scope gate, leaves CLI status/add paths inconsistent, and adds configuration
surface; a single authoritative gate keeps every entry point uniform for a
local-first product.

## Design

### 1. Single provider-resolution helper in `src/config/memorax-code.ts`

The module that owns the `memory.provider` schema also owns its resolution:

```
resolveMemoryProvider(env, fileConfig?): string
  = env.MEMORAX_CODE_MEMORY_PROVIDER?.trim()
    || fileConfig.memory?.provider
    || "local"
```

`adapter-dispatch.ts` switches to this helper, deleting its inline copy.
Routing semantics unchanged: exactly `"local"` → local provider; any other
value → memorax provider (which validates fail-closed).

### 2. Provider-aware validation in `memoraxConfigFromEnv`

| Resolved provider | api_key | user_id | Result |
|---|---|---|---|
| `local` | missing | missing | ok; `userId = "local-user"` |
| `local` | missing | set (env or file) | ok; `userId = <set>` |
| `local` | set | any | ok; key retained but unused |
| `memorax` | missing | any | error (unchanged) |
| `memorax` | set | missing | error (unchanged) |

- Local identity precedence: `MEMORAX_CODE_MEMORAX_USER_ID` env >
  `memorax.user_id` in config.toml > `"local-user"`. No new config knob.
- `MemoraxAdapterConfig` gains a required `provider: "local" | "memorax"`
  field so the conditional contract is explicit and auditable. The only
  production constructor is `memoraxConfigFromEnv`; test constructors are
  updated mechanically.
- Local mode must not relax memorax-mode validation: `provider = "memorax"`
  with missing credentials errors exactly as today.

### 3. Callers

- `repository-session.ts`: unchanged — inherits local tolerance; scope
  invariants preserved (`baseUserId = "local-user"` still pins session
  bindings; mismatch and mismatch-latch behavior untouched).
- `automatic-writeback.ts`: unchanged (already tolerant of config failure).
- `provider/memorax/adapter.ts`: unchanged — only reached when dispatch
  routes to memorax, where validation stayed strict; the `options.config`
  short-circuit is unaffected.
- `memoryConfigStatus` (`config.ts:309`): `status.provider` reports the
  resolved provider instead of the hardcoded memorax id; local mode with
  the default identity reports `configured: true` and surfaces
  `userId: "local-user"` so status output is not misleading.

## Boundaries

- No new outbound authority; the local identity never crosses the network
  (the local provider is its only consumer in local mode).
- Docs: `docs/configuration.md` documents `user_id` semantics in local mode
  and the `"local-user"` default; ARCHITECTURE.md scope-identity wording is
  updated in the same change. README bilingual sync not required (no
  onboarding change).
- Out of scope: removing the memorax provider (remains an opt-in fallback);
  this spec does not block a future full removal.

## Testing

- `test/provider/memorax/memorax-config.test.mjs`: strict-validation cases
  pin `MEMORAX_CODE_MEMORY_PROVIDER=memorax` (mechanical, follows the commit
  `63239be` pattern); new local-mode cases for the matrix above, including
  file-config provider selection and user_id override precedence.
- `test/repository/repository-memory-scope.test.mjs`: out-of-box resolution
  succeeds; `effectiveUserId = "local-user@<scope>"`; binding and mismatch
  invariants hold with the default identity.
- `test/memory/memory-cli.test.mjs`: local-mode out-of-box
  status/search/add.
- `test/provider/local/dispatch.test.mjs`: helper-based routing; unknown
  provider strings still fall through to memorax fail-closed validation.
- **Acceptance:** the out-of-box case in
  `test/clients/codex/codex-local-memory-e2e.test.mjs` turns green.
- All suites pinned to memorax in `63239be` keep their behavior unchanged.

## Verification

Backend profile (`npm run typecheck --prefix packages/ts/memorax-code-backend`
and `npm test --prefix packages/ts/memorax-code-backend`) plus the
Documentation profile (`make docs-check`) for the configuration and
architecture edits.

## Risks and mitigations

- **Contract smell** — a memorax-named config may carry an empty apiKey.
  Mitigated by the required `provider` field; any future caller must branch
  on it explicitly.
- **Drift between dispatch and config validation** — eliminated by the
  shared `resolveMemoryProvider` helper (this also removes pre-existing
  duplication between `adapter-dispatch.ts` and the config layer).
- **Status confusion** — `memoryConfigStatus` must not show memorax-shaped
  "configured" output in local mode; covered by the status changes above
  and their tests.
