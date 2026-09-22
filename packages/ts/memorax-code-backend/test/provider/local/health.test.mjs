import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddingCircuit } from "../../../dist/provider/local/health.js";

const ARK_KEY = process.env.ARKCODINGPLAN_API_KEY;
const LIVE = process.env.MEMORAX_CODE_LIVE_EMBEDDING_TEST === "1" && ARK_KEY;

function stubConfig(apiKey = "stub") {
  return {
    enabled: true, apiKey,
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-embedding-vision", timeoutMs: 5000,
  };
}

test("circuit starts closed and opens on first failure for the process", () => {
  embeddingCircuit.resetForTests();
  const config = stubConfig();
  assert.equal(embeddingCircuit.isOpen(config), false);
  embeddingCircuit.recordFailure(config);
  assert.equal(embeddingCircuit.isOpen(config), true);
});

test("circuit failure persists across separate config instances with same settings", () => {
  embeddingCircuit.resetForTests();
  embeddingCircuit.recordFailure(stubConfig("same-key"));
  assert.equal(embeddingCircuit.isOpen(stubConfig("same-key")), true);
});

test("circuit success keeps or returns the circuit closed", () => {
  embeddingCircuit.resetForTests();
  const config = stubConfig();
  embeddingCircuit.recordSuccess(config);
  assert.equal(embeddingCircuit.isOpen(config), false);
  embeddingCircuit.recordFailure(config);
  embeddingCircuit.recordSuccess(config);
  assert.equal(embeddingCircuit.isOpen(config), false);
});

test("circuit is per resolved config fingerprint", () => {
  embeddingCircuit.resetForTests();
  embeddingCircuit.recordFailure(stubConfig("key-a"));
  assert.equal(embeddingCircuit.isOpen(stubConfig("key-b")), false);
});

test("disabled config never probes and reports open", () => {
  const config = { enabled: false, apiKey: "", baseUrl: "", model: "", timeoutMs: 100 };
  assert.equal(embeddingCircuit.isOpen(config), true);
});

test("resetForTests clears all circuit state", () => {
  embeddingCircuit.resetForTests();
  embeddingCircuit.recordFailure(stubConfig());
  embeddingCircuit.resetForTests();
  assert.equal(embeddingCircuit.isOpen(stubConfig()), false);
});
