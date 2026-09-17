import assert from 'node:assert/strict';
import test from 'node:test';
import {proofPresentation} from '../src/core/solver-presentation.mjs';

test('search lifecycle never mistakes an unfinished or cancelled search for budget exhaustion', () => {
  const result = {certificate: {status: 'SEARCH_LIMIT_REACHED'}};
  assert.equal(proofPresentation(result, {running: true}).key, 'searching');
  assert.equal(proofPresentation(result, {running: false, termination: 'cancelled'}).key, 'cancelled');
  assert.equal(proofPresentation(result, {running: false, termination: 'budget'}).key, 'limited');
  assert.equal(proofPresentation(result, {running: false, termination: 'completed'}).key, 'unproven');
});
