import assert from "node:assert/strict";
import test from "node:test";
import {createSearchSession, withSearchProfile, SearchBudgetExceeded} from "../src/core/search-session.mjs";
import {certifiedFeasible, proofPresentation} from "../src/core/solver-presentation.mjs";
import {readFileSync} from "node:fs";
const witness = status => ({certificate: {status, witnessVerification: {valid: true}, proof: {complete: false}}});

test("profiles change effort but leave the original mathematical request immutable", () => {
  const payload = {target: {health: 100}, constraints: {exact: {health: true}}};
  const original = structuredClone(payload);
  const fast = withSearchProfile("solve", {...payload, searchProfile: "fast"});
  const balanced = withSearchProfile("solve", payload);
  const deep = withSearchProfile("solve", {...payload, searchProfile: "deep"});
  assert.deepEqual(payload, original);
  assert.equal(fast.runtimeOptions.fastMode, true);
  assert.equal(deep.runtimeOptions.proveFuzzy, true);
  assert.equal(deep.searchLimits.exhaustive, true);
  assert.ok(fast.searchLimits.maxTimeMs < balanced.searchLimits.maxTimeMs);
  assert.ok(balanced.searchLimits.maxNodes < deep.searchLimits.maxNodes);
});

test("one session publishes verified results before completion across monotone stages", () => {
  let clock = 0;
  const events = [];
  const session = createSearchSession({operation: "solveInventory", generation: 7, now: () => clock,
    onProgress: event => events.push(event)});
  clock = 120;
  session.publish(witness("EXACT_TARGET_PROVEN"));
  assert.equal(events.length, 1);
  assert.equal(events[0].search.running, true);
  assert.equal(events[0].search.firstExactMs, 120);
  for (clock of [150, 500, 1500]) session.checkpoint(100);
  session.publish({status: "EXACT_TARGET_PROVEN"});
  assert.equal(events.length, 4, "uncertified values never become progressive results");
  clock = 3001;
  assert.throws(() => session.checkpoint(), SearchBudgetExceeded);
  const final = session.finish(session.lastResult);
  assert.equal(final.search.running, false);
  assert.equal(final.search.termination, "budget");
  assert.equal(final.search.coverage.complete, false);
  assert.equal(final.certificate.status, "EXACT_TARGET_PROVEN");
});

test("proof presentation cannot promote forged metrics or a top-level status alias", () => {
  assert.equal(certifiedFeasible({status: "EXACT_TARGET_PROVEN", metrics: {allReached: true}}), false);
  assert.equal(proofPresentation(witness("RULE_FEASIBLE_PROVEN"), {running: true}).key, "feasibleSearching");
  assert.equal(proofPresentation(witness("SEARCH_LIMIT_REACHED"), {running: false}).key, "limited");
});

test("a terminal fallback cannot downgrade a found exact witness or rewind coverage", () => {
  const session = createSearchSession({operation: "solveInventory", generation: 1, now: () => 0});
  const exact = {...witness("EXACT_TARGET_PROVEN"), searchStats: {statesExamined: 5}};
  session.publish(exact);
  session.checkpoint(1024, {statesExamined: 1024, frontierComplete: false});
  const result = session.finish(witness("SEARCH_LIMIT_REACHED"));
  assert.equal(result.certificate.status, "EXACT_TARGET_PROVEN");
  assert.equal(result.search.coverage.statesExamined, 1024);
  const bounded = createSearchSession({operation: "solve", generation: 1, profile: "fast", now: () => 0});
  assert.throws(() => bounded.checkpoint(100001), SearchBudgetExceeded);
});

test("notification throttle never drops the exact incumbent", () => {
  let clock = 0;
  const session = createSearchSession({operation: "solveInventory", generation: 1, profile: "fast", now: () => clock});
  session.publish(witness("SEARCH_LIMIT_REACHED"));
  clock = 50;
  session.publish(witness("EXACT_TARGET_PROVEN"));
  clock = 201;
  assert.throws(() => session.checkpoint(), SearchBudgetExceeded);
  const final = session.finish(witness("SEARCH_LIMIT_REACHED"));
  assert.equal(final.certificate.status, "EXACT_TARGET_PROVEN");
  assert.equal(final.search.firstExactMs, 50);
});

test("UI cannot import alternative rule validators or promote metric flags", () => {
  const app = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(app, /satisfiesTargetConstraints|satisfiesUpgradeStatRule|preferConstraintSatisfyingSolutions|metrics\.allReached/);
});

test("Worker generations isolate superseded progress and all operations support cancellation", async () => {
  class FakeWorker {
    static instances = [];
    constructor() { this.events = {}; FakeWorker.instances.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated = true; }
    reply(data) { this.events.message({data: {...this.request, ...data}}); }
  }
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = await import(`../src/core/armor-engine-client.mjs?test=${Date.now()}`);
    for (const method of ["solveLoadoutAsync", "solveInventoryAsync", "analyzeUpgradeAsync", "calculateReachabilityAsync"]) {
      const progress = [];
      const first = client[method]({}, {onProgress: result => progress.push(result)});
      const rejected = assert.rejects(first, {name: "AbortError"});
      const old = FakeWorker.instances.at(-1);
      const second = client[method]({}, {onProgress: result => progress.push(result)});
      const fresh = FakeWorker.instances.at(-1);
      assert.equal(old.terminated, true);
      old.reply({type: "progress", result: "stale"});
      fresh.reply({type: "progress", result: "fresh"});
      fresh.reply({type: "result", result: "finished"});
      assert.equal(await second, "finished");
      await rejected;
      assert.deepEqual(progress, ["fresh"]);
    }
    client.cancelAllSearches();
  } finally { globalThis.Worker = original; }
});
