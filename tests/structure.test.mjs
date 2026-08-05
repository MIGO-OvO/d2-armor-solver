import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const algorithmModules = [
  "src/core/armor-engine.mjs",
  "src/core/budget.mjs",
  "src/core/reachability.mjs",
  "src/core/solver.mjs",
  "src/core/upgrade-optimizer.mjs",
  "src/core/inventory-solver.mjs",
  "src/core/inventory-plan.mjs",
  "src/core/dim-csv.mjs",
  "src/core/armor-sets.mjs",
  "src/core/armor-sets.data.mjs",
];

test("algorithm modules stay independent from browser state", async () => {
  for (const file of algorithmModules) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\b(?:document|localStorage|window)\b/, file);
  }
});

test("the source HTML loads external styles and a module entry", async () => {
  const html = await readFile("index.html", "utf8");
  assert.match(html, /<link rel="stylesheet" href="\.\/src\/styles\/app\.css">/);
  assert.match(html, /<script type="module" src="\.\/src\/app\.mjs"><\/script>/);
  assert.doesNotMatch(html, /<style(?:\s|>)/);
});
