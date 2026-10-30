#!/usr/bin/env node
/**
 * Validate package.json against OpenCode V2 plugin packaging conventions:
 * https://opencode.ai/v2/docs/build/plugins/
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const errors = [];

function fail(msg) {
  errors.push(msg);
}

if (pkg.type !== "module") fail('package.json "type" must be "module"');
if (!pkg.exports || !pkg.exports["."]) fail('package.json must export "." (server entry)');
if (!pkg.main) fail('package.json must set "main"');
if (!pkg.engines?.node) fail('package.json must declare engines.node (>=20)');

const engine = String(pkg.engines.node);
if (!/(>=?\s*20|20\s*\|\||\^20|~20)/.test(engine) && !engine.includes("20")) {
  fail(`engines.node should target Node 20+: got ${engine}`);
}

const dep =
  pkg.dependencies?.["@opencode/plugin"] ||
  pkg.peerDependencies?.["@opencode/plugin"] ||
  pkg.devDependencies?.["@opencode/plugin"];
if (!dep) fail("must depend on @opencode/plugin");
if (dep === "latest") fail('@opencode/plugin must not be pinned to "latest"');

const entryRel = pkg.exports["."] || pkg.main;
const entryPath = join(root, entryRel);
if (!existsSync(entryPath)) fail(`entry file missing: ${entryRel}`);

const files = pkg.files || [];
if (!files.some((f) => f === "src" || f.startsWith("src/") || f === "dist" || f.startsWith("dist/"))) {
  fail('package.json "files" should include src or dist for publishing');
}

const mod = await import(pathToFileURL(entryPath).href);
const plugin = mod.default;
if (!plugin || typeof plugin !== "object") fail("default export must be a plugin definition object");
if (typeof plugin.id !== "string" || !plugin.id) fail('plugin must declare a non-empty "id"');
if (typeof plugin.setup !== "function" && typeof plugin.effect !== "function") {
  fail("plugin must export setup() (Promise API) or effect() (Effect API)");
}

if (errors.length) {
  console.error("Package validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`OK: OpenCode plugin package "${pkg.name}" (id=${plugin.id})`);
