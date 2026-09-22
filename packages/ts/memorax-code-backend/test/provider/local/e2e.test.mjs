import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { invokeMemoryProvider } from "../../../dist/provider/adapter-dispatch.js";

const ARK_KEY = process.env.ARKCODINGPLAN_API_KEY;

function testScope() {
  return { schemaVersion: "workspace-memory-scope.v1", baseUserId: "e2e-user",
    effectiveUserId: "e2e-user@e2e-repo", repositoryKey: "e2e-repo",
    repositorySlug: "e2e-repo", repositoryName: "e2e-repo",
    identitySource: "origin-remote", scopeKind: "git-repository",
    boundWorkspaceRoot: "/e2e" };
}

function opts(home, scope) {
  return { env: { MEMORAX_CODE_HOME: home, ...(ARK_KEY ? { ARKCODINGPLAN_API_KEY: ARK_KEY } : {}) }, repositoryScope: scope };
}

test("E2E: writeback, retrieve, idempotency, vector search", { skip: !ARK_KEY }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-e2e-"));
  try {
    const scope = testScope();
    const write = await invokeMemoryProvider(
      { sessionId: "e2e-s1", prompt: "seed" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "writeback",
        context: { idempotencyKey: "e2e-wb-1",
          messages: [
            { role: "user", content: "How does the build system work?" },
            { role: "assistant", content: "The build system uses TypeScript compilation with tsc, then stages artifacts for npm packaging." },
          ] } },
      opts(dir, scope),
    );
    assert.ok(write.ok, `writeback failed: ${write.ok ? "" : write.error}`);

    const search = await invokeMemoryProvider(
      { sessionId: "e2e-s1", prompt: "build system" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "retrieve", query: "build system" },
      opts(dir, scope),
    );
    assert.ok(search.ok);
    assert.ok(search.result.tool_result_payload.items.length > 0);

    const vectorSearch = await invokeMemoryProvider(
      { sessionId: "e2e-s1", prompt: "how is code compiled" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "retrieve", query: "how is code compiled and packaged" },
      opts(dir, scope),
    );
    assert.ok(vectorSearch.ok);
    assert.ok(vectorSearch.result.tool_result_payload.items.length > 0);

    const dup = await invokeMemoryProvider(
      { sessionId: "e2e-s1", prompt: "seed" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "writeback",
        context: { idempotencyKey: "e2e-wb-1",
          messages: [{ role: "assistant", content: "Duplicate message." }] } },
      opts(dir, scope),
    );
    assert.ok(dup.ok);

    const final = await invokeMemoryProvider(
      { sessionId: "e2e-s1", prompt: "build" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "retrieve", query: "build system" },
      opts(dir, scope),
    );
    assert.ok(final.ok);
    assert.equal(final.result.tool_result_payload.items.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2E: out-of-box works without API key (keyword-only)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-e2e-nokey-"));
  try {
    const scope = testScope();
    const noKeyOpts = { env: { MEMORAX_CODE_HOME: dir, ARKCODINGPLAN_API_KEY: "" }, repositoryScope: scope };
    const write = await invokeMemoryProvider(
      { sessionId: "s1", prompt: "seed" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "writeback",
        context: { idempotencyKey: "nokey-1",
          messages: [{ role: "assistant", content: "Uses Docker for containerization." }] } },
      noKeyOpts,
    );
    assert.ok(write.ok);
    const search = await invokeMemoryProvider(
      { sessionId: "s1", prompt: "Docker" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "retrieve", query: "Docker" },
      noKeyOpts,
    );
    assert.ok(search.ok);
    assert.ok(search.result.tool_result_payload.items.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
