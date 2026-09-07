import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { UI_TEXT } from "../src/core/armor-model.mjs";
import { SUPPORTED_LANGUAGES, TERMINOLOGY } from "../src/core/terminology.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("application static localization keys exist in all three languages", async () => {
  const html = await readFile(path.join(root, "app", "index.html"), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-(?:html|title|aria))?="([^"]+)"/g)]
    .map(match => match[1]);
  for (const language of SUPPORTED_LANGUAGES) {
    assert.deepEqual(Object.keys(UI_TEXT[language]).sort(), Object.keys(UI_TEXT["zh-chs"]).sort());
    for (const key of keys) assert.notEqual(UI_TEXT[language][key], undefined, `${language}.${key}`);
  }
});

test("UI sources reject obsolete tuning terms and English Armor 3.0 frame copy", async () => {
  const relativeFiles = [
    "src/app.mjs", "src/core/armor-model.mjs", "src/portal.mjs",
    "app/index.html", "index.html", "README.md", "README.en.md",
  ];
  const entries = await Promise.all(relativeFiles.map(async file => [
    file, await readFile(path.join(root, file), "utf8"),
  ]));
  for (const [file, source] of entries) {
    assert.doesNotMatch(source, /调谐|調諧/, file);
  }
  const englishSurfaces = entries
    .filter(([file]) => file === "README.en.md" || file.endsWith(".mjs"))
    .map(([, source]) => source)
    .join("\n");
  assert.doesNotMatch(englishSurfaces, /["'`]([^"'`\n]*\bframes?\b)["'`]/i);
});

test("critical UI terms are wired to the centralized contract", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    assert.equal(UI_TEXT[language].masterwork, TERMINOLOGY.masterwork[language]);
    assert.equal(UI_TEXT[language].tuningMod, TERMINOLOGY.tuningMod[language]);
    assert.equal(UI_TEXT[language].armorArchetype, TERMINOLOGY.armorArchetype[language]);
  }
});

test("Solver V3 UI copy distinguishes proof, limits, witnesses, and execution", async () => {
  const source = await readFile(path.join(root, "src", "app.mjs"), "utf8");
  for (const status of [
    "EXACT_TARGET_PROVEN",
    "RULE_FEASIBLE_PROVEN",
    "INFEASIBLE_PROVEN",
    "SEARCH_LIMIT_REACHED",
    "VERIFIED",
    "BLOCKED",
  ]) {
    assert.match(source, new RegExp(status), status);
  }
  assert.doesNotMatch(source, /No exact solution;/);
  assert.doesNotMatch(source, /This is the closest setup/);
  assert.doesNotMatch(source, /最接近目标的方案/);
});
