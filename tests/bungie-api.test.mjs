import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  ApiKeyError,
  buildAuthorizeUrl,
  bungieFetch,
  clearToken,
  exchangeCodeForToken,
  FatalTokenError,
  getToken,
  getValidAccessToken,
  isTokenExpired,
  NetworkError,
  NoMembershipError,
  resolveMemberships,
  saveToken,
  ThrottleError,
  TOKEN_STORAGE_KEY,
} from "../src/core/bungie-api.mjs";

// The real values are injected at build time by Vite define; tests inject fakes.
globalThis.__BUNGIE_OAUTH_CLIENT_ID__ = "test-client";
globalThis.__BUNGIE_OAUTH_CLIENT_SECRET__ = "test-secret";
globalThis.__BUNGIE_API_KEY__ = "test-api-key";

const ORIG_FETCH = globalThis.fetch;
const ORIG_LOCAL_STORAGE = globalThis.localStorage;

// Fake in-memory localStorage; the real one lives in the browser.
function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

// Minimal Response-like object with the fields the module touches.
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function refreshResponse() {
  return {
    ErrorCode: 1,
    ErrorStatus: "Ok",
    access_token: "fresh-access",
    refresh_token: "fresh-refresh",
    membership_id: "123",
    expires_in: 3600,
    refresh_expires_in: 7776000,
  };
}

// A token whose access window has already elapsed.
function expiredToken() {
  return {
    accessToken: "stale-access",
    refreshToken: "r-old",
    bungieMembershipId: "123",
    expiresIn: 10,
    refreshExpiresIn: 7776000,
    obtainedAt: Date.now() - 100_000,
  };
}

function restoreGlobals() {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_LOCAL_STORAGE === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = ORIG_LOCAL_STORAGE;
}

test("buildAuthorizeUrl includes response_type, client_id and state; no scope or redirect_uri", () => {
  const url = buildAuthorizeUrl("xyz");
  assert.match(url, /^https:\/\/www\.bungie\.net\/en\/oauth\/authorize\?/);
  assert.match(url, /response_type=code/);
  assert.match(url, /client_id=test-client/);
  assert.match(url, /state=xyz/);
  assert.ok(!url.includes("scope"), "must not send a scope parameter");
  assert.ok(!url.includes("redirect_uri"), "must not send a redirect_uri parameter");
});

test("exchangeCodeForToken posts form-urlencoded credentials and normalizes the response", async () => {
  installLocalStorage();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({
      access_token: "a",
      refresh_token: "r",
      membership_id: "123",
      expires_in: 3600,
      refresh_expires_in: 7776000,
    });
  };
  try {
    const token = await exchangeCodeForToken("the-code");
    assert.equal(requests.length, 1);
    const { url, options } = requests[0];
    assert.equal(url, "https://www.bungie.net/Platform/App/OAuth/token/");
    assert.equal(options.method, "POST");
    assert.ok(options.body instanceof URLSearchParams);
    assert.equal(options.body.get("grant_type"), "authorization_code");
    assert.equal(options.body.get("code"), "the-code");
    assert.equal(options.body.get("client_id"), "test-client");
    assert.equal(options.body.get("client_secret"), "test-secret");

    assert.equal(token.accessToken, "a");
    assert.equal(token.refreshToken, "r");
    assert.equal(token.bungieMembershipId, "123");
    assert.equal(token.expiresIn, 3600);
    assert.equal(token.refreshExpiresIn, 7776000);
    assert.equal(typeof token.obtainedAt, "number");
  } finally {
    restoreGlobals();
  }
});

test("getValidAccessToken returns a live token without fetching", async () => {
  installLocalStorage();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("unexpected fetch");
  };
  try {
    saveToken({
      accessToken: "live-access",
      refreshToken: "r",
      bungieMembershipId: "123",
      expiresIn: 3600,
      refreshExpiresIn: 7776000,
      obtainedAt: Date.now(),
    });
    const accessToken = await getValidAccessToken();
    assert.equal(accessToken, "live-access");
    assert.equal(fetchCount, 0);
  } finally {
    restoreGlobals();
  }
});

