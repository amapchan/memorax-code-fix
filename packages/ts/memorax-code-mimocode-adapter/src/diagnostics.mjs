import { readAdapterState } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  defaultMemoraxCodeHome,
  MiMoCodeWorkspaceStatePath,
} from "./adapter-paths.mjs";

export function readMiMoCodeWorkspaceStatus(options = {}) {
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const path = options.workspaceStatePath ?? MiMoCodeWorkspaceStatePath(memoraxCodeHome);
  const state = readAdapterState(path);
  const stateValid = !state || (
    state.unreadable !== true
    && state.version === 1
    && state.runtime === "mimocode"
  );
  const latest = stateValid && state?.latest && typeof state.latest === "object"
    ? state.latest
    : undefined;
  return {
    ok: stateValid,
    action: "workspace-status",
    memoraxCodeHome,
    path,
    captured: Boolean(latest?.cwd),
    latest,
    state,
    ...(!stateValid
      ? { reason: state?.unreadable ? "state_unreadable" : "state_invalid" }
      : {}),
  };
}
