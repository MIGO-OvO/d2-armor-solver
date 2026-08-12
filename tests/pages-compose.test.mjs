import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { composePages } from "../scripts/compose-pages.mjs";

const PORTAL = `<!doctype html>
<article class="route route--online">
  <a class="action action--primary" href="./app/">Stable</a>
      </article>

      <article class="route route--offline">Offline</article>`;

const DEVELOPMENT_PORTAL = PORTAL.replace(
  "\n      </article>",
  `
  <a class="text-link" data-development-entry href="./dev/app/">Preview</a>
      </article>`,
);

async function createDistribution(directory, portal, marker) {
  await mkdir(path.join(directory, "app"), { recursive: true });
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeFile(path.join(directory, "index.html"), portal);
  await writeFile(
    path.join(directory, "app", "index.html"),
    `<!doctype html><html><head></head><body>${marker}</body></html>`,
  );
  await writeFile(path.join(directory, "assets", `${marker}.txt`), marker);
}

test("Pages composition keeps main at root and develop under /dev", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "d2-pages-"));
  const stable = path.join(root, "stable");
  const development = path.join(root, "development");
  const output = path.join(root, "pages");

  try {
    await createDistribution(stable, PORTAL, "stable");
    await createDistribution(development, DEVELOPMENT_PORTAL, "development");
    await composePages({
      stableDirectory: stable,
      developmentDirectory: development,
      outputDirectory: output,
      stableCommit: "stable-sha",
      developmentCommit: "development-sha",
    });

    const stableApp = await readFile(path.join(output, "app", "index.html"), "utf8");
    assert.match(stableApp, /<body>stable<\/body>/);
    assert.match(stableApp, /data-development-oauth-relay/);
    assert.match(stableApp, /state\.startsWith\("develop\."\)/);
    assert.match(stableApp, /new URL\("\.\.\/dev\/app\/", location\.href\)/);
    const developmentApp = await readFile(
      path.join(output, "dev", "app", "index.html"),
      "utf8",
    );
    assert.match(developmentApp, /<body>development<\/body>/);
    assert.doesNotMatch(developmentApp, /data-development-oauth-relay/);

    const rootPortal = await readFile(path.join(output, "index.html"), "utf8");
    const developmentPortal = await readFile(path.join(output, "dev", "index.html"), "utf8");
    assert.match(rootPortal, /data-development-entry href="\.\/dev\/app\/"/);
    assert.doesNotMatch(developmentPortal, /data-development-entry/);

    const versions = JSON.parse(await readFile(path.join(output, "versions.json"), "utf8"));
    assert.deepEqual(versions, {
      stable: { branch: "main", commit: "stable-sha" },
      development: { branch: "develop", commit: "development-sha" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
