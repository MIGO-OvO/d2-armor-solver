import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    assert.doesNotMatch(
      source,
      /\b(?:document|localStorage|window)\s*(?:\.|\[)/,
      file,
    );
  }
});

test("the portal and app expose separate static entries", async () => {
  const portal = await readFile("index.html", "utf8");
  assert.match(portal, /<link rel="stylesheet" href="\.\/src\/styles\/portal\.css">/);
  assert.match(portal, /<script type="module" src="\.\/src\/portal\.mjs"><\/script>/);
  assert.match(portal, /href="\.\/app\/"/);
  assert.match(
    portal,
    /releases\/latest\/download\/d2-armor-solver-offline\.zip/,
  );
  assert.doesNotMatch(portal, /src\/app\.mjs/);
  assert.doesNotMatch(portal, /<style(?:\s|>)/);

  const app = await readFile("app/index.html", "utf8");
  assert.match(app, /<link rel="stylesheet" href="\.\.\/src\/styles\/app\.css">/);
  assert.match(app, /<script type="module" src="\.\.\/src\/app\.mjs"><\/script>/);
  assert.doesNotMatch(app, /<style(?:\s|>)/);
});

// --- Bungie OAuth secrets: never "undefined", never leaked ---

const bungieDefineNames = ["API_KEY", "OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET"];

test("vite define falls back to \"\" and built chunks never contain undefined secrets", async () => {
  const viteConfig = await readFile("vite.config.mjs", "utf8");
  for (const name of bungieDefineNames) {
    assert.match(
      viteConfig,
      new RegExp(
        `__BUNGIE_${name}__:\\s*JSON\\.stringify\\(process\\.env\\.BUNGIE_${name} \\|\\| ""\\)`,
      ),
      `missing || "" fallback for __BUNGIE_${name}__`,
    );
  }
  // dist/ only exists after `npm run build`; CI runs test before build.
  if (existsSync("dist/assets")) {
    for (const chunk of readdirSync("dist/assets").filter((f) => f.endsWith(".js"))) {
      assert.doesNotMatch(
        readFileSync(`dist/assets/${chunk}`, "utf8"),
        /BUNGIE_(?:API_KEY|OAUTH_CLIENT_ID|OAUTH_CLIENT_SECRET)__\s*[=:]\s*undefined/,
        chunk,
      );
    }
  }
});

test(".gitignore covers Bungie OAuth env files", async () => {
  const gitignore = await readFile(".gitignore", "utf8");
  assert.match(gitignore, /^\.env$/m, "missing exact .env line");
  assert.match(gitignore, /^\.env\.local$/m, "missing .env.local line");
});

// --- Bungie realtime inventory (T8/T9) ---

const inventoryModulePath = "src/core/bungie-inventory.mjs";
const inventoryModuleExists = existsSync(inventoryModulePath);
const EXPECTED_ARMOR_COMPONENTS = [
  "Profiles",
  "ProfileInventories",
  "Characters",
  "CharacterInventories",
  "CharacterEquipment",
  "ItemInstances",
  "ItemSockets",
  "ItemPlugStates",
];

test(
  "ARMOR_COMPONENTS is exactly the 8 Bungie component types",
  inventoryModuleExists
    ? undefined
    : { skip: `${inventoryModulePath} not created yet (pending T8/T9)` },
  async () => {
    const { ARMOR_COMPONENTS } = await import(`../${inventoryModulePath}`);
    assert.equal(ARMOR_COMPONENTS.length, EXPECTED_ARMOR_COMPONENTS.length);
    assert.deepEqual(
      [...ARMOR_COMPONENTS].sort(),
      [...EXPECTED_ARMOR_COMPONENTS].sort(),
    );
  },
);

test(
  "bungie core modules avoid bare browser globals (DOM/localStorage)",
  inventoryModuleExists
    ? undefined
    : { skip: `${inventoryModulePath} not created yet (pending T8/T9)` },
  async () => {
    for (const file of ["src/core/bungie-api.mjs", inventoryModulePath]) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(
        source,
        // Browser globals must only be reached through globalThis.
        /(?<!globalThis\.)\b(?:document|window|localStorage)\s*(?:\.|\[)/,
        file,
      );
    }
  },
);
