import { embedText, type EmbeddingConfig } from "./config.js";

const HEALTH_CHECK_ATTEMPTS = 3;
const HEALTH_CHECK_TIMEOUT_MS = 1000;

export async function checkEmbeddingHealth(
  config: EmbeddingConfig,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  if (!config.enabled) return false;
  const checkConfig: EmbeddingConfig = { ...config, timeoutMs: HEALTH_CHECK_TIMEOUT_MS };
  for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt++) {
    const result = await embedText("health-check", checkConfig, fetchImpl);
    if (result.ok) return true;
  }
  return false;
}
