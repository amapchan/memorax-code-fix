import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultMiMoCodeConfigDir(env = process.env, home = homedir()) {
  const explicit = stringOption(env.MIMOCODE_CONFIG_DIR);
  if (explicit) return resolve(explicit);
  const configHome = stringOption(env.XDG_CONFIG_HOME) ?? join(home, ".config");
  return resolve(configHome, "mimocode");
}

export function defaultMemoraxCodeHome(env = process.env, home = homedir()) {
  return resolve(stringOption(env.MEMORAX_CODE_HOME) ?? join(home, ".memorax-code"));
}

export function adapterStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "adapters", "mimocode", "state.json");
}

export function MiMoCodeWorkspaceStatePath(memoraxCodeHome = defaultMemoraxCodeHome()) {
  return join(memoraxCodeHome, "adapters", "mimocode", "workspaces.json");
}

export function MiMoCodePluginPath(configDir = defaultMiMoCodeConfigDir()) {
  return join(configDir, "plugins", "memorax-code.js");
}

export function MiMoCodeSkillPath(configDir = defaultMiMoCodeConfigDir()) {
  return join(configDir, "skills", "memorax-code");
}

export function MiMoCodeRepoMemoryHelperPath(configDir = defaultMiMoCodeConfigDir()) {
  return join(configDir, "hooks", "repo-memory-job.mjs");
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
