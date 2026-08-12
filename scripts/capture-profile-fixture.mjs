// Capture the authenticated user's real Destiny 2 profile via the Bungie API
// and save it as tests/fixtures/profile-fixture.json — the T7 fixture that
// backs the bungie-inventory tests (T8/T9). The saved payload is the full raw
// GetProfile response, sanitized by sanitizeProfileFixture: instance ids,
// account names and long numeric ids are masked, while item hashes / stats /
// bucketHash / plugHash are left untouched for test assertions.
// ARMOR_COMPONENTS includes ItemReusablePlugs (component 310), so the capture
// also retains per-instance, per-socketIndex candidate plugs plus the
// profilePlugSets / characterPlugSets unlock data (both ride along with
// ItemSockets and are sanitized like any other long-id-keyed map).
//
// Prerequisites — register an application in the Bungie portal first
// (https://www.bungie.net/en/Application, Confidential client; register
// http://localhost:5173/ as Origin and Redirect URL), then obtain an OAuth
// refresh token by logging in once through the dev app (npm run dev) and
// copying refresh_token from the browser's localStorage key
// `d2_armor_bungie_token_v1` (see tests/fixtures/fixture-readme.md).
//
// Usage (Windows PowerShell):
//   $env:BUNGIE_API_KEY="<api key>"; $env:BUNGIE_OAUTH_CLIENT_ID="<client id>";
//   $env:BUNGIE_OAUTH_CLIENT_SECRET="<client secret>";
//   $env:BUNGIE_OAUTH_REFRESH_TOKEN="<refresh token>";
//   node scripts/capture-profile-fixture.mjs
//
// This is a one-shot maintainer tool; it never runs in CI (no credentials
// there). Without credentials it prints a Chinese hint and exits 1.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ARMOR_COMPONENTS } from "../src/core/bungie-inventory.mjs";

const PLATFORM = "https://www.bungie.net/Platform";
const FIXTURE_URL = new URL("../tests/fixtures/profile-fixture.json", import.meta.url);

// ---- sanitization (exported for unit tests) ----

export const MOCK_GUARDIAN_NAME = "MockGuardian";

// Membership display-name keys that identify a real account.
const ACCOUNT_NAME_KEYS = new Set([
  "displayName",
  "bungieGlobalDisplayName",
  "lastSeenDisplayName",
  "uniqueName",
  "normalizedName",
  "psnDisplayName",
  "xboxDisplayName",
  "fbDisplayName",
  "blizzardDisplayName",
]);

const DIGITS_ONLY = /^\d+$/;

// Maps under data.itemComponents.<component>.data are keyed by instanceId.
const isInstanceMap = path =>
  path.length >= 3 && path.at(-1) === "data" && path.at(-3) === "itemComponents";

// Maps under data.characters | characterInventories | characterEquipment |
// characterPlugSets .data are keyed by characterId.
const CHARACTER_MAP_KEYS = new Set([
  "characters",
  "characterInventories",
  "characterEquipment",
  "characterPlugSets",
]);
const isCharacterMap = path =>
  path.length >= 2 && path.at(-1) === "data" && CHARACTER_MAP_KEYS.has(path.at(-2));

// Deep-copy a GetProfile response (full envelope, ErrorCode + Response) with
// account-identifying data masked:
//   - instanceIds (16-20 digit strings) -> sequential "1000000000000000NNN"
//     placeholders, string type preserved, identical across items and the
//     itemComponents maps (instances / sockets / plugStates keys);
//   - displayName / bungieGlobalDisplayName and the other account-name keys
//     -> "MockGuardian";
//   - every other long digit string (membershipId, characterId, ...) keeps
//     its length but is masked to "9<zero-padded sequence>" (injective, so
//     character map keys and characterId values stay consistent);
//   - itemHash / stats / bucketHash / plugHash and all numbers are untouched.
export function sanitizeProfileFixture(response) {
  const instanceIds = new Map();
  const maskedIds = new Map();
  let instanceSeq = 0;
  let maskedSeq = 0;

  const instancePlaceholder = real => {
    let placeholder = instanceIds.get(real);
    if (placeholder === undefined) {
      placeholder = `1000000000000000${String(++instanceSeq).padStart(3, "0")}`;
      instanceIds.set(real, placeholder);
    }
    return placeholder;
  };

  const maskedPlaceholder = real => {
    let placeholder = maskedIds.get(real);
    if (placeholder === undefined) {
      placeholder = `9${String(++maskedSeq).padStart(real.length - 1, "0")}`;
      maskedIds.set(real, placeholder);
    }
    return placeholder;
  };

  const walk = (node, key, path) => {
    if (typeof node === "string") {
      if (ACCOUNT_NAME_KEYS.has(key)) return MOCK_GUARDIAN_NAME;
      if (DIGITS_ONLY.test(node) && node.length >= 15) {
        // Stat hashes (10 digits) and other short digit strings are never touched.
        return key === "itemInstanceId" || instanceIds.has(node)
          ? instancePlaceholder(node)
          : maskedPlaceholder(node);
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, index, [...path, index]));
    if (node === null || typeof node !== "object") return node;

    const out = {};
    if (isInstanceMap(path) || isCharacterMap(path)) {
      const placeholder = isInstanceMap(path) ? instancePlaceholder : maskedPlaceholder;
      for (const [id, value] of Object.entries(node)) {
        out[placeholder(String(id))] = walk(value, id, [...path, id]);
      }
      return out;
    }
    for (const [childKey, value] of Object.entries(node)) {
      out[childKey] = walk(value, childKey, [...path, childKey]);
    }
    return out;
  };

  return walk(response, "response", []);
}

