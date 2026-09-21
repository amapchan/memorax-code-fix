import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEmbeddingHealth } from "../../../dist/provider/local/health.js";

const ARK_KEY = process.env.ARKCODINGPLAN_API_KEY;

test("health check returns true for valid Ark API", { skip: !ARK_KEY }, async () => {
  const config = {
    enabled: true, apiKey: ARK_KEY,
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-embedding-vision", timeoutMs: 5000,
  };
  const result = await checkEmbeddingHealth(config);
  assert.equal(result, true);
});

test("health check returns false for unreachable endpoint", async () => {
  const config = {
    enabled: true, apiKey: "test",
    baseUrl: "http://localhost:1", model: "test",
    timeoutMs: 500,
  };
  const result = await checkEmbeddingHealth(config);
  assert.equal(result, false);
});

test("health check returns false when disabled", async () => {
  const config = {
    enabled: false, apiKey: "", baseUrl: "", model: "", timeoutMs: 100,
  };
  const result = await checkEmbeddingHealth(config);
  assert.equal(result, false);
});
