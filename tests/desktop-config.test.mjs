import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop installer uses system WebView2 without bundling or downloading a runtime", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const windows = config.bundle.windows;
  assert.deepEqual(windows.webviewInstallMode, { type: "skip" });
  assert.equal(windows.minimumWebview2Version, undefined, "Tauri's minimum-version updater requires the network");
  assert.equal(windows.nsis.installerHooks, undefined, "No custom runtime installer hook");
  assert.equal(config.build.frontendDist, "../dist-desktop");
  assert.deepEqual(config.bundle.targets, ["nsis"]);
});

test('Release publishes only the desktop installer; browser ZIP remains an Actions artifact', () => {
  const pages = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8');
  const desktop = readFileSync(new URL('../.github/workflows/desktop-windows.yml', import.meta.url), 'utf8');
  assert.match(pages, /offline-preview:/);
  assert.match(pages, /actions\/upload-artifact/);
  assert.doesNotMatch(pages, /offline-release:|action-gh-release|gh release upload/);
  assert.match(desktop, /gh release upload/);
  assert.match(desktop, /d2-armor-solver-windows-x64-setup\.exe/);
});