// ---- capture flow (runs only when executed directly) ----

function requireEnv() {
  const missing = [
    ["BUNGIE_API_KEY", process.env.BUNGIE_API_KEY],
    ["BUNGIE_OAUTH_CLIENT_ID", process.env.BUNGIE_OAUTH_CLIENT_ID],
    ["BUNGIE_OAUTH_CLIENT_SECRET", process.env.BUNGIE_OAUTH_CLIENT_SECRET],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    console.error(`请先设置环境变量 ${missing.join("、")}（在 Bungie 门户注册应用后取得，见 tests/fixtures/fixture-readme.md）。`);
    process.exit(1);
  }
}

// Bungie has no client-credentials grant: the access token must come from a
// refresh token minted by a real user login (dev app localStorage
// `d2_armor_bungie_token_v1`). Token endpoint requires
// application/x-www-form-urlencoded, never a JSON body.
async function getAccessToken() {
  const refreshToken = process.env.BUNGIE_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) {
    console.error("缺少 BUNGIE_OAUTH_REFRESH_TOKEN（OAuth 刷新令牌）。获取方式：npm run dev 启动应用并完成一次 Bungie 登录，从浏览器 localStorage 的 d2_armor_bungie_token_v1 中复制 refresh_token，设为环境变量后重试。");
    process.exit(1);
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.BUNGIE_OAUTH_CLIENT_ID,
    client_secret: process.env.BUNGIE_OAUTH_CLIENT_SECRET,
  });
  const res = await fetch(`${PLATFORM}/App/OAuth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`OAuth 令牌交换失败：HTTP ${res.status}`);
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`OAuth 令牌交换失败：${json.error_description || json.error || "未知错误"}`);
  }
  return json.access_token;
}

// Bungie API GET with the X-API-Key header and the standard envelope check;
// returns the full envelope so the raw profile payload can be sanitized.
async function getJson(path, token) {
  const res = await fetch(`${PLATFORM}${path}`, {
    headers: {
      "X-API-Key": process.env.BUNGIE_API_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path}：HTTP ${res.status}`);
  const json = await res.json();
  if (json.ErrorCode !== 1) throw new Error(`${path}：${json.ErrorStatus} ${json.Message || ""}`);
  return json;
}

// cross-save semantics: crossSaveOverride (number) points at the primary
// account's membershipId (int64 string) — compare with String() on both
// sides. Falls back to the first member when not cross-save.
function resolvePrimaryMembership(memberships) {
  if (!memberships || memberships.length === 0) {
    throw new Error("当前账号没有关联任何 Destiny 平台档案（destinyMemberships 为空）。");
  }
  const primary = memberships.find(
    member => member.crossSaveOverride > 0 &&
      memberships.some(other => String(other.membershipId) === String(member.crossSaveOverride)),
  );
  return primary ?? memberships[0];
}

// The real GetProfile envelope puts components directly under Response
// (verified 2026-08-09): no extra .data wrapper at the top level.
function envelopeData(envelope) {
  return envelope?.Response?.data ?? envelope?.Response ?? {};
}

function countProfileItems(envelope) {
  const data = envelopeData(envelope);
  let count = data.profileInventory?.data?.items?.length ?? 0;
  for (const inventory of Object.values(data.characterInventories?.data ?? {})) {
    count += inventory?.items?.length ?? 0;
  }
  for (const equipment of Object.values(data.characterEquipment?.data ?? {})) {
    count += equipment?.items?.length ?? 0;
  }
  return count;
}

function countProfileInstances(envelope) {
  const data = envelopeData(envelope);
  const ids = new Set();
  for (const item of data.profileInventory?.data?.items ?? []) {
    if (item?.itemInstanceId) ids.add(String(item.itemInstanceId));
  }
  for (const inventory of Object.values(data.characterInventories?.data ?? {})) {
    for (const item of inventory?.items ?? []) {
      if (item?.itemInstanceId) ids.add(String(item.itemInstanceId));
    }
  }
  for (const equipment of Object.values(data.characterEquipment?.data ?? {})) {
    for (const item of equipment?.items ?? []) {
      if (item?.itemInstanceId) ids.add(String(item.itemInstanceId));
    }
  }
  return ids.size;
}

async function main() {
  requireEnv();
  const token = await getAccessToken();

  const memberships = (await getJson("/User/GetMembershipsForCurrentUser/", token))
    .Response?.destinyMemberships ?? [];
  const membership = resolvePrimaryMembership(memberships);
  console.error(`账号：${membership.displayName}（平台 ${membership.membershipType}）`);

  const components = ARMOR_COMPONENTS.join(",");
  const envelope = await getJson(
    `/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=${components}`,
    token,
  );

  const sanitized = sanitizeProfileFixture(envelope);
  await writeFile(FIXTURE_URL, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  console.log(`Fixture written: ${countProfileItems(envelope)} items, ${countProfileInstances(envelope)} instances sanitized`);
  const data = envelopeData(envelope);
  const itemComponents = data.itemComponents || {};
  if (!itemComponents.stats) {
    console.warn("注意：响应缺少 itemComponents.itemStats，无法做 Bungie ↔ DIM CSV 差分核对（见 fixture-readme）。");
  }
  if (!itemComponents.reusablePlugs) {
    console.warn("注意：响应缺少 itemComponents.reusablePlugs，无法推导每件护甲的插槽候选与固定调谐属性。");
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`抓取失败：${error.message || error}`);
    process.exit(1);
  });
}