test("getValidAccessToken refreshes an expired token with grant_type=refresh_token", async () => {
  installLocalStorage();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(refreshResponse());
  };
  try {
    saveToken(expiredToken());
    const accessToken = await getValidAccessToken();
    assert.equal(accessToken, "fresh-access");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.body.get("grant_type"), "refresh_token");
    assert.equal(requests[0].options.body.get("refresh_token"), "r-old");
    assert.equal(getToken().accessToken, "fresh-access");
  } finally {
    restoreGlobals();
  }
});

test("concurrent getValidAccessToken calls share one refresh request", async () => {
  installLocalStorage();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return jsonResponse(refreshResponse());
  };
  try {
    saveToken(expiredToken());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getValidAccessToken()),
    );
    assert.deepEqual(results, Array(5).fill("fresh-access"));
    assert.equal(fetchCount, 1);
  } finally {
    restoreGlobals();
  }
});

test("refresh failure with invalid grants clears the token and throws FatalTokenError", async () => {
  installLocalStorage();
  globalThis.fetch = async () =>
    jsonResponse({ ErrorCode: 99, ErrorStatus: "InvalidGrants" }, { ok: false, status: 401 });
  try {
    saveToken(expiredToken());
    await assert.rejects(getValidAccessToken(), (error) => {
      assert.ok(error instanceof FatalTokenError);
      assert.equal(error.name, "FatalTokenError");
      return true;
    });
    assert.equal(getToken(), null);
  } finally {
    restoreGlobals();
  }
});

test("a network failure throws NetworkError and keeps the stored token", async () => {
  installLocalStorage();
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  try {
    saveToken(expiredToken());
    await assert.rejects(getValidAccessToken(), (error) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.name, "NetworkError");
      return true;
    });
    assert.ok(getToken(), "token must survive a network failure");
  } finally {
    restoreGlobals();
  }
});

test("refresh success with an explicit ErrorCode 1 / ErrorStatus Ok body works", async () => {
  installLocalStorage();
  globalThis.fetch = async () => jsonResponse(refreshResponse());
  try {
    saveToken(expiredToken());
    assert.equal(await getValidAccessToken(), "fresh-access");
  } finally {
    restoreGlobals();
  }
});

test("refresh keeps the previous refresh token when the response omits a new one", async () => {
  installLocalStorage();
  globalThis.fetch = async () => {
    const body = { ...refreshResponse() };
    delete body.refresh_token;
    return jsonResponse(body);
  };
  try {
    saveToken(expiredToken());
    assert.equal(await getValidAccessToken(), "fresh-access");
    assert.equal(getToken().refreshToken, "r-old");
  } finally {
    restoreGlobals();
  }
});

test("saveToken/getToken round-trip through localStorage", () => {
  installLocalStorage();
  try {
    const token = {
      accessToken: "a",
      refreshToken: "r",
      bungieMembershipId: "123",
      expiresIn: 3600,
      refreshExpiresIn: 7776000,
      obtainedAt: 123456,
    };
    saveToken(token);
    assert.equal(globalThis.localStorage.getItem(TOKEN_STORAGE_KEY), JSON.stringify(token));
    assert.deepEqual(getToken(), token);
    clearToken();
    assert.equal(getToken(), null);
  } finally {
    restoreGlobals();
  }
});

test("corrupted stored JSON yields null instead of throwing", () => {
  installLocalStorage();
  try {
    globalThis.localStorage.setItem(TOKEN_STORAGE_KEY, "{not json");
    assert.equal(getToken(), null);
  } finally {
    restoreGlobals();
  }
});

test("getToken returns null when localStorage is unavailable", () => {
  delete globalThis.localStorage;
  try {
    assert.equal(getToken(), null);
  } finally {
    restoreGlobals();
  }
});

test("isTokenExpired treats a missing or non-numeric expiresIn as expired", () => {
  // No expiresIn: undefined + number is NaN and NaN <= x is false, which
  // would otherwise keep the malformed token alive forever (F2 fix).
  assert.equal(isTokenExpired({ accessToken: "x" }), true);
  assert.equal(isTokenExpired({ accessToken: "x", expiresIn: "3600", obtainedAt: Date.now() }), true);
  assert.equal(isTokenExpired(null), true);
  const live = { accessToken: "x", expiresIn: 3600, obtainedAt: Date.now() };
  assert.equal(isTokenExpired(live), false);
  const stale = { accessToken: "x", expiresIn: 3600, obtainedAt: Date.now() - 3600_100 };
  assert.equal(isTokenExpired(stale), true);
});

