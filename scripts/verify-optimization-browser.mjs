// Real-browser scheduling/response checks against an already built site.
// No account data or remote requests are used. Run after npm run build.
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {preview} from 'vite';

const candidates = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* next */ }
}
if (!executablePath) throw new Error('Set CHROME_PATH to Chrome or Edge');
const server = await preview({preview: {host: '127.0.0.1', port: 0, strictPort: true}});
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({executablePath, headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const errors = [], remoteRequests = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith(`${origin}/`)) {
      remoteRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    const state = globalThis.__optimizationProbe = {workers: 0, requests: [], gaps: [], longTasks: [], active: false};
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        state.workers++;
        this.addEventListener('message', ({data}) => {
          if (data.type !== 'result' && data.type !== 'error') return;
          const request = state.requests.find(r => r.id === data.id);
          if (request) Object.assign(request, {completed: true, status: data.result?.status, error: data.error?.name});
        });
      }
      postMessage(data, ...rest) {
        if (data?.type === 'start') state.requests.push({id: data.id, operation: data.operation, completed: false});
        return super.postMessage(data, ...rest);
      }
    };
    let previous = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (state.active) state.gaps.push(now - previous);
      previous = now;
    }, 10);
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver(list => {
        if (state.active) state.longTasks.push(...list.getEntries().map(entry => entry.duration));
      }).observe({type: 'longtask'});
    }
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/app/`);
  await page.locator('#btnSolve').waitFor();
  await page.evaluate(() => {
    const exotic = document.getElementById('useExoticMode');
    exotic.checked = true;
    globalThis.toggleExoticMode();
    document.getElementById('target_health').value = 100;
    document.getElementById('target_melee').value = 50;
    document.getElementById('targetLock_health').checked = true;
    document.getElementById('targetLock_melee').checked = true;
    document.getElementById('target_health').dispatchEvent(new Event('input', {bubbles: true}));
    globalThis.__optimizationProbe.active = true;
  });
  await page.waitForFunction(() => globalThis.__optimizationProbe.requests.some(r =>
    r.operation === 'calculateReachability' && r.completed), null, {timeout: 15000});
  await page.waitForFunction(() => document.getElementById('rangeHint_health').textContent.length > 0,
    null, {timeout: 15000});
  const before = await page.evaluate(() => ({workers: globalThis.__optimizationProbe.workers,
    queries: globalThis.__optimizationProbe.requests.filter(r => r.operation === 'calculateReachability').length}));
  await page.evaluate(() => {
    const input = document.getElementById('target_weapons');
    input.value = Number(input.value) + 1;
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  // Wait past the actual 180ms debounce using a page timer; a blocked main
  // thread will also be visible in the heartbeat samples, not hidden by sleep.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  const cached = await page.evaluate(() => ({workers: globalThis.__optimizationProbe.workers,
    queries: globalThis.__optimizationProbe.requests.filter(r => r.operation === 'calculateReachability').length}));
  assert.deepEqual(cached, before, 'an unlocked target change must reuse the range and idle worker');

  const pendingPreview = await page.evaluate(() => {
    document.getElementById('target_health').dispatchEvent(new Event('input', {bubbles: true}));
    const count = globalThis.__optimizationProbe.requests.filter(r => r.operation === 'calculateReachability').length;
    globalThis.setSearchProfile('fast');
    void globalThis.solve();
    return count;
  });
  await page.waitForFunction(() => globalThis.__optimizationProbe.requests.some(r => r.operation === 'solve' && r.completed),
    null, {timeout: 15000});
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  assert.equal(await page.evaluate(() => globalThis.__optimizationProbe.requests.filter(r => r.operation === 'calculateReachability').length),
    pendingPreview, 'a pending preview timer must not restart after foreground solve');
  await page.evaluate(() => globalThis.stopSearches());
  const requestCount = await page.evaluate(() => globalThis.__optimizationProbe.requests.length);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  assert.equal(await page.evaluate(() => globalThis.__optimizationProbe.requests.length), requestCount,
    'stopping must not launch deferred work');

  const metrics = await page.evaluate(() => {
    const state = globalThis.__optimizationProbe;
    state.active = false;
    const sorted = [...state.gaps].sort((a, b) => a - b);
    return {workers: state.workers, requests: state.requests, heartbeatSamples: sorted.length,
      heartbeatP95Ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
      heartbeatMaximumMs: sorted.at(-1) || 0, longTasksMs: state.longTasks};
  });
  assert.ok(metrics.heartbeatSamples > 10);
  // A broad regression ceiling, not a Core Web Vitals claim. Record the real
  // samples below so device-specific latency can be compared separately.
  assert.ok(metrics.heartbeatP95Ms < 100, 'background work must preserve responsive event-loop service');
  assert.ok(metrics.heartbeatMaximumMs < 250, 'optimization interactions must not freeze for a quarter second');
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  const feasibility = [];
  for (const profile of ['fast', 'balanced', 'deep']) {
    // Fresh storage gives the six-exact default request which Fast previously
    // missed. Exercise the built Worker, certificate projection and real UI.
    const check = await browser.newContext({viewport: {width: profile === 'fast' ? 390 : 1440, height: 1000}});
    await check.route('**/*', route => {
      const url = route.request().url();
      if (/^https?:/.test(url) && !url.startsWith(`${origin}/`)) return route.abort();
      return route.continue();
    });
    const view = await check.newPage();
    view.on('pageerror', error => errors.push(error.message));
    await view.goto(`${origin}/app/`);
    await view.locator('#searchProfile').selectOption(profile);
    await view.locator('#btnSolve').click();
    await view.waitForFunction(() => !document.getElementById('btnSolve').disabled
      && globalThis.getSelectedUnifiedWitness?.()?.certificate?.status === 'EXACT_TARGET_PROVEN',
    null, {timeout: 15000});
    const evidence = await view.evaluate(() => ({
      statistics: document.getElementById('searchStatistics').textContent,
      totals: globalThis.getSelectedUnifiedWitness().visibleTotals,
      verified: globalThis.getSelectedUnifiedWitness().certificate.witnessVerification.valid,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }));
    assert.equal(evidence.verified, true);
    assert.deepEqual(evidence.totals, {health: 0, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100});
    assert.match(evidence.statistics, /[1-9]\d* (?:个候选方案|個候選方案|candidate loadouts)/);
    assert.doesNotMatch(evidence.statistics, /节点|節點|nodes/);
    assert.equal(evidence.overflow, false);
    feasibility.push({profile, ...evidence});
    await check.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({feasibility}, null, 2));
  console.log(JSON.stringify({environment: 'headless desktop Chrome/Edge, synthetic inputs, no CPU throttle', metrics}, null, 2));
  await context.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
