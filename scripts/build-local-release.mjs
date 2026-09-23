#!/usr/bin/env node
// One-click build for the local-first memorax-code release.
//
// Cross-platform (no bash required): checks the release version, builds the
// Backend, stages the npm package, writes user-facing configuration templates
// next to the staging output, and packs an installable tarball.
//
// Usage:
//   node scripts/build-local-release.mjs [--out-dir DIR] [--fresh] [--no-pack]
//
// Output layout (default):
//   dist/npm/memorax-code/          npm package staging tree
//   dist/npm/config-templates/      config.toml + embedding.json templates
//   dist/npm/tarballs/              installable .tgz (unless --no-pack)

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSafeNpmStagingOutDir } from "./npm-staging-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log([
    "Usage: node scripts/build-local-release.mjs [--out-dir DIR] [--fresh] [--no-pack]",
    "",
    "Build the local-first memorax-code npm package and write configuration",
    "templates next to the staging output.",
    "",
    "  --out-dir DIR   staging root, must be a descendant of dist/ (default dist/npm)",
    "  --fresh         force `npm ci` even when node_modules already exists",
    "  --no-pack       skip packing the installable .tgz",
  ].join("\n"));
  process.exit(0);
}

const outDir = resolveSafeNpmStagingOutDir({ repoRoot, outDir: options.outDir });

run("node", ["scripts/sync-release-version.mjs", "--check"]);

const backendPackage = "packages/ts/memorax-code-backend";
await rm(join(repoRoot, backendPackage, "dist"), { recursive: true, force: true });
if (options.fresh || !existsSync(join(repoRoot, backendPackage, "node_modules"))) {
  run("npm", ["ci", "--prefix", backendPackage]);
}
run("npm", ["run", "build", "--prefix", backendPackage]);

run("node", ["scripts/build-npm-packages.mjs", "--out-dir", relative(repoRoot, outDir).replaceAll("\\", "/")]);

await writeConfigTemplates(outDir);

let tarballPath;
if (!options.noPack) {
  tarballPath = await packTarball(outDir);
}

console.log("");
console.log("local release build completed:");
console.log(`  staging package:  ${relative(repoRoot, join(outDir, "memorax-code"))}`);
console.log(`  config templates: ${relative(repoRoot, join(outDir, "config-templates"))}`);
if (tarballPath) {
  console.log(`  installable tgz:  ${relative(repoRoot, tarballPath)}`);
  console.log("");
  console.log("install with:");
  console.log(`  npm install -g "${tarballPath}"`);
}

async function writeConfigTemplates(outputDir) {
  const templatesDir = join(outputDir, "config-templates");
  await rm(templatesDir, { recursive: true, force: true });
  await mkdir(templatesDir, { recursive: true });

  // Render from the built Backend so the template and the runtime seeding
  // share one authority.
  const { renderDefaultMemoraxCodeConfig } = await import(
    pathToFileURL(join(repoRoot, backendPackage, "dist", "config", "memorax-code.js")).href
  );
  await writeFile(join(templatesDir, "config.toml"), renderDefaultMemoraxCodeConfig(), "utf8");
  await writeFile(join(templatesDir, "embedding.json"), `${JSON.stringify({
    enabled: true,
    api_key_env: "ARKCODINGPLAN_API_KEY",
    base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-embedding-vision",
    timeout_ms: 5000,
  }, null, 2)}\n`, "utf8");

  await copyFile(
    join(repoRoot, "scripts", "local-release-templates-readme.md"),
    join(templatesDir, "README.md"),
  );
}

async function packTarball(outputDir) {
  const tarballDir = join(outputDir, "tarballs");
  await rm(tarballDir, { recursive: true, force: true });
  await mkdir(tarballDir, { recursive: true });
  const packJsonPath = join(outputDir, "main-pack.json");
  run("npm", [
    "pack",
    join(outputDir, "memorax-code"),
    "--pack-destination",
    tarballDir,
    "--json",
  ], { redirect: packJsonPath });
  run("node", ["scripts/validate-npm-pack-json.mjs", join(outputDir, "main-pack.json")]);
  await rm(packJsonPath, { force: true });
  const files = await readdir(tarballDir);
  const tarball = files.find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not produce a .tgz tarball");
  return join(tarballDir, tarball);
}

function run(command, args, { redirect } = {}) {
  console.log(`[build-local-release] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: redirect ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (redirect) writeFileSync(redirect, result.stdout ?? "");
  if (result.status !== 0) {
    throw new Error(`command failed with exit code ${result.status}: ${command} ${args.join(" ")}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--out-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--out-dir requires a value");
      parsed.outDir = value;
    } else if (arg === "--fresh") parsed.fresh = true;
    else if (arg === "--no-pack") parsed.noPack = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}