// --- T4: throttled bungieFetch ---

function liveToken() {
  return {
    accessToken: "live-access",
    refreshToken: "r",
    bungieMembershipId: "123",
    expiresIn: 3600,
    refreshExpiresIn: 7776000,
    obtainedAt: Date.now(),
  };
}

function businessResponse() {
  return { Response: { profiles: [{ membershipId: "123" }] }, ErrorCode: 1, ErrorStatus: "Ok" };
}

test("bungieFetch sends X-API-Key and Bearer auth and unwraps Response", async () => {
  installLocalStorage();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(businessResponse());
  };
  try {
    saveToken(liveToken());
    const result = await bungieFetch("/Destiny2/Profile/123");
    assert.deepEqual(result, { profiles: [{ membershipId: "123" }] });
    assert.equal(requests.length, 1);
    const { url, options } = requests[0];
    assert.equal(url, "https://www.bungie.net/Platform/Destiny2/Profile/123");
    assert.equal(options.headers["X-API-Key"], "test-api-key");
    assert.equal(options.headers.Authorization, "Bearer live-access");
    assert.equal(options.credentials, "omit");
  } finally {
    restoreGlobals();
  }
});

test("bungieFetch retries once after a ThrottleSeconds response", async () => {
  installLocalStorage();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? jsonResponse({ ErrorCode: 36, ErrorStatus: "ThrottleLimitExceeded", ThrottleSeconds: 0 })
      : jsonResponse(businessResponse());
  };
  try {
    saveToken(liveToken());
    const result = await bungieFetch("/Destiny2/Profile/123");
    assert.deepEqual(result, { profiles: [{ membershipId: "123" }] });
    assert.equal(requests.length, 2);
  } finally {
    restoreGlobals();
  }
});

test("throttle sleep is capped at 30s even for extreme ThrottleSeconds", async () => {
  installLocalStorage();
  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  // Fake timer: record the delay and fire immediately so the test never
  // actually waits (a 9999s wait is not an option).
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); fn(); return 0; };
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return requestCount === 1
      ? jsonResponse({ ErrorCode: 36, ErrorStatus: "ThrottleLimitExceeded", ThrottleSeconds: 9999 })
      : jsonResponse(businessResponse());
  };
  try {
    saveToken(liveToken());
    await bungieFetch("/Destiny2/Profile/123");
    assert.deepEqual(delays, [30_000], "9999s ThrottleSeconds must wait at most 30s");
    assert.equal(requestCount, 2);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    restoreGlobals();
  }
});

test("bungieFetch throws ThrottleError when throttling exceeds the retry budget", async () => {
  installLocalStorage();
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ ErrorCode: 51, ErrorStatus: "PerEndpointRequestThrottleExceeded", ThrottleSeconds: 0 });
  };
  try {
    saveToken(liveToken());
    await assert.rejects(bungieFetch("/Destiny2/Profile/123", { retries: 2 }), (error) => {
      assert.ok(error instanceof ThrottleError);
      assert.equal(error.name, "ThrottleError");
      assert.equal(typeof error.retrySeconds, "number");
      return true;
    });
    assert.equal(requestCount, 3);
  } finally {
    restoreGlobals();
  }
});

test("bungieFetch throws ApiError for non-throttle error codes without retrying", async () => {
  installLocalStorage();
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ ErrorCode: 5, ErrorStatus: "ParamInvalid" });
  };
  try {
    saveToken(liveToken());
    await assert.rejects(bungieFetch("/Destiny2/Profile/123"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.name, "ApiError");
      assert.equal(error.errorCode, 5);
      return true;
    });
    assert.equal(requestCount, 1);
  } finally {
    restoreGlobals();
  }
});

