import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { defaultMiMoCodeConfigDir } from "../src/adapter-paths.mjs";
import {
  defaultMemoraxCodeCommand,
  defaultMiMoCodeCliBinDir,
  disableMiMoCodePlugin,
  ensureMiMoCodePluginInstalled,
  readMiMoCodePluginStatus,
  removeMiMoCodePluginInstallation,
} from "../src/plugin-install.mjs";

test("mimocode config discovery honors its explicit and XDG homes", () => {
  const home = join(tmpdir(), "mimocode-discovery-home");
  const customHome = join(home, "custom-mimocode");
  const xdgHome = join(home, "xdg-config");
  assert.equal(
    defaultMiMoCodeConfigDir({ MIMOCODE_CONFIG_DIR: customHome, XDG_CONFIG_HOME: xdgHome }, home),
    customHome,
  );
  assert.equal(
    defaultMiMoCodeConfigDir({ XDG_CONFIG_HOME: xdgHome }, home),
    join(xdgHome, "mimocode"),
  );
  assert.equal(defaultMiMoCodeConfigDir({}, home), join(home, ".config", "mimocode"));
});

test("mimocode CLI path discovery recognizes the staged npm package layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-mimocode-staged-layout-"));
  try {
    const packageRoot = join(root, "prefix", "lib", "node_modules", "@memorax", "memorax-code");
    const adapterRoot = join(packageRoot, "lib", "memorax-code-mimocode-adapter");
    const commandBin = join(root, "prefix", "bin");
    const lifecycleCommand = join(packageRoot, "bin", "memorax-code.mjs");
    await mkdir(adapterRoot, { recursive: true });
    await mkdir(commandBin, { recursive: true });
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await writeFile(join(commandBin, "memorax-cli"), "#!/bin/sh\n");
    await writeFile(lifecycleCommand, "#!/usr/bin/env node\n");
    assert.equal(defaultMiMoCodeCliBinDir(adapterRoot), commandBin);
    assert.equal(defaultMemoraxCodeCommand(adapterRoot), lifecycleCommand);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mimocode plugin install materializes a managed loader, canonical skill, and state", async () => {
  const fixture = await createFixture("install");
  try {
    const installed = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(installed.ok, true);
    assert.equal(installed.changed, true);
    assert.equal(installed.restartRequired, true);
    const loader = await readFile(installed.pluginPath, "utf8");
    assert.match(loader, /^\/\/ Managed by MemoraX Code/);
    assert.match(loader, new RegExp(escapeRegex(JSON.stringify(pathToFileURL(fixture.pluginSourcePath).href))));
    assert.match(loader, new RegExp(escapeRegex(`"memoraxCodeHome":${JSON.stringify(fixture.options.memoraxCodeHome)}`)));
    assert.match(loader, new RegExp(escapeRegex(`"MiMoCodeConfigDir":${JSON.stringify(fixture.MiMoCodeConfigDir)}`)));
    assert.match(loader, new RegExp(escapeRegex(`"memoraxCodeCommand":${JSON.stringify(fixture.memoraxCodeCommand)}`)));
    assert.match(loader, new RegExp(escapeRegex(`"nodePath":${JSON.stringify(process.execPath)}`)));
    assert.match(loader, new RegExp(escapeRegex(`"cliBinDir":${JSON.stringify(fixture.options.cliBinDir)}`)));
    const repoMemoryHelperLoader = await readFile(installed.repoMemoryHelperPath, "utf8");
    assert.match(repoMemoryHelperLoader, /^\/\/ Managed by MemoraX Code/);
    assert.match(
      repoMemoryHelperLoader,
      new RegExp(escapeRegex(JSON.stringify(pathToFileURL(fixture.repoMemoryHelperSourcePath).href))),
    );
    assert.doesNotMatch(repoMemoryHelperLoader, /process\.argv/);
    const helperRun = spawnSync(
      process.execPath,
      [installed.repoMemoryHelperPath, "maintain", "--repo", fixture.root],
      { encoding: "utf8" },
    );
    assert.equal(helperRun.status, 0, helperRun.stderr);
    assert.deepEqual(JSON.parse(helperRun.stdout), ["maintain", "--repo", fixture.root]);
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# MemoraX Code\n");
    assert.equal(await readFile(join(installed.skillPath, "references", "search.md"), "utf8"), "search\n");
    assert.deepEqual(
      JSON.parse(await readFile(join(installed.skillPath, ".memorax-code-package.json"), "utf8")),
      { version: 1, memoraxCodeCommand: fixture.memoraxCodeCommand },
    );
    const repoMemoryRun = spawnSync(
      process.execPath,
      [join(installed.skillPath, "scripts", "repo-memory.mjs"), "validate", fixture.root],
      { encoding: "utf8" },
    );
    assert.equal(repoMemoryRun.status, 0, repoMemoryRun.stderr);
    assert.deepEqual(JSON.parse(repoMemoryRun.stdout), ["repo-memory", "validate", fixture.root]);
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    assert.equal(state.runtime, "mimocode");
    assert.equal(state.MiMoCodeConfigDir, fixture.MiMoCodeConfigDir);
    assert.equal(state.repoMemoryHelperPath, installed.repoMemoryHelperPath);
    assert.equal(state.repoMemoryHelperSourcePath, fixture.repoMemoryHelperSourcePath);
    assert.match(state.repoMemoryHelperSourceSha256, /^[a-f0-9]{64}$/);

    const status = readMiMoCodePluginStatus(fixture.options);
    assert.equal(status.ok, true);
    assert.equal(status.installed, true);
    assert.equal(status.current, true);
    assert.equal(status.repoMemoryHelperExists, true);
    assert.equal(status.repoMemoryHelperCurrent, true);

    const unchanged = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.restartRequired, false);

    assert.equal(disableMiMoCodePlugin(fixture.options).enabled, false);
    const reenabled = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(reenabled.changed, true);
    assert.equal(reenabled.restartRequired, true);

    await writeFile(fixture.pluginSourcePath, "export function createMemoraxMiMoCodePlugin() { return 'updated'; }\n");
    assert.equal(readMiMoCodePluginStatus(fixture.options).pluginCurrent, false);
    const updated = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(updated.changed, true);
    assert.equal(updated.restartRequired, true);
    assert.match(await readFile(updated.pluginPath, "utf8"), /Plugin source SHA-256: [a-f0-9]{64}/);

    await writeFile(
      fixture.repoMemoryHelperSourcePath,
      "process.stdout.write(JSON.stringify(['updated', ...process.argv.slice(2)]));\n",
    );
    assert.equal(readMiMoCodePluginStatus(fixture.options).repoMemoryHelperCurrent, false);
    const helperUpdated = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(helperUpdated.changed, true);
    assert.equal(helperUpdated.restartRequired, false);
    assert.match(
      await readFile(helperUpdated.repoMemoryHelperPath, "utf8"),
      /Repo Memory helper source SHA-256: [a-f0-9]{64}/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode plugin install refuses to overwrite an unmanaged Repo Memory helper", async () => {
  const fixture = await createFixture("helper-conflict");
  const helperPath = join(fixture.MiMoCodeConfigDir, "hooks", "repo-memory-job.mjs");
  try {
    await mkdir(join(fixture.MiMoCodeConfigDir, "hooks"), { recursive: true });
    await writeFile(helperPath, "console.log('user helper');\n");

    const result = ensureMiMoCodePluginInstalled(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "repo_memory_helper_conflict");
    assert.equal(result.conflictPath, helperPath);
    assert.equal(await readFile(helperPath, "utf8"), "console.log('user helper');\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode plugin install refuses to overwrite an unmanaged discovery file", async () => {
  const fixture = await createFixture("conflict");
  const pluginPath = join(fixture.MiMoCodeConfigDir, "plugins", "memorax-code.js");
  try {
    await mkdir(join(fixture.MiMoCodeConfigDir, "plugins"), { recursive: true });
    await writeFile(pluginPath, "export const UserPlugin = async () => ({});\n");

    const result = ensureMiMoCodePluginInstalled(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "plugin_conflict");
    assert.equal(await readFile(pluginPath, "utf8"), "export const UserPlugin = async () => ({});\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode plugin install refuses to overwrite a recorded loader without its managed marker", async () => {
  const fixture = await createFixture("recorded-loader-conflict");
  try {
    const installed = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(installed.ok, true);
    const customLoader = "export const UserPlugin = async () => ({});\n";
    await writeFile(installed.pluginPath, customLoader);

    const result = ensureMiMoCodePluginInstalled(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "plugin_conflict");
    assert.equal(await readFile(installed.pluginPath, "utf8"), customLoader);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode directory publication retries Windows contention and preserves exhausted failures", async () => {
  const fixture = await createFixture("directory-contention");
  const skillPath = join(fixture.MiMoCodeConfigDir, "skills", "memorax-code");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalRename = fs.renameSync;
  const originalRemove = fs.rmSync;
  const publishError = Object.assign(new Error("directory publication denied"), { code: "EPERM" });
  let persistent = false;
  let skillRenames = 0;
  let skillRemovals = 0;
  fs.renameSync = (source, destination) => {
    if (destination === skillPath && (++skillRenames === 1 || persistent)) throw publishError;
    return originalRename(source, destination);
  };
  fs.rmSync = (target, ...args) => {
    if (target === skillPath && ++skillRemovals === 1) {
      throw Object.assign(new Error("directory removal busy"), { code: "EBUSY" });
    }
    if (persistent && target.startsWith(`${skillPath}.tmp-`) && fs.existsSync(target)) {
      throw Object.assign(new Error("stage cleanup failed"), { code: "EIO" });
    }
    return originalRemove(target, ...args);
  };
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  syncBuiltinESMExports();
  try {
    const installed = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(installed.ok, true);
    assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), "# MemoraX Code\n");
    assert.deepEqual([skillRenames, skillRemovals], [2, 2]);
    assert.equal(ensureMiMoCodePluginInstalled(fixture.options).changed, false);
    assert.deepEqual([skillRenames, skillRemovals], [2, 2]);

    const previousState = await readFile(installed.statePath, "utf8");
    await writeFile(join(fixture.options.skillSourcePath, "SKILL.md"), "# Updated Skill\n");
    persistent = true;
    assert.throws(() => ensureMiMoCodePluginInstalled(fixture.options), (error) => (
      error === publishError && error.stage === "skill-publish" && error.code === "EPERM"
    ));
    assert.deepEqual(publishError.failure, {
      errorCode: "CLIENT_SKILL_PUBLISH_FAILED", stage: "skill-publish", systemCode: "EPERM",
      cleanupErrorCode: "CLIENT_CLEANUP_FAILED", cleanupSystemCode: "EIO",
    });
    assert.equal(JSON.stringify(publishError.failure).includes(fixture.root), false);
    assert.equal(skillRenames, 7, "persistent contention must stop after the bounded retries");
    assert.equal(await readFile(installed.statePath, "utf8"), previousState);
    assert.equal(readMiMoCodePluginStatus(fixture.options).enabled, false);

    persistent = false;
    assert.equal(ensureMiMoCodePluginInstalled(fixture.options).ok, true);
    assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), "# Updated Skill\n");
  } finally {
    Object.defineProperty(process, "platform", platform);
    fs.renameSync = originalRename;
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode plugin install removes newly created artifacts when state persistence fails", async () => {
  const fixture = await createFixture("state-write-failure");
  const blockedStateDir = join(fixture.options.memoraxCodeHome, "adapters", "mimocode");
  const pluginPath = join(fixture.MiMoCodeConfigDir, "plugins", "memorax-code.js");
  const skillPath = join(fixture.MiMoCodeConfigDir, "skills", "memorax-code");
  const helperPath = join(fixture.MiMoCodeConfigDir, "hooks", "repo-memory-job.mjs");
  try {
    await mkdir(join(fixture.options.memoraxCodeHome, "adapters"), { recursive: true });
    await writeFile(blockedStateDir, "not a directory\n");

    assert.throws(() => ensureMiMoCodePluginInstalled(fixture.options), (error) => {
      assert.equal(error.failure.errorCode, "CLIENT_STATE_WRITE_FAILED");
      assert.equal(error.failure.stage, "state-write");
      assert.ok(["EEXIST", "ENOTDIR"].includes(error.failure.systemCode));
      assert.equal(JSON.stringify(error.failure).includes(fixture.root), false);
      return true;
    });
    await assert.rejects(readFile(pluginPath), /ENOENT/);
    await assert.rejects(readFile(join(skillPath, "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(helperPath), /ENOENT/);

    await rm(blockedStateDir, { force: true });
    assert.equal(ensureMiMoCodePluginInstalled(fixture.options).ok, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode plugin removal deletes only the recorded managed artifacts", async () => {
  const fixture = await createFixture("remove");
  try {
    const installed = ensureMiMoCodePluginInstalled(fixture.options);
    assert.equal(installed.ok, true);
    const unrelatedConfig = join(fixture.MiMoCodeConfigDir, "mimocode.jsonc");
    await writeFile(unrelatedConfig, "{ // user config\n}\n");

    const disabled = disableMiMoCodePlugin(fixture.options);
    assert.equal(disabled.ok, true);
    assert.equal(disabled.enabled, false);
    const disabledStatus = readMiMoCodePluginStatus(fixture.options);
    assert.equal(disabledStatus.ok, true);
    assert.equal(disabledStatus.reason, "not_enabled");
    assert.match(await readFile(installed.pluginPath, "utf8"), /^\/\/ Managed by MemoraX Code/);
    assert.match(
      await readFile(installed.repoMemoryHelperPath, "utf8"),
      /^\/\/ Managed by MemoraX Code/,
    );

    const removed = removeMiMoCodePluginInstallation(fixture.options);

    assert.equal(removed.ok, true);
    assert.equal(await readFile(unrelatedConfig, "utf8"), "{ // user config\n}\n");
    await assert.rejects(readFile(installed.pluginPath), /ENOENT/);
    await assert.rejects(readFile(join(installed.skillPath, "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(installed.repoMemoryHelperPath), /ENOENT/);
    await assert.rejects(readFile(installed.statePath), /ENOENT/);
    assert.equal(readMiMoCodePluginStatus(fixture.options).managed, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode plugin removal preserves all artifacts when the recorded helper is unmanaged", async () => {
  const fixture = await createFixture("unmanaged-helper-removal");
  try {
    const installed = ensureMiMoCodePluginInstalled(fixture.options);
    await writeFile(installed.repoMemoryHelperPath, "console.log('replacement');\n");

    const removed = removeMiMoCodePluginInstallation(fixture.options);

    assert.equal(removed.ok, false);
    assert.equal(removed.reason, "repo_memory_helper_not_managed");
    assert.match(await readFile(installed.pluginPath, "utf8"), /^\/\/ Managed by MemoraX Code/);
    assert.equal(
      await readFile(installed.repoMemoryHelperPath, "utf8"),
      "console.log('replacement');\n",
    );
    assert.equal(JSON.parse(await readFile(installed.statePath, "utf8")).enabled, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mimocode plugin removal fails closed for a state with unsafe managed paths", async () => {
  const fixture = await createFixture("unsafe-state");
  const sentinel = join(fixture.root, "do-not-delete");
  const statePath = join(fixture.options.memoraxCodeHome, "adapters", "mimocode", "state.json");
  try {
    await mkdir(sentinel, { recursive: true });
    await writeFile(join(sentinel, "sentinel.txt"), "preserve\n");
    await mkdir(join(fixture.options.memoraxCodeHome, "adapters", "mimocode"), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      runtime: "mimocode",
      integration: "plugin",
      enabled: true,
      MiMoCodeConfigDir: fixture.MiMoCodeConfigDir,
      pluginPath: join(fixture.MiMoCodeConfigDir, "plugins", "memorax-code.js"),
      skillPath: sentinel,
    }));

    const removed = removeMiMoCodePluginInstallation(fixture.options);

    assert.equal(removed.ok, false);
    assert.equal(removed.reason, "state_paths_invalid");
    assert.equal(await readFile(join(sentinel, "sentinel.txt"), "utf8"), "preserve\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `memorax-code-mimocode-${name}-`));
  const MiMoCodeConfigDir = join(root, "mimocode Config With Spaces");
  const memoraxCodeHome = join(root, "memorax-code");
  const pluginSourcePath = join(root, "Adapter With Spaces", "plugin.mjs");
  const repoMemoryHelperSourcePath = join(
    root,
    "Adapter With Spaces",
    "hooks",
    "repo-memory-job.mjs",
  );
  const memoraxCodeCommand = join(root, "Package With Spaces", "bin", "memorax-code.mjs");
  const skillSourcePath = join(root, "canonical-skill");
  await mkdir(join(skillSourcePath, "references"), { recursive: true });
  await mkdir(join(skillSourcePath, "scripts"), { recursive: true });
  await mkdir(join(root, "Adapter With Spaces"), { recursive: true });
  await mkdir(join(root, "Adapter With Spaces", "hooks"), { recursive: true });
  await mkdir(join(root, "Package With Spaces", "bin"), { recursive: true });
  await writeFile(pluginSourcePath, "export function createMemoraxMiMoCodePlugin() {}\n");
  await writeFile(
    repoMemoryHelperSourcePath,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  );
  await writeFile(
    memoraxCodeCommand,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  );
  await writeFile(join(skillSourcePath, "SKILL.md"), "# MemoraX Code\n");
  await writeFile(join(skillSourcePath, "references", "search.md"), "search\n");
  await copyFile(
    new URL("../../memorax-code-codex-adapter/skills/memorax-code/scripts/repo-memory.mjs", import.meta.url),
    join(skillSourcePath, "scripts", "repo-memory.mjs"),
  );
  return {
    root,
    MiMoCodeConfigDir,
    memoraxCodeCommand,
    pluginSourcePath,
    repoMemoryHelperSourcePath,
    options: {
      MiMoCodeConfigDir,
      memoraxCodeHome,
      pluginSourcePath,
      repoMemoryHelperSourcePath,
      skillSourcePath,
      memoraxCodeCommand,
      cliBinDir: join(root, "managed-bin"),
    },
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
