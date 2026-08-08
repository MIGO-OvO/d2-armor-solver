/* global __BUNGIE_OAUTH_CLIENT_ID__, __BUNGIE_OAUTH_CLIENT_SECRET__ */
// Bungie OAuth token client.
//
// The __BUNGIE_*__ identifiers are injected at build time by Vite define and
// are plain browser globals; tests inject fakes via globalThis.
//
// Module layout: token storage / helpers first, then the OAuth flows, then the
// FatalTokenError / NetworkError classes. T4 appends the throttled bungieFetch
// wrapper (which uses __BUNGIE_API_KEY__ — declare it in the /* global */
// comment above at that point), T5 appends membership resolution — both go at
// the bottom of this file.

export const TOKEN_STORAGE_KEY = "d2_armor_bungie_token_v1";

const TOKEN_ENDPOINT = "https://www.bungie.net/Platform/App/OAuth/token/";

// --- token storage (lazy localStorage: no top-level DOM access) ---

export function saveToken(token) {
  globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
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
  globalThis.localStorage?.removeItem(TOKEN_STORAGE_KEY);
}

export function hasToken() {
  return getToken() !== null;
}

// ponytail: expiry checks only the access window; a refresh whose refresh
// token is itself dead falls out via Bungie's invalid_grant -> FatalTokenError.
export function isTokenExpired(token) {
  return !token || token.obtainedAt + token.expiresIn * 1000 <= Date.now();
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

// --- T4 appends: throttled bungieFetch wrapper ---
// --- T5 appends: membership resolution ---
