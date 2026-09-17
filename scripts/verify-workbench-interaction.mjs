// Behavioral regressions against a built site. No account data or network writes.
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {preview} from 'vite';

let executablePath;
for (const candidate of [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* next */ }
}
assert.ok(executablePath, 'Set CHROME_PATH to an installed Chrome/Edge');
const server = await preview({preview: {host: '127.0.0.1', port: 0, strictPort: true}});
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({executablePath, headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  await context.route('**/*', route => /^https?:/.test(route.request().url())
    && !route.request().url().startsWith(`${origin}/`) ? route.abort() : route.continue());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/app/`);
  assert.match(await page.locator('#searchStatus').textContent(), /等待开始/);
  // Opening and closing is safe; do not submit or clear any saved records.
  await page.evaluate(() => {
    document.getElementById('pageLanguage').focus();
    globalThis.openSavedBuildsDrawer();
  });
  assert.equal(await page.evaluate(() => document.getElementById('savedBuildsDrawer').contains(document.activeElement)), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.getElementById('savedBuildsDrawer').contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pageLanguage');
  assert.equal(await page.locator('[inert]').count(), 0);

  await page.locator('#modeUpgradeButton').click();
  const row = page.locator('#upgradeBuildEditor .upgrade-piece-row').first();
  await row.locator('summary').click();
  await row.locator('.field-tertiary select').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.matches('.field-tertiary select')), true);
  await page.locator('#modeSolveButton').click();
  await page.locator('#btnSolve').click();
  await page.waitForFunction(() => document.querySelectorAll('#planList [role="option"]').length > 1
    && document.getElementById('btnSolve').disabled === false, null, {timeout: 30000});
  assert.equal(await page.locator('#planList [tabindex="0"]').count(), 1);
  const current = page.locator('#planList [tabindex="0"]');
  await current.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.planIndex), '1');
  assert.equal(await page.locator('#planList [aria-selected="true"]').getAttribute('data-plan-index'), '1');
  assert.equal(await page.locator('.inventory-result-pieces [role="cell"]').count(), 30);
  assert.equal(await page.locator('.inventory-result-pieces [role="rowheader"]').count(), 5);
  await page.evaluate(() => globalThis.saveBuild());
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.getElementById('saveBuildDialog').contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.planIndex), '1');
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(errors, []);
  console.log('Workbench keyboard, modal, editor, status and narrow-screen checks passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
