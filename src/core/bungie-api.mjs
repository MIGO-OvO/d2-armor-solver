/* global __BUNGIE_API_KEY__, __BUNGIE_OAUTH_CLIENT_ID__, __BUNGIE_OAUTH_CLIENT_SECRET__ */
// Bungie OAuth token client.
//
// The __BUNGIE_*__ identifiers are injected at build time by Vite define and
// are plain browser globals; tests inject fakes via globalThis.
//
// Module layout: token storage / helpers first, then the OAuth flows, then the
// errors, then the throttled bungieFetch wrapper (T4). T5 appends membership
// resolution at the bottom of this file.

export const TOKEN_STORAGE_KEY = "d2_armor_bungie_token_v1";

const TOKEN_ENDPOINT = "https://www.bungie.net/Platform/App/OAuth/token/";

// --- token storage (lazy localStorage: no top-level DOM access) ---

export function saveToken(token) {
  try {
    globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
  } catch {
    // storage unavailable (e.g. Firefox file://): token just won't persist
  }
}

export function getToken() {
  try {
    const raw = globalThis.localStorage?.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearToken() {
  try {
    globalThis.localStorage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}

export function hasToken() {
  return getToken() !== null;
}

// ponytail: expiry checks only the access window; a refresh whose refresh
// token is itself dead falls out via Bungie's invalid_grant -> FatalTokenError.
// A token missing a numeric expiresIn (corrupt storage) is treated as expired
// so it is never reused: `undefined + number` is NaN and NaN <= x is false.
export function isTokenExpired(token) {
  return !token || typeof token.expiresIn !== "number"
    || token.obtainedAt + token.expiresIn * 1000 <= Date.now();
}

// --- OAuth flows ---

export function buildAuthorizeUrl(state) {
  // Bungie rejects a scope parameter and only accepts the redirect_uri
  // registered in the Application portal, so neither is sent.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: __BUNGIE_OAUTH_CLIENT_ID__,
    state,
  });
  return `https://www.bungie.net/en/oauth/authorize?${params}`;
}

export async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: __BUNGIE_OAUTH_CLIENT_ID__,
    client_secret: __BUNGIE_OAUTH_CLIENT_SECRET__,
  });
  return postToken(body);
}

// Dedupe: only one refresh request runs at a time; every getValidAccessToken
// caller that races into it shares the same promise.
let refreshPromise = null;

async function refreshWithDedupe(refreshToken) {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: __BUNGIE_OAUTH_CLIENT_ID__,
        client_secret: __BUNGIE_OAUTH_CLIENT_SECRET__,
      });
      try {
        const refreshed = await postToken(body);
        if (!refreshed.refreshToken) {
          refreshed.refreshToken = refreshToken; // response replaced the whole token only when it carries one
        }
        saveToken(refreshed);
        return refreshed;
      } catch (error) {
        // Rejected grants mean the stored credential is dead; network errors
        // are transient and must leave the token untouched.
        if (error instanceof FatalTokenError) clearToken();
        throw error;
      }
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function getValidAccessToken() {
  const token = getToken();
  if (token && !isTokenExpired(token)) return token.accessToken;
  if (!token?.refreshToken) {
    clearToken();
    throw new FatalTokenError("No valid Bungie token; sign in again");
  }
  const refreshed = await refreshWithDedupe(token.refreshToken);
  return refreshed.accessToken;
}

// Shared POST of a form-encoded grant. Bungie replies with the token fields
// and ErrorCode 1 / ErrorStatus "Ok" on success; errors carry ErrorCode != 1
// (e.g. 99 / InvalidGrants). Network failures are not auth failures: they
// surface as NetworkError and must not clear the stored token.
async function postToken(body) {
  let res;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (cause) {
    throw new NetworkError("Bungie token request failed", { cause });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok || (data.ErrorCode !== undefined && data.ErrorCode !== 1)) {
    throw new FatalTokenError(data.ErrorStatus || `Token request failed (HTTP ${res.status})`);
  }
  if (typeof data.access_token !== "string") {
    throw new FatalTokenError("Token response missing access_token");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    bungieMembershipId: data.membership_id,
    expiresIn: data.expires_in,
    refreshExpiresIn: data.refresh_expires_in ?? null,
    obtainedAt: Date.now(),
  };
}

