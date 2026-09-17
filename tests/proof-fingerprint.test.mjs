import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {proofFingerprint} from '../src/core/proof-fingerprint.mjs';

test('proof digest matches independent SHA-256 across UTF-8 and padding boundaries', () => {
  assert.equal(proofFingerprint('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 1000000]) {
    for (const unit of ['a', '护甲🙂']) {
      const text = unit.repeat(length);
      assert.equal(proofFingerprint(text), createHash('sha256').update(text).digest('hex'));
    }
  }
});
