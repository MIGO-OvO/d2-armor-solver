import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = path.join(projectRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  cp(
    path.join(projectRoot, "destiny2-armor-solver.html"),
    path.join(outputDirectory, "index.html"),
  ),
  cp(path.join(projectRoot, "asset"), path.join(outputDirectory, "asset"), {
    recursive: true,
  }),
]);

console.log(`Static site built at ${outputDirectory}`);