test("bungieFetch throws ApiKeyError on HTTP 403", async () => {
  installLocalStorage();
  globalThis.fetch = async () =>
    jsonResponse({ ErrorCode: 5, ErrorStatus: "InvalidApiKey" }, { ok: false, status: 403 });
  try {
    saveToken(liveToken());
    await assert.rejects(bungieFetch("/Destiny2/Profile/123"), (error) => {
      assert.ok(error instanceof ApiKeyError);
      assert.equal(error.name, "ApiKeyError");
      return true;
    });
  } finally {
    restoreGlobals();
  }
});

test("bungieFetch wraps network failures in NetworkError", async () => {
  installLocalStorage();
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  try {
    saveToken(liveToken());
    await assert.rejects(bungieFetch("/Destiny2/Profile/123"), (error) => {
      assert.ok(error instanceof NetworkError);
      return true;
    });
  } finally {
    restoreGlobals();
  }
});

test("bungieFetch returns the raw Response wrapper only for ErrorCode 1", async () => {
  installLocalStorage();
  globalThis.fetch = async () =>
    jsonResponse({ Response: "payload", ErrorCode: 1, ErrorStatus: "Ok" });
  try {
    saveToken(liveToken());
    assert.equal(await bungieFetch("/User/GetBungieNetUserById/1"), "payload");
  } finally {
    restoreGlobals();
  }
});

test("bungieFetch with auth refreshes an expired token before the API call", async () => {
  installLocalStorage();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/App/OAuth/token/")) return jsonResponse(refreshResponse());
    return jsonResponse(businessResponse());
  };
  try {
    saveToken(expiredToken());
    const result = await bungieFetch("/Destiny2/Profile/123");
    assert.deepEqual(result, { profiles: [{ membershipId: "123" }] });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.body.get("grant_type"), "refresh_token");
    assert.equal(requests[1].options.headers.Authorization, "Bearer fresh-access");
  } finally {
    restoreGlobals();
  }
});

// --- T5: membership resolution ---

function membershipsResponse(members) {
  return { Response: { destinyMemberships: members }, ErrorCode: 1, ErrorStatus: "Ok" };
}

function member(type, id, { override = 0, name = `Guardian-${id}` } = {}) {
  return { membershipType: type, membershipId: id, crossSaveOverride: override, displayName: name };
}

test("resolveMemberships prefers the cross-save primary account", async () => {
  installLocalStorage();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(membershipsResponse([
      member(2, "111"),
      member(3, "222", { override: 111 }),
    ]));
  };
  try {
    saveToken(liveToken());
    const resolved = await resolveMemberships();
    assert.deepEqual(resolved, { membershipType: 3, membershipId: "222", displayName: "Guardian-222" });
    // Memberships live under the User controller, not Destiny2 (verified
    // against the real API 2026-08-09; /Destiny2/ returns HTTP 404).
    assert.equal(requests[0].url, "https://www.bungie.net/Platform/User/GetMembershipsForCurrentUser/");
    assert.equal(requests[0].options.headers.Authorization, "Bearer live-access");
  } finally {
    restoreGlobals();
  }
});

test("resolveMemberships returns the first member when nothing is cross-save", async () => {
  installLocalStorage();
  globalThis.fetch = async () =>
    jsonResponse(membershipsResponse([
      member(2, "111"),
      member(3, "222"),
    ]));
  try {
    saveToken(liveToken());
    assert.deepEqual(await resolveMemberships(),
      { membershipType: 2, membershipId: "111", displayName: "Guardian-111" });
  } finally {
    restoreGlobals();
  }
});

test("resolveMemberships throws NoMembershipError for an empty account", async () => {
  installLocalStorage();
  globalThis.fetch = async () => jsonResponse(membershipsResponse([]));
  try {
    saveToken(liveToken());
    await assert.rejects(resolveMemberships(), (error) => {
      assert.ok(error instanceof NoMembershipError);
      assert.equal(error.name, "NoMembershipError");
      return true;
    });
  } finally {
    restoreGlobals();
  }
});

test("resolveMemberships propagates FatalTokenError when signed out", async () => {
  installLocalStorage();
  try {
    await assert.rejects(resolveMemberships(), (error) => {
      assert.ok(error instanceof FatalTokenError);
      return true;
    });
  } finally {
    restoreGlobals();
  }
});
