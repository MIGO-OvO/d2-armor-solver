import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build, mergeConfig } from "vite";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outDir = path.join(projectRoot, "dist-offline");

// file:// cannot load an external module worker. Bundle the same engine into a
// self-contained classic worker and embed its source in the HTML instead. A
// Blob worker keeps offline solving cancellable and off the interaction thread.
const workerBuild = await build({
  configFile: false,
  build: {
    write: false,
    target: 'es2022',
    lib: {
      entry: path.join(projectRoot, 'src', 'workers', 'armor-engine.worker.mjs'),
      name: 'ArmorOfflineWorker',
      formats: ['iife'],
    },
    rollupOptions: {output: {codeSplitting: false}},
  },
});
const workerOutputs = (Array.isArray(workerBuild) ? workerBuild : [workerBuild])
  .flatMap(result => result.output);
const workerChunks = workerOutputs.filter(entry => entry.type === 'chunk');
if (workerChunks.length !== 1 || workerChunks[0].imports.length || workerChunks[0].dynamicImports.length) {
  throw new Error('Offline worker must be one self-contained chunk');
}
const workerSource = workerChunks[0].code;

// Keep engine imports self-contained too. The non-browser test adapter may use
// the inline engine; no runtime import of an external file may survive file://.
const offlineEnginePlugin = {
  name: "d2-armor-offline-engine",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("src/core/armor-engine-client.mjs")) return;
    const dynamicImport = /import\((["'])\.\/armor-engine\.mjs\1\)/g;
    if (!dynamicImport.test(code)) {
      throw new Error("armor-engine-client.mjs changed shape; offline plugin must be updated");
    }
    return {
      code:
        'import * as __offlineArmorEngine from "./armor-engine.mjs";\n' +
        code.replace(dynamicImport, 'Promise.resolve(__offlineArmorEngine)'),
      map: null,
    };
  },
};

// Inherit base:"./", then build only the app entry and force a single chunk.
// Bungie credentials are deliberately blanked even when the build environment
// has them: the offline archive must not expose login or write actions.
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
      // Account access remains disabled; the engine uses the embedded worker.
      __OFFLINE_MODE__: JSON.stringify("true"),
      __BUNGIE_API_KEY__: JSON.stringify(""),
      __BUNGIE_OAUTH_CLIENT_ID__: JSON.stringify(""),
      __BUNGIE_OAUTH_CLIENT_SECRET__: JSON.stringify(""),
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
// Escape HTML script boundaries without changing the JavaScript string value.
const embeddedWorker = JSON.stringify(workerSource).replaceAll('<', '\\u003c');
html = html.replace(jsTag[0], () => `<script type="module">\nglobalThis.__ARMOR_OFFLINE_WORKER_SOURCE__ = ${embeddedWorker};\n${js}\n</script>`);

// The inlined page must not fetch anything extra: no external tags, no
// runtime dynamic import(). The external worker asset is unused: its embedded
// equivalent above is the only worker source used on file://.
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

// The offline app lives at the archive root, unlike the website's app/ entry.
html = html.replaceAll('../guide/', './guide/index.html');
await writeFile(htmlPath, html);
// Build the guide as one inline module too, so file:// needs no module fetches.
const guideBuild = await build({
  configFile: false,
  define: baseConfig.define,
  build: {
    write: false,
    rollupOptions: {
      input: path.join(projectRoot, 'src', 'guide.mjs'),
      output: { codeSplitting: false },
    },
  },
});
let guideHtml = await readFile(path.join(projectRoot, 'guide', 'index.html'), 'utf8');
const guideJs = guideBuild.output.find(entry => entry.type === 'chunk').code;
const guideCss = guideBuild.output.find(entry => entry.fileName.endsWith('.css')).source;
guideHtml = guideHtml.replace('<script type="module" src="../src/guide.mjs"></script>',
  `<style>${guideCss}</style><script type="module">${guideJs}</script>`)
  .replaceAll('../app/', '../index.html');
await mkdir(path.join(outDir, 'guide'), { recursive: true });
await writeFile(path.join(outDir, 'guide', 'index.html'), guideHtml);
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
