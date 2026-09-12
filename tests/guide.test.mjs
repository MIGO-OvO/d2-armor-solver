import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GUIDE_CONTENT } from '../src/guide-content.mjs';

const anchors = ['quick-start', 'dim-import', 'scratch', 'upgrade', 'fragments', 'targets',
  'exotics', 'sets', 'results', 'farming', 'replacement', 'dim-export', 'bungie-equip',
  'saved-builds', 'search-depth', 'faq', 'disclaimer'];

test('all guide languages cover the same stable anchors with substantive copy', () => {
  for (const copy of Object.values(GUIDE_CONTENT)) {
    assert.deepEqual(copy.sections.map(section => section[0]), anchors);
    for (const [id, title, body] of copy.sections) {
      assert.ok(title && body.length > 70, id);
      for (const [, target] of body.matchAll(/href="#([^"]+)"/g)) assert.ok(anchors.includes(target));
    }
  }
});

test('help links stay relative and the old help drawer is removed', async () => {
  const html = await readFile('app/index.html', 'utf8');
  const app = await readFile('src/app.mjs', 'utf8');
  assert.match(html, /<a[^>]+id="userGuideLink" href="\.\.\/guide\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="\.\.\/guide\/#disclaimer"/);
  assert.match(app, /href="\.\.\/guide\/#dim-import"/);
  assert.doesNotMatch(html + app, /programIntroDrawer|openProgramIntro|toggleDimImportHelp/);
  for (const prefix of ['/app/', '/dev/app/', '/repo/app/', '/repo/dev/app/']) {
    assert.equal(new URL('../guide/', `https://example.org${prefix}`).pathname, prefix.replace(/app\/$/, 'guide/'));
  }
});
