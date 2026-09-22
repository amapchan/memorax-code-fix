import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEmbeddingHealth } from "../../../dist/provider/local/health.js";

const ARK_KEY = process.env.ARKCODINGPLAN_API_KEY;
const LIVE = process.env.MEMORAX_CODE_LIVE_EMBEDDING_TEST === "1" && ARK_KEY;

function liveConfig() {
  return {
    enabled: true, apiKey: ARK_KEY,
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-embedding-vision", timeoutMs: 5000,
  };
}

test("health check returns true for valid Ark API", { skip: !LIVE }, async () => {
  const result = await checkEmbeddingHealth(liveConfig());
  assert.equal(result, true);
});

test("health check returns true via stub fetch", async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1] }] }) };
  };
  const result = await checkEmbeddingHealth({ ...liveConfig(), apiKey: "stub" }, fetchImpl);
  assert.equal(result, true);
  assert.equal(calls.length, 1);
});

test("health check returns false when all attempts fail", async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const result = await checkEmbeddingHealth({ ...liveConfig(), apiKey: "stub" }, fetchImpl);
  assert.equal(result, false);
  assert.equal(calls.length, 3);
});

test("health check returns false when disabled", async () => {
  const config = { enabled: false, apiKey: "", baseUrl: "", model: "", timeoutMs: 100 };
  const result = await checkEmbeddingHealth(config);
  assert.equal(result, false);
});
