import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runMemoryCli } from "../../../dist/memory/cli.js";
import { createCodexMemoryHookRuntime } from "../../../dist/clients/codex/memory-hook-runtime.js";
import { waitFor, writeRollout } from "./support/memory-hook-fixtures.mjs";

// End-to-end coverage for the Codex client memory chain against the local
// provider: Hook turn-start -> Hook Stop writeback -> SQLite storage ->
// Hook turn-start retrieval injection -> memorax-cli search/add. Other
// clients share the same harness runtime and provider dispatch, so their
// chains are equivalent and not duplicated here.

function localProviderEnv(root, extra = {}) {
  return {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORY_PROVIDER: "local",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    ...extra,
  };
}

async function readStoredMemories(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT user_id, content, memory_type, repository_slug FROM memories").all();
  } finally {
    db.close();
  }
}

test("Codex local chain: hook writeback, hook retrieval, CLI search and add", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-local-e2e-"));
  const workspace = join(root, "notes");
  await mkdir(workspace, { recursive: true });
  // Deterministic keyword/hybrid path: embedding explicitly disabled.
  await writeFile(join(root, "embedding.json"), JSON.stringify({ enabled: false }), "utf8");
  const env = localProviderEnv(root, {
    // Scope identity still comes from the memorax config fields today.
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  });
  const transcriptPath = await writeRollout(root, "session-local-e2e", [{
    turnId: "turn-local-1",
    prompt: "How do I deploy staging with terraform?",
    reply: "Use terraform plan then apply in the staging workspace.",
  }]);
  const events = [];
  const controller = createCodexMemoryHookRuntime({
    env,
    memoraxCodeHome: root,
    memoryObservability: { recordEvent: (event) => events.push(event) },
  });
  try {
    // Turn 1: empty store, so turn-start has nothing to inject.
    assert.deepEqual(await controller.recordTurnStart({
      sessionId: "session-local-e2e",
      turnId: "turn-local-1",
      prompt: "How do I deploy staging with terraform?",
      cwd: workspace,
      transcriptPath,
    }), { ok: true });

    // Stop: the exact rollout turn is written back to local SQLite.
    assert.deepEqual(await controller.writeback({
      sessionId: "session-local-e2e",
      turnId: "turn-local-1",
      lastAssistantMessage: "Use terraform plan then apply in the staging workspace.",
      cwd: workspace,
      transcriptPath,
    }), { ok: true, scheduled: true });

    const dbPath = join(root, "local-memory.db");
    let rows = [];
    await waitFor(async () => {
      try {
        rows = await readStoredMemories(dbPath);
      } catch {
        return false;
      }
      return rows.some((row) => String(row.content).includes("terraform plan"));
    }, "hook writeback did not land in the local SQLite store");
    const stored = rows.find((row) => String(row.content).includes("terraform plan"));
    assert.equal(stored.user_id, "user-1@notes");
    assert.equal(stored.memory_type, "semantic");
    assert.match(stored.content, /user: How do I deploy staging with terraform\?/);
    assert.match(stored.content, /assistant: Use terraform plan then apply/);

    // Turn 2: the same session recalls the stored turn through the local
    // provider and injects it as hidden context.
    const recalled = await controller.recordTurnStart({
      sessionId: "session-local-e2e",
      turnId: "turn-local-2",
      prompt: "What are the terraform staging deploy steps?",
      cwd: workspace,
      transcriptPath,
    });
    assert.equal(recalled.ok, true);
    assert.match(recalled.additionalContext, /terraform plan then apply/);

    // Observability parity: both hook operations emitted events.
    assert.ok(events.some((event) => event.operation === "writeback" && event.ok), "missing writeback event");
    assert.ok(events.some((event) => event.operation === "retrieve" && event.ok), "missing retrieve event");

    // CLI search reads the hook-written memory from the same store.
    const search = await runMemoryCli(["search", "--query", "terraform staging"], { cwd: workspace, env });
    assert.equal(search.ok, true, `CLI search failed: ${JSON.stringify(search)}`);
    assert.match(JSON.stringify(search), /terraform plan then apply/);

    // CLI add writes an explicit memory through the local provider.
    const added = await runMemoryCli([
      "add", "--memory", "Grafana dashboards watch deploy health.", "--type", "semantic", "--reason", "E2E explicit save.",
    ], { cwd: workspace, env });
    assert.equal(added.ok, true, `CLI add failed: ${JSON.stringify(added)}`);

    const grafana = await runMemoryCli(["search", "--query", "grafana dashboards"], { cwd: workspace, env });
    assert.equal(grafana.ok, true);
    assert.match(JSON.stringify(grafana), /Grafana dashboards watch deploy health/);

    rows = await readStoredMemories(dbPath);
    assert.equal(rows.length, 2);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex local chain works out-of-box without MemoraX credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-local-oob-"));
  const workspace = join(root, "notes");
  await mkdir(workspace, { recursive: true });
  // No memorax api key/user id, no embedding key: the default local provider
  // must still capture and recall memory. Spec: local is the default
  // provider and the system runs fully offline out of the box.
  const env = localProviderEnv(root, {
    MEMORAX_CODE_MEMORAX_API_KEY: undefined,
    MEMORAX_CODE_MEMORAX_USER_ID: undefined,
    ARKCODINGPLAN_API_KEY: "",
  });
  const transcriptPath = await writeRollout(root, "session-local-oob", [{
    turnId: "turn-oob-1",
    prompt: "Remember the offline onboarding flow.",
    reply: "Offline onboarding stores memory locally.",
  }]);
  const controller = createCodexMemoryHookRuntime({ env, memoraxCodeHome: root });
  try {
    await controller.recordTurnStart({
      sessionId: "session-local-oob",
      turnId: "turn-oob-1",
      prompt: "Remember the offline onboarding flow.",
      cwd: workspace,
      transcriptPath,
    });
    const written = await controller.writeback({
      sessionId: "session-local-oob",
      turnId: "turn-oob-1",
      lastAssistantMessage: "Offline onboarding stores memory locally.",
      cwd: workspace,
      transcriptPath,
    });
    assert.deepEqual(written, { ok: true, scheduled: true });

    const dbPath = join(root, "local-memory.db");
    await waitFor(async () => {
      try {
        return (await readStoredMemories(dbPath)).some((row) => String(row.content).includes("offline onboarding"));
      } catch {
        return false;
      }
    }, "out-of-box writeback did not land in the local SQLite store");

    const recalled = await controller.recordTurnStart({
      sessionId: "session-local-oob",
      turnId: "turn-oob-2",
      prompt: "What is the offline onboarding flow?",
      cwd: workspace,
      transcriptPath,
    });
    assert.equal(recalled.ok, true);
    assert.match(recalled.additionalContext, /offline onboarding/i);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
