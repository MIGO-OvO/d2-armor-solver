import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {ARMOR_ITEMS, ARMOR_ITEMS_MANIFEST_VERSION} from '../src/core/armor-items.data.mjs';
import {ARMOR_SETS_MANIFEST_VERSION} from '../src/core/armor-sets.data.mjs';

test('bundled item/set snapshots identify one manifest and unique catalog records', () => {
  assert.equal(ARMOR_ITEMS_MANIFEST_VERSION, ARMOR_SETS_MANIFEST_VERSION,
    'refresh the catalog snapshots together, or explicitly document the version skew');
  assert.ok(ARMOR_ITEMS.length > 0);
  assert.equal(new Set(ARMOR_ITEMS.map(item => item.hash)).size, ARMOR_ITEMS.length);
  for (const item of ARMOR_ITEMS) {
    assert.ok(Number.isSafeInteger(item.hash) && item.hash > 0);
    for (const lang of ['zh', 'zhCht', 'en']) assert.equal(typeof item.name[lang], 'string');
  }
});

test('the workbench static module graph does not eagerly import the armor catalog', () => {
  const visited = new Set();
  const walk = url => {
    if (visited.has(url.href) || !url.pathname.endsWith('.mjs')) return;
    visited.add(url.href);
    const source = readFileSync(url, 'utf8');
    for (const match of source.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm)) {
      if (match[1].startsWith('.')) walk(new URL(match[1], url));
    }
  };
  walk(new URL('../src/app.mjs', import.meta.url));
  assert.ok(visited.size > 10, 'the guard must inspect transitive imports, not just the entry');
  assert.equal([...visited].some(url => url.endsWith('/armor-items.data.mjs')), false);
});
