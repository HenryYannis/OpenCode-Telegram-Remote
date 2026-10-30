#!/usr/bin/env node
/** Smoke-import the plugin the way OpenCode's loader would. */
import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/index.js");
const mod = await import(pathToFileURL(entry).href);

if (!mod.default?.id || typeof mod.default.setup !== "function") {
  console.error("Smoke import failed: default export is not a V2 plugin definition");
  process.exit(1);
}

console.log(`OK: smoke import ${mod.default.id}`);
