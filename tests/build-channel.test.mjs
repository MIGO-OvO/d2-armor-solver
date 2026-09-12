import test from "node:test";
import assert from "node:assert/strict";

import { channelStorageKey } from "../src/core/build-channel.mjs";
import { LEGACY_SAVED_BUILDS_KEYS, SHARED_SAVED_BUILDS_KEY, STORAGE_KEYS } from "../src/core/build-repository.mjs";

test("stable channel preserves existing storage keys", () => {
  assert.equal(
    channelStorageKey("d2_armor_saved_builds", "stable"),
    "d2_armor_saved_builds",
  );
  assert.equal(channelStorageKey("bungieOAuthState", "stable"), "bungieOAuthState");
});

test("development channel namespaces solver and OAuth storage", () => {
  assert.equal(
    channelStorageKey("d2_armor_saved_builds", "develop"),
    "d2_armor_dev_saved_builds",
  );
  assert.equal(
    channelStorageKey("bungieOAuthState", "develop"),
    "d2_armor_dev:bungieOAuthState",
  );
});

// Saved Builds are user data, not channel state. They are the one exception to
// the channel split: the reader must find the same loadouts from /app/ and from
// /dev/app/. Only mutable/derived state (drafts, calculator mode, OAuth) is
// namespaced.
test("saved builds are shared across channels while mutable state is not", () => {
  assert.equal(STORAGE_KEYS.savedBuilds, SHARED_SAVED_BUILDS_KEY);
  assert.doesNotMatch(STORAGE_KEYS.savedBuilds, /_dev_/);
  assert.notEqual(STORAGE_KEYS.savedBuilds, STORAGE_KEYS.currentDraft);
  // The two historical channel keys are still recognized for migration only.
  assert.deepEqual([...LEGACY_SAVED_BUILDS_KEYS], ["d2_armor_saved_builds", "d2_armor_dev_saved_builds"]);
});
