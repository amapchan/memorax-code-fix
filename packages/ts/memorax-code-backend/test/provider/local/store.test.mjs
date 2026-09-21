import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMemoryStore } from "../../../dist/provider/local/store.js";

function testScope() {
  return {
    baseUserId: "user-1",
    effectiveUserId: "user-1@test-repo",
    repositorySlug: "test-repo",
  };
}

test("insertMemory stores and retrieves a memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const id = store.insertMemory({
      scope,
      content: "Uses TypeScript strict mode",
      memoryType: "semantic",
      idempotencyKey: "test-key-1",
      sessionId: "session-1",
      embedding: null,
      embeddingDimensions: null,
      embeddingModel: null,
    });
    assert.ok(id);
    const results = store.searchByKeyword({ scope, query: "TypeScript", topK: 5 });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "Uses TypeScript strict mode");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idempotency key prevents duplicate insert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const params = {
      scope, content: "test content", memoryType: "semantic",
      idempotencyKey: "dup-key", sessionId: "s1",
      embedding: null, embeddingDimensions: null, embeddingModel: null,
    };
    store.insertMemory(params);
    assert.throws(() => store.insertMemory(params), /UNIQUE constraint/);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchByVector returns nearest memories by cosine similarity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const v1 = new Float32Array([1, 0, 0]);
    const v2 = new Float32Array([0, 1, 0]);
    store.insertMemory({ scope, content: "aligned", memoryType: "semantic",
      idempotencyKey: "k1", sessionId: "s1",
      embedding: Buffer.from(v1.buffer), embeddingDimensions: 3, embeddingModel: "test" });
    store.insertMemory({ scope, content: "orthogonal", memoryType: "semantic",
      idempotencyKey: "k2", sessionId: "s1",
      embedding: Buffer.from(v2.buffer), embeddingDimensions: 3, embeddingModel: "test" });
    const results = store.searchByVector({ scope, queryVector: v1, topK: 2, minScore: 0 });
    assert.equal(results.length, 2);
    assert.equal(results[0].content, "aligned");
    assert.ok(results[0].score > 0.99);
    assert.ok(results[1].score < 0.01);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
