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
