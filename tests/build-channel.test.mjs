import test from "node:test";
import assert from "node:assert/strict";

import { channelStorageKey } from "../src/core/build-channel.mjs";

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