// --- errors ---

export class FatalTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalTokenError";
  }
}

export class NetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export class ApiError extends Error {
  constructor(data, status) {
    super(data?.ErrorStatus || `Bungie API error (ErrorCode ${data?.ErrorCode ?? "unknown"})`);
    this.name = "ApiError";
    this.errorCode = data?.ErrorCode ?? null;
    this.status = status ?? null;
    this.data = data ?? null;
  }
}

export class ThrottleError extends Error {
  constructor(retrySeconds) {
    super(`Bungie API throttled; retry after ${retrySeconds}s`);
    this.name = "ThrottleError";
    this.retrySeconds = retrySeconds;
  }
}

export class ApiKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiKeyError";
  }
}

// --- T4: throttled bungieFetch wrapper ---

const BUNGIE_API_BASE = "https://www.bungie.net/Platform";

const THROTTLE_CODES = new Set([36, 51]); // ThrottleLimitExceeded*, PerEndpointRequestThrottleExceeded

// Bungie throttles with HTTP 200 + ErrorCode 36/51 (ThrottleSeconds present)
// or any body carrying a numeric ThrottleSeconds field.
function throttleSeconds(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.ThrottleSeconds === "number") return data.ThrottleSeconds;
  if (THROTTLE_CODES.has(data.ErrorCode)) return 5; // no ThrottleSeconds: default wait
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Throttle-only retry loop. 401/expired-token responses are NOT retried here
// (that is the caller's responsibility, T10/T11); they surface as ApiError.
export async function bungieFetch(path, { auth = true, retries = 3 } = {}) {
  const url = path.startsWith("/") ? `${BUNGIE_API_BASE}${path}` : `${BUNGIE_API_BASE}/${path}`;
  const headers = { "X-API-Key": __BUNGIE_API_KEY__ };
  if (auth) {
    headers.Authorization = `Bearer ${await getValidAccessToken()}`;
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers, credentials: "omit" });
    } catch (cause) {
      throw new NetworkError(`Bungie API request failed: ${url}`, { cause });
    }
    if (res.status === 403) {
      throw new ApiKeyError("Bungie API key rejected (HTTP 403)");
    }
    const data = await res.json().catch(() => ({}));
    const retrySeconds = throttleSeconds(data);
    if (retrySeconds !== null) {
      if (attempt < retries) {
        // ponytail: cap the wait at 30s; Bungie's ThrottleSeconds can be
        // absurdly large and an uncapped sleep would freeze the UI.
        await sleep(Math.min(retrySeconds, 30) * 1000);
        continue;
      }
      throw new ThrottleError(retrySeconds);
    }
    if (data.ErrorCode !== undefined && data.ErrorCode !== 1) {
      throw new ApiError(data, res.status);
    }
    if (!res.ok) {
      throw new ApiError({ ErrorStatus: `HTTP ${res.status}` }, res.status);
    }
    return data.Response;
  }
}

export class NoMembershipError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoMembershipError";
  }
}

// --- T5: membership resolution ---

// Resolves the Destiny account to use for inventory calls. Bungie's
// cross-save semantics: crossSaveOverride holds the membershipId of the
// primary account, and every non-primary platform account points at it; a
// value of 0 means the account is not cross-save. Falls back to the first
// member. Not signed in -> FatalTokenError propagates from
// getValidAccessToken.
export async function resolveMemberships() {
  const response = await bungieFetch("/User/GetMembershipsForCurrentUser/", { auth: true });
  const members = response.destinyMemberships ?? [];
  if (members.length === 0) {
    throw new NoMembershipError("No Destiny membership found for this account");
  }
  const primary = members.find(
    member => member.crossSaveOverride > 0 &&
      // crossSaveOverride is a number while membershipId is an int64 string
      members.some(other => String(other.membershipId) === String(member.crossSaveOverride)),
  );
  const chosen = primary ?? members[0];
  return {
    membershipType: chosen.membershipType,
    membershipId: chosen.membershipId,
    displayName: chosen.displayName,
  };
}
