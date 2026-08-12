import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEVELOPMENT_ENTRY = `
        <a class="text-link" data-development-entry href="./dev/app/">
          <span data-i18n="openDevelopmentApp">开发测试版 / Preview</span>
          <span aria-hidden="true">→</span>
        </a>`;

const ONLINE_ROUTE_END = "\n      </article>\n\n      <article class=\"route route--offline\">";
const DEVELOPMENT_ENTRY_PATTERN = /\n\s*<a class="text-link" data-development-entry[\s\S]*?<\/a>/;
const DEVELOPMENT_OAUTH_RELAY = `
<script data-development-oauth-relay>
(() => {
  const params = new URLSearchParams(location.search);
  const state = params.get("state") || "";
  if (!params.has("code") || !state.startsWith("develop.")) return;
  const target = new URL("../dev/app/", location.href);
  target.search = location.search;
  target.hash = location.hash;
  location.replace(target);
})();
</script>`;

function isInside(parentDirectory, candidateDirectory) {
  const relative = path.relative(parentDirectory, candidateDirectory);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

async function requireFile(directory, relativePath) {
  const target = path.join(directory, relativePath);
  await access(target, constants.R_OK);
  return target;
}

function addDevelopmentEntry(html) {
  if (html.includes("data-development-entry")) return html;
  if (!html.includes(ONLINE_ROUTE_END)) {
    throw new Error("Stable portal does not contain the expected online route marker");
  }
  return html.replace(
    ONLINE_ROUTE_END,
    `${DEVELOPMENT_ENTRY}${ONLINE_ROUTE_END}`,
  );
}

function removeDevelopmentEntry(html) {
  return html.replace(DEVELOPMENT_ENTRY_PATTERN, "");
}

function addDevelopmentOAuthRelay(html) {
  if (html.includes("data-development-oauth-relay")) return html;
  if (!html.includes("<head>")) {
    throw new Error("Stable app does not contain a head element for the OAuth relay");
  }
  return html.replace("<head>", `<head>${DEVELOPMENT_OAUTH_RELAY}`);
}

export async function composePages({
  stableDirectory,
  developmentDirectory,
  outputDirectory,
  stableCommit = "",
  developmentCommit = "",
}) {
  const stable = path.resolve(stableDirectory);
  const development = path.resolve(developmentDirectory);
  const output = path.resolve(outputDirectory);

  if (output === stable || output === development
      || isInside(stable, output) || isInside(development, output)
      || isInside(output, stable) || isInside(output, development)) {
    throw new Error("Pages output and inputs must be separate sibling directories");
  }

  const stableIndex = await requireFile(stable, "index.html");
  const stableAppIndex = await requireFile(stable, path.join("app", "index.html"));
  const developmentIndex = await requireFile(development, "index.html");
  await requireFile(development, path.join("app", "index.html"));

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(stable, output, { recursive: true });
  await cp(development, path.join(output, "dev"), { recursive: true });

  const stablePortal = addDevelopmentEntry(await readFile(stableIndex, "utf8"));
  await writeFile(path.join(output, "index.html"), stablePortal);
  const stableApp = addDevelopmentOAuthRelay(
    await readFile(stableAppIndex, "utf8"),
  );
  await writeFile(path.join(output, "app", "index.html"), stableApp);

  // The nested portal's primary online link already resolves to /dev/app/.
  // Remove its extra root-only preview link so it cannot point to /dev/dev/app/.
  const developmentPortal = removeDevelopmentEntry(
    await readFile(developmentIndex, "utf8"),
  );
  await writeFile(path.join(output, "dev", "index.html"), developmentPortal);

  await writeFile(
    path.join(output, "versions.json"),
    JSON.stringify({
      stable: { branch: "main", commit: stableCommit },
      development: { branch: "develop", commit: developmentCommit },
    }, null, 2) + "\n",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const [stableDirectory, developmentDirectory, outputDirectory] = process.argv.slice(2);
  if (!stableDirectory || !developmentDirectory || !outputDirectory) {
    throw new Error(
      "Usage: node scripts/compose-pages.mjs <stable-dist> <development-dist> <output>",
    );
  }
  await composePages({
    stableDirectory,
    developmentDirectory,
    outputDirectory,
    stableCommit: process.env.STABLE_COMMIT_SHA || "",
    developmentCommit: process.env.DEVELOPMENT_COMMIT_SHA || "",
  });
  console.log(`Combined Pages site built at ${path.resolve(outputDirectory)}`);
}
