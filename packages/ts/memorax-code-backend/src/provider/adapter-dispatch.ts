import { loadMemoraxCodeConfig, defaultMemoraxCodeHome } from "../config/memorax-code.js";
import { invokeLocalMemoryProvider } from "./local/adapter.js";
import { invokeMemoraxMemoryProvider } from "./memorax/adapter.js";
import type { MemoraxSlotInvocationRequest, MemoraxAdapterOptions, MemoraxInvocationResult } from "./memorax/adapter.js";

export async function invokeMemoryProvider(
  run: Parameters<typeof invokeMemoraxMemoryProvider>[0],
  request: MemoraxSlotInvocationRequest,
  options: MemoraxAdapterOptions = {},
): Promise<MemoraxInvocationResult> {
  const env = options.env ?? process.env;
  const envProvider = env.MEMORAX_CODE_MEMORY_PROVIDER?.trim();
  const fileProvider = loadMemoraxCodeConfig(defaultMemoraxCodeHome(env)).memory?.provider;
  const provider = envProvider || fileProvider || "local";
  if (provider === "local") {
    return invokeLocalMemoryProvider(run, request, options);
  }
  return invokeMemoraxMemoryProvider(run, request, options);
}
