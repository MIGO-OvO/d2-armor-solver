import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright-core";

// Dedicated WebView2 profile: never load or modify the user's real desktop data.
await mkdir(".audit/desktop", { recursive: true });
const profile = await mkdtemp(path.resolve(".audit/desktop/native-profile-"));
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
const executable = path.resolve("src-tauri/target/x86_64-pc-windows-msvc/release/d2-armor-solver-desktop.exe");
const child = spawn(executable, [], { windowsHide: true, stdio: "pipe", env: {
  ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: profile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} });
let launchError;
child.on("error", error => { launchError = error; });
let browser;
try {
  const deadline = Date.now() + 30000;
  let connected = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Native app exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) { connected = true; break; }
    } catch { /* WebView2 is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(connected, "Native WebView2 must start within 30s");
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent("page");
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  // Reload after attaching so startup errors and all Worker requests are observed.
  await page.locator(".desktop-nav button:not([disabled])").first().waitFor({ timeout: 30000 });
  await page.reload();
  await page.locator(".desktop-nav button:not([disabled])").first().waitFor({ timeout: 30000 });
  assert.match(page.url(), /^https?:\/\/tauri\.localhost\//);
  assert.equal(await page.evaluate(() => typeof window.__TAURI_INTERNALS__.invoke), "function");
  assert.equal(await page.locator(".desktop-nav #pageLanguage").count(), 1);
  assert.equal(await page.locator("#pageTitle").isVisible(), false);
  assert.equal(await page.locator(".notice--free").isVisible(), false);
  await page.screenshot({ path: ".audit/desktop/native-initial.png" });
  await page.locator("#btnSolve").click();
  await page.locator("#results.show").waitFor({ timeout: 60000 });
  await page.locator("#btnSolve:not([disabled])").waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#comparisonGrid .comp-item").count(), 6);
  assert.ok(page.workers().some(worker => worker.url().includes("armor-engine.worker")));
  // Read both rectangles in one frame, since the solver scrolls to results smoothly.
  const singleColumn = await page.evaluate(() => {
    const inputs = document.querySelector(".desktop-inputs").getBoundingClientRect();
    const output = document.querySelector(".desktop-output").getBoundingClientRect();
    return Math.abs(output.x - inputs.x) < 2 && output.y >= inputs.bottom - 1;
  });
  assert.ok(singleColumn);
  // Reject an unsupported destination without opening any browser or sending data.
  const denied = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("plugin:opener|open_url", { url: "https://example.com/" });
      return false;
    } catch { return true; }
  });
  assert.ok(denied, "Native opener must reject non-allowlisted URLs");
  await page.screenshot({ path: ".audit/desktop/native-results.png" });
  assert.deepEqual(errors, [], "Native runtime must not report JavaScript or CSP errors");
  console.log("Native WebView2 OK: embedded assets, Tauri IPC, CSP, Worker solve, denied external destination.");
} finally {
  await browser?.close();
  child.kill();
}
