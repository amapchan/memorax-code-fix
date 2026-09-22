import type { EmbeddingConfig } from "./config.js";

// Process-lifetime in-memory circuit state for the embedding service. The
// first real embedding failure opens the circuit for the rest of the process;
// while open, embedding is skipped and retrieval degrades to keyword search.
// State is never persisted: a process restart re-probes naturally. No
// proactive health-check calls are ever made.

type CircuitState = { open: boolean };

const circuits = new Map<string, CircuitState>();

function circuitKey(config: EmbeddingConfig): string {
  return [config.enabled, config.apiKey, config.baseUrl, config.model].join("|");
}

export const embeddingCircuit = {
  isOpen(config: EmbeddingConfig): boolean {
    if (!config.enabled) return true;
    return circuits.get(circuitKey(config))?.open ?? false;
  },
  recordSuccess(config: EmbeddingConfig): void {
    circuits.delete(circuitKey(config));
  },
  recordFailure(config: EmbeddingConfig): void {
    circuits.set(circuitKey(config), { open: true });
  },
  resetForTests(): void {
    circuits.clear();
  },
};
