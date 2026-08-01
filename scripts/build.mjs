import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "vite";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
await build({
  configFile: path.join(projectRoot, "vite.config.mjs"),
});

await Promise.all([
  cp(
    path.join(projectRoot, "destiny2-armor-solver.html"),
    path.join(projectRoot, "dist", "destiny2-armor-solver.html"),
  ),
  cp(path.join(projectRoot, "asset"), path.join(projectRoot, "dist", "asset"), {
    recursive: true,
  }),
]);

console.log("Static site built at " + path.join(projectRoot, "dist"));
