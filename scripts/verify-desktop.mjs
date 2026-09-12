import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { preview } from "vite";

const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const candidates = [process.env.CHROME_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* Try next browser. */ }
}
if (!executablePath) throw new Error("Set CHROME_PATH to Chrome or Edge");
const server = await preview({ configFile: "desktop/vite.config.mjs", preview: {
  host: "127.0.0.1", port: 5179, strictPort: true,
  headers: { "Content-Security-Policy": config.app.security.csp },
} });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const external = [];
  const workers = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("worker", worker => workers.push(worker.url()));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith("http://127.0.0.1:5179/")) {
      external.push(url);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("http://127.0.0.1:5179/");
  await page.locator(".desktop-nav button:not([disabled])").first().waitFor();
  assert.equal(await page.locator("#headerBungieAuth").innerText(), "");
  assert.equal(await page.locator(".desktop-nav #pageLanguage").count(), 1);
  assert.equal(await page.locator("#pageTitle").isVisible(), false);
  assert.equal(await page.locator(".notice--free").isVisible(), false);
  const languageBox = await page.locator("#pageLanguage").boundingBox();
  const navBox = await page.locator(".desktop-nav").boundingBox();
  assert.ok(languageBox.x >= navBox.x && languageBox.x + languageBox.width <= navBox.x + navBox.width,
    "Language control must be visually inside the sidebar, not just nested in its DOM");
  await mkdir(".audit/desktop", { recursive: true });
  await page.screenshot({ path: ".audit/desktop/initial-1440.png" });
  await page.locator("#btnSolve").click();
  await page.locator("#results.show").waitFor({ timeout: 60000 });
  await page.locator("#btnSolve:not([disabled])").waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#comparisonGrid .comp-item").count(), 6);
  assert.ok(workers.some(url => url.includes("armor-engine.worker")), "Desktop must use a Worker");
  assert.equal(await page.locator(".desktop-empty").count(), 0);
  // Save and reopen through the actual UI, not a synthetic localStorage write.
  const savedPlansNav = page.getByRole("navigation").getByRole("button", { name: "已保存方案", exact: true });
  await page.locator("#saveBuildButton").click();
  await page.locator("#saveBuildDialog:not([hidden])").waitFor();
  await page.locator("#saveBuildName").fill("Desktop regression");
  await page.locator("#saveBuildDialog button[type=submit]").click();
  await savedPlansNav.click();
  await page.locator("#savedBuildsDrawer:not([hidden])").waitFor();
  await page.locator("#savedBuildsList .saved-item", { hasText: "Desktop regression" }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#savedBuildsDrawer").waitFor({ state: "hidden" });
  // A write that does not land must be reported, never silently swallowed.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function blocked() {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    };
    window.__restoreSetItem = () => { Storage.prototype.setItem = original; };
  });
  await page.locator("#saveBuildButton").click();
  await page.locator("#saveBuildName").fill("Desktop quota failure");
  await page.locator("#saveBuildDialog button[type=submit]").click();
  await page.locator("#saveBuildDialogStatus .msg.error").waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__restoreSetItem());
  await savedPlansNav.click();
  await page.locator("#savedBuildsDrawer:not([hidden])").waitFor();
  assert.equal(
    await page.locator("#savedBuildsList .saved-item", { hasText: "Desktop quota failure" }).count(),
    0,
    "a failed save must not appear as a saved loadout",
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator(".desktop-nav button:not([disabled])").first().waitFor();
  await savedPlansNav.click();
  await page.locator("#savedBuildsList .saved-item", { hasText: "Desktop regression" })
    .locator(".saved-item-load").click();
  await page.locator("#savedBuildsDrawer").waitFor({ state: "hidden" });
  await page.locator("#pageLanguage").selectOption("en");
  await page.getByRole("navigation").getByRole("button", { name: "Optimize loadout", exact: true }).click();
  assert.equal(await page.locator("#upgradeBuildCard").isVisible(), true);
  await page.locator("#pageLanguage").selectOption("zh-cht");
  await page.getByRole("navigation").getByRole("button", { name: "從零求解", exact: true }).click();
  await page.locator("#pageLanguage").selectOption("zh-chs");
  // The React command delegates directly to the real file picker.
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("navigation").getByRole("button", { name: "导入 DIM CSV" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([]);
  await page.keyboard.press("Control+Enter");
  await page.locator("#results.show").waitFor({ timeout: 60000 });
  await page.locator("#btnSolve:not([disabled])").waitFor({ timeout: 60000 });

  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [1024, 768], [800, 600], [640, 540]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `.audit/desktop/results-${width}.png` });
    const overflow = await page.evaluate(() => [...document.querySelectorAll(".desktop-inputs, .desktop-output")]
      .filter(element => element.scrollWidth > element.clientWidth + 2)
      .map(element => ({
        panel: element.className,
        width: element.clientWidth,
        content: element.scrollWidth,
        // Name the widest offending descendants: a panel-level number alone
        // cannot tell which row or grid is over its budget.
        offenders: [...element.querySelectorAll("*")]
          .filter(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1)
          .sort((left, right) =>
            (right.scrollWidth - right.clientWidth) - (left.scrollWidth - left.clientWidth))
          .slice(0, 5)
          .map(node => ({
            tag: node.tagName,
            cls: String(node.className || "").slice(0, 48),
            client: node.clientWidth,
            scroll: node.scrollWidth,
          })),
      })));
    assert.deepEqual(overflow, [], `Panels must not overflow at ${width}px`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    if (width >= 1024) {
      // The plan browser is a bounded workspace inside the desktop shell too.
      // The shell's scrollport is shorter than the viewport (60px topbar + 30px
      // status bar), so its cap must leave room for the sticky offset and the
      // container's bottom padding, or the panel could not fit once pinned.
      const planBrowser = await page.evaluate(() => {
        const panel = document.getElementById("planBrowser");
        const list = document.getElementById("planList");
        if (!panel || !list) return null;
        const workspace = document.querySelector(".desktop-workspace");
        const box = panel.getBoundingClientRect();
        return {
          position: getComputedStyle(panel).position,
          height: Math.round(box.height),
          // The sticky offset is measured from the real command bar, so the
          // budget has to follow it rather than assume a constant.
          stickyOffset: parseFloat(getComputedStyle(panel).top) || 0,
          workspaceHeight: Math.round(workspace.getBoundingClientRect().height),
          workspaceOverflowY: getComputedStyle(workspace).overflowY,
          rows: list.querySelectorAll(".inventory-result-option").length,
          listScrolls: list.scrollHeight > list.clientHeight,
        };
      });
      assert.ok(planBrowser, `the desktop shell must render the plan browser at ${width}px`);
      assert.equal(planBrowser.position, "sticky", `the plan browser must be a sticky workspace at ${width}px`);
      assert.ok(planBrowser.height <= 780,
        `the plan browser must stay bounded at ${width}px: ${planBrowser.height}`);
      assert.ok(planBrowser.height <= planBrowser.workspaceHeight - planBrowser.stickyOffset - 24 + 2,
        `the plan browser must fit the desktop workspace once pinned at ${width}px: `
        + JSON.stringify(planBrowser));
      assert.equal(planBrowser.workspaceOverflowY, "auto", "the desktop workspace owns the page scroll");
      // The list is the only thing that scrolls vertically inside the panel.
      const pinnedList = await page.evaluate(() => {
        const list = document.getElementById("planList");
        list.scrollTop = 400;
        return {
          listScrollTop: list.scrollTop,
          pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
          workspaceScrollTop: document.querySelector(".desktop-workspace").scrollTop,
        };
      });
      assert.ok(pinnedList.listScrollTop > 0,
        `the plan list must own its own vertical scroll inside the desktop shell at ${width}px`);
      assert.ok(pinnedList.pageOverflowX <= 2,
        `the desktop shell must not overflow horizontally at ${width}px`);
      assert.ok(planBrowser.rows > 0, "the desktop plan browser must list plans");
      if (planBrowser.rows > 12) {
        assert.ok(planBrowser.listScrolls,
          "the plan list must scroll internally instead of growing the desktop panel");
      }
      const listOverflow = await page.evaluate(() => {
        const list = document.getElementById("planList");
        return {
          client: list.clientWidth,
          scroll: list.scrollWidth,
          offenders: [...list.querySelectorAll("*")]
            .filter(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1)
            .sort((left, right) =>
              (right.scrollWidth - right.clientWidth) - (left.scrollWidth - left.clientWidth))
            .slice(0, 6)
            .map(node => ({
              tag: node.tagName,
              cls: String(node.className || "").slice(0, 48),
              client: node.clientWidth,
              scroll: node.scrollWidth,
            })),
        };
      });
      assert.ok(listOverflow.scroll <= listOverflow.client + 2,
        `the plan list must not overflow horizontally at ${width}px: ` + JSON.stringify(listOverflow));
    }
    const singleColumn = await page.evaluate(() => {
      const inputs = document.querySelector(".desktop-inputs").getBoundingClientRect();
      const output = document.querySelector(".desktop-output").getBoundingClientRect();
      return Math.abs(output.x - inputs.x) < 2 && output.y >= inputs.bottom - 1;
    });
    assert.ok(singleColumn, "Parameters and results must share one vertical column");
    assert.equal(await page.locator(".desktop-inputs").evaluate(element => getComputedStyle(element).overflowY), "visible");
    assert.equal(await page.locator(".desktop-output").evaluate(element => getComputedStyle(element).overflowY), "visible");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("navigation").getByRole("button", { name: "优化现有配装", exact: true }).click();
  await page.locator("#btnUpgradeAnalyze").click();
  await page.locator("#upgradeResults:not([hidden])").waitFor({ timeout: 60000 });
  await page.locator("#btnUpgradeAnalyze:not([disabled])").waitFor({ timeout: 60000 });
  const csv = [
    "Name,Hash,Id,Rarity,Tier,Type,Equippable,Archetype,Tertiary Stat,Tuning Stat,Masterwork Tier,Owner,Equipped,Weapons,Health,Class,Grenade,Super,Melee,Weapons (Base),Health (Base),Class (Base),Grenade (Base),Super (Base),Melee (Base)",
    "Desktop test armor,656307180,desktop-test-1,Legendary,5,Helmet,Hunter,Powerhouse,super,melee,0,Vault,false,0,0,30,20,0,25,0,0,30,20,0,25",
  ].join("\n");
  await page.locator("#dimCsvFile").setInputFiles({ name: "desktop-test.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.locator(".upgrade-import-state", { hasText: "已导入 1 件" }).waitFor();
  await page.reload();
  await page.locator(".upgrade-import-state", { hasText: "已导入 1 件" }).waitFor();
  assert.deepEqual(external, [], "No network dependencies");
  assert.deepEqual(errors, [], "No runtime or CSP errors");
  console.log("Desktop OK: CSP, offline resources, Worker, save/reload, three languages, upgrade solve, CSV import/reload, keyboard, six window sizes.");
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
