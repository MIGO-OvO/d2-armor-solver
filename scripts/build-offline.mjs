import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build, mergeConfig } from "vite";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outDir = path.join(projectRoot, "dist-offline");

// Offline-only source rewrites for src/core/armor-engine-client.mjs:
// - the main-thread fallback is always used offline, so the lazy
//   import("./armor-engine.mjs") becomes a static import (Rollup cannot
//   merge a dynamic chunk that shares code with the entry chunk, and a
//   runtime dynamic import() of an external file is CORS-blocked on file://)
// - the Worker guard is hard-coded so construction is unreachable; even if
//   the minifier does not constant-fold the define, no Worker is attempted
const offlineEnginePlugin = {
  name: "d2-armor-offline-engine",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("src/core/armor-engine-client.mjs")) return;
    const dynamicImport = 'import("./armor-engine.mjs").then(engine => {';
    const guard = /if \(existing \|\| [^\n]+\) return existing \|\| null;/;
    if (!code.includes(dynamicImport) || !guard.test(code)) {
      throw new Error("armor-engine-client.mjs changed shape; offline plugin must be updated");
    }
    return {
      code:
        'import * as __offlineArmorEngine from "./armor-engine.mjs";\n' +
        code.replace(
          dynamicImport,
          "Promise.resolve(__offlineArmorEngine).then(engine => {",
        ).replace(guard, "return existing || null;"),
      map: null,
    };
  },
};

// Inherit base:"./" and the __BUNGIE_* defines, then build only the app entry
// and force a single chunk. The normal build is multi-page (portal + app),
// while the offline archive intentionally contains only the solver.
const baseConfig = (await import(pathToFileURL(path.join(projectRoot, "vite.config.mjs")))).default;
await build(
  mergeConfig(baseConfig, {
    plugins: [offlineEnginePlugin],
    build: {
      outDir,
      emptyOutDir: true,
      inlineDynamicImports: true,
      rollupOptions: {
        input: path.join(projectRoot, "app", "index.html"),
      },
    },
    define: {
      // Chrome blocks Workers and external module scripts on file://, so
      // armor-engine-client.mjs reads this and falls back to main-thread.
      __OFFLINE_MODE__: JSON.stringify("true"),
    },
  }),
);

// Inline the single CSS and JS assets so no external module/stylesheet
// requests survive on file://.
const builtHtmlPath = path.join(outDir, "app", "index.html");
const htmlPath = path.join(outDir, "index.html");
let html = await readFile(builtHtmlPath, "utf8");

const cssTag = html.match(
  /<link[^>]*rel="stylesheet"[^>]*href="((?:\.\.\/|\.\/)assets\/[^"]+\.css)"[^>]*>/,
);
if (!cssTag) throw new Error("No stylesheet link found in dist-offline/app/index.html");
let css = await readFile(path.resolve(path.dirname(builtHtmlPath), cssTag[1]), "utf8");
// The CSS lived in assets/ where ../asset/ was correct; inlined into the
// root-level index.html the icons are now at ./asset/.
css = css.replace(/url\((['"]?)\.\.\/asset\//g, "url($1./asset/");
if (css.includes("../asset/")) throw new Error("Unrewritten ../asset/ reference in CSS");
html = html.replace(cssTag[0], `<style>\n${css}\n</style>`);

const jsTag = html.match(
  /<script[^>]*src="((?:\.\.\/|\.\/)assets\/[^"]+\.js)"[^>]*>\s*<\/script>/,
);
if (!jsTag) throw new Error("No module script tag found in dist-offline/app/index.html");
const js = await readFile(path.resolve(path.dirname(builtHtmlPath), jsTag[1]), "utf8");
html = html.replace(jsTag[0], `<script type="module">\n${js}\n</script>`);

// The inlined page must not fetch anything extra: no external tags, no
// runtime dynamic import(). The worker chunk stays as an unused file; it is
// never instantiated offline (createWorker always returns null).
if (/href="(?:\.\.\/|\.\/)assets\//.test(html)) {
  throw new Error("External stylesheet link remains");
}
if (/src="(?:\.\.\/|\.\/)assets\//.test(html)) {
  throw new Error("External script tag remains");
}
if (js.match(/import\(\s*["'`]/)) throw new Error("Runtime dynamic import() remains in bundle");
const assets = await readdir(path.join(outDir, "assets"));
if (!assets.some(name => /armor-engine\.worker/.test(name))) {
  throw new Error("Worker chunk missing from dist-offline/assets");
}

await writeFile(htmlPath, html);
// The inlined HTML is fully self-contained (inline <style> + <script>), so
// the original assets/ files are now unreferenced; deleting them keeps the
// distributed zip from bloating with ~1.7MB of dead files.
await rm(path.join(outDir, "assets"), { recursive: true, force: true });
await rm(path.join(outDir, "app"), { recursive: true, force: true });
await cp(path.join(projectRoot, "asset"), path.join(outDir, "asset"), {
  recursive: true,
});

for (const entry of (await readdir(outDir, { recursive: true })).sort()) {
  console.log("  " + entry);
}
console.log("Offline build at " + outDir);
