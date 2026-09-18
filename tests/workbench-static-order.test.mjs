import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

// The workbench input order is authored markup. An earlier release moved the
// target card ahead of the fragment card at runtime, which silently changed the
// layout the maintainer had settled on. These checks keep the order static so
// any future repositioning has to be an explicit, reviewable markup change.

const MARKUP_SECTIONS = [
  "inventoryImportCard",
  "upgradeBuildCard",
];

async function readApp() {
  return readFile("app/index.html", "utf8");
}

test("the app markup declares every workbench input block exactly once", async () => {
  const app = await readApp();
  for (const id of [...MARKUP_SECTIONS, "workspace-grid", "fragmentCard", "inputCard"]) {
    const pattern = id === "workspace-grid"
      ? /class="workspace-grid"/g
      : new RegExp(`id="${id}"`, "g");
    assert.equal((app.match(pattern) || []).length, 1, id);
  }
});

test("fragments stay ahead of targets inside the workspace grid", async () => {
  const app = await readApp();
  const gridStart = app.indexOf('class="workspace-grid"');
  assert.ok(gridStart > 0, "workspace grid must exist in markup");
  const fragmentAt = app.indexOf('id="fragmentCard"', gridStart);
  const targetAt = app.indexOf('id="inputCard"', gridStart);
  assert.ok(fragmentAt > 0 && targetAt > 0, "both cards belong to the workspace grid");
  assert.ok(fragmentAt < targetAt,
    "fragment attributes must be authored before the target attributes");
});

test("the import card stays the first workbench block above the workspace grid", async () => {
  const app = await readApp();
  const importAt = app.indexOf('id="inventoryImportCard"');
  const upgradeAt = app.indexOf('id="upgradeBuildCard"');
  const gridAt = app.indexOf('class="workspace-grid"');
  assert.ok(importAt > 0 && upgradeAt > 0 && gridAt > 0);
  assert.ok(importAt < upgradeAt, "import card precedes the current-loadout editor");
  assert.ok(upgradeAt < gridAt, "the workspace grid follows the current-loadout editor");
});

test("no runtime code repositions the workbench input blocks", async () => {
  const app = await readApp();
  // A markup-only contract: nothing may insert, prepend or move these cards.
  const appSource = await readFile("src/app.mjs", "utf8");
  assert.doesNotMatch(appSource, /arrangeWorkbenchInputs/,
    "app.mjs must not reorder the workbench through a layout helper");
  for (const id of ["fragmentCard", "inputCard"]) {
    assert.doesNotMatch(
      appSource,
      new RegExp(`(?:prepend|appendChild|insertBefore|before|after)\\([^)]*${id}`),
      `nothing may reposition #${id} at runtime`,
    );
  }
  assert.match(app, /<div class="workspace-grid">/,
    "the workspace grid stays a markup container, not a script-built one");
});

test("the removed layout helper module stays removed", async () => {
  await assert.rejects(access("src/ui/workbench-layout.mjs"),
    "workbench-layout.mjs must not be reintroduced");
});
