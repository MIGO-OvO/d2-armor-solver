/* global __BUILD_CHANNEL__, __BUILD_COMMIT_SHA__ */

const VALID_CHANNELS = new Set(["stable", "develop"]);

const injectedChannel = typeof __BUILD_CHANNEL__ === "string"
  ? __BUILD_CHANNEL__
  : "stable";

export const BUILD_CHANNEL = VALID_CHANNELS.has(injectedChannel)
  ? injectedChannel
  : "stable";

export const BUILD_COMMIT_SHA = typeof __BUILD_COMMIT_SHA__ === "string"
  ? __BUILD_COMMIT_SHA__
  : "";

export const IS_DEVELOPMENT_BUILD = BUILD_CHANNEL === "develop";

export function channelStorageKey(key, channel = BUILD_CHANNEL) {
  if (channel !== "develop") return key;
  if (key.startsWith("d2_armor_")) {
    return key.replace("d2_armor_", "d2_armor_dev_");
  }
  return `d2_armor_dev:${key}`;
}
