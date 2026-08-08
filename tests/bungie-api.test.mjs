import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthorizeUrl,
  clearToken,
  exchangeCodeForToken,
  FatalTokenError,
  getToken,
  getValidAccessToken,
  NetworkError,
  saveToken,
  TOKEN_STORAGE_KEY,
} from "../src/core/bungie-api.mjs";

// The real values are injected at build time by Vite define; tests inject fakes.
globalThis.__BUNGIE_OAUTH_CLIENT_ID__ = "test-client";
globalThis.__BUNGIE_OAUTH_CLIENT_SECRET__ = "test-secret";

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
