import assert from "node:assert/strict";
import test from "node:test";
import {createSearchSession, withSearchProfile, SearchBudgetExceeded} from "../src/core/search-session.mjs";
import {certifiedFeasible, proofPresentation} from "../src/core/solver-presentation.mjs";
import {readFileSync} from "node:fs";
import {BASE_CONFIGS, STATS} from "../src/core/armor-model.mjs";
import {
  RESULT_STATUS,
  attachResultCertificate,
  createProblemSpec,
  createProofEvidence,
  createResultCertificate,
  verifyWitness,
} from "../src/core/solver-v3-contract.mjs";
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
  assert.ok(fast.searchLimits.maxEvaluations < balanced.searchLimits.maxEvaluations);
  assert.ok(balanced.searchLimits.maxEvaluations < deep.searchLimits.maxEvaluations);
  assert.equal(balanced.searchLimits.maxEvaluations, 50000);
  assert.equal(deep.searchLimits.maxEvaluations, 5000000);
  assert.equal(deep.searchLimits.maxStates, 2000000);
});

const zeroStats = () => Object.fromEntries(STATS.map(stat => [stat, 0]));
const exactRules = () => ({exact: Object.fromEntries(STATS.map(stat => [stat, true]))});
const witnessConfig = () => ({
  config: Array.from({length: 5}, () => ({...BASE_CONFIGS[0], baseStats: {...BASE_CONFIGS[0].baseStats}})),
  tuningAssignments: Array.from({length: 5}, () => ({mode: "+5-5", from: "health", to: "melee"})),
  modAssignments: Object.fromEntries(Array.from({length: 5}, (_, index) => [index, null])),
});
const computedWitnessTotals = verifyWitness(
  createProblemSpec({operation: "solve", target: zeroStats()}),
  witnessConfig(),
).armorTotals;
const certifyContainer = (result, spec, status, proof) =>
  attachResultCertificate(result, createResultCertificate({
    status,
    problemSpec: spec,
    witness: result.length === 1 ? result[0] : null,
    proof,
  }));
const truncatedProof = spec => createProofEvidence(spec, {method: "effort-budget", truncated: true});
const infeasiblePointProof = spec => createProofEvidence(spec, {
  producer: "exact-target-oracle", method: "exact-target-oracle",
  complete: true, scope: "target-point", outcome: "infeasible", statesExamined: 1,
  assumptions: ["known-data"],
});
const incompleteInfeasiblePointProof = spec => createProofEvidence(spec, {
  producer: "exact-target-oracle", method: "exact-target-oracle",
  complete: false, truncated: true, scope: "target-point", outcome: "infeasible", statesExamined: 1,
  assumptions: ["known-data"],
});
const pointSpec = target => createProblemSpec({operation: "solve", target, constraints: exactRules()});

test("terminal complete infeasibility outranks an older search-limit incumbent (Case A)", () => {
  const spec = pointSpec({health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100});
  const early = certifyContainer([witnessConfig()], spec, RESULT_STATUS.SEARCH_LIMIT_REACHED, truncatedProof(spec));
  assert.equal(early.certificate.witnessVerification.valid, true, "fixture: early result is a verified candidate");
  const terminal = certifyContainer([witnessConfig()], spec, RESULT_STATUS.INFEASIBLE_PROVEN, infeasiblePointProof(spec));
  assert.equal(terminal.certificate.status, RESULT_STATUS.INFEASIBLE_PROVEN,
    "fixture: terminal certificate survived the contract boundary");
  const session = createSearchSession({operation: "solve", generation: 1, now: () => 0});
  session.publish(early);
  const final = session.finish(terminal);
  assert.equal(final.certificate.status, RESULT_STATUS.INFEASIBLE_PROVEN);
  assert.equal(final.search.coverage.complete, true);
});

test("a terminal negative never demotes a proven exact witness (Case B)", () => {
  const exactSpec = pointSpec(computedWitnessTotals);
  const exact = certifyContainer([witnessConfig()], exactSpec, RESULT_STATUS.EXACT_TARGET_PROVEN, truncatedProof(exactSpec));
  assert.equal(exact.certificate.status, RESULT_STATUS.EXACT_TARGET_PROVEN);
  // A same-ruleset complete negative cannot coexist with a rule-satisfying
  // witness at the certificate boundary, so this terminal certificate is
  // issued against an unrelated point spec: the session itself must still
  // prefer the proven positive witness over any terminal negative.
  const otherSpec = pointSpec({health: 80, melee: 80, grenade: 80, super: 80, class: 80, weapons: 80});
  const terminal = certifyContainer([], otherSpec, RESULT_STATUS.INFEASIBLE_PROVEN, infeasiblePointProof(otherSpec));
  assert.equal(terminal.certificate.status, RESULT_STATUS.INFEASIBLE_PROVEN);
  const session = createSearchSession({operation: "solve", generation: 1, now: () => 0});
  session.publish(exact);
  const final = session.finish(terminal);
  assert.equal(final, exact, "the exact incumbent object is retained");
  assert.equal(final.certificate.status, RESULT_STATUS.EXACT_TARGET_PROVEN);
  assert.ok(final[0].config.length === 5);
});

test("a search-limit terminal never demotes a rule-feasible witness (Case C)", () => {
  const ruleSpec = createProblemSpec({operation: "solve", target: zeroStats(),
    constraints: {minimums: {health: 1}}});
  const ruleWitness = witnessConfig();
  const early = certifyContainer([ruleWitness], ruleSpec, RESULT_STATUS.RULE_FEASIBLE_PROVEN, truncatedProof(ruleSpec));
  assert.equal(early.certificate.status, RESULT_STATUS.RULE_FEASIBLE_PROVEN);
  const terminal = certifyContainer([], ruleSpec, RESULT_STATUS.SEARCH_LIMIT_REACHED, truncatedProof(ruleSpec));
  const session = createSearchSession({operation: "solve", generation: 1, now: () => 0});
  session.publish(early);
  const final = session.finish(terminal);
  assert.equal(final.certificate.status, RESULT_STATUS.RULE_FEASIBLE_PROVEN);
});

test("an incomplete infeasible claim is demoted at the contract and never promoted by finish (Case D)", () => {
  const spec = pointSpec({health: 100, melee: 100, grenade: 100, super: 100, class: 100, weapons: 100});
  const terminal = certifyContainer([witnessConfig()], spec, RESULT_STATUS.INFEASIBLE_PROVEN, incompleteInfeasiblePointProof(spec));
  assert.equal(terminal.certificate.status, RESULT_STATUS.SEARCH_LIMIT_REACHED,
    "the certificate contract demotes the incomplete infeasible claim");
  const session = createSearchSession({operation: "solve", generation: 1, now: () => 0});
  const final = session.finish(terminal);
  assert.equal(final.certificate.status, RESULT_STATUS.SEARCH_LIMIT_REACHED);
  assert.equal(final.search.coverage.complete, false);
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

test("Worker generations isolate superseded progress and all operations support cancellation", {timeout: 5000}, async () => {
  class FakeWorker {
    static instances = [];
    constructor() { this.events = {}; FakeWorker.instances.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    postMessage(message) { (this.requests ||= []).push(message); }
    terminate() { this.terminated = true; }
    reply(index, data) { this.events.message({data: {...this.requests[index], ...data}}); }
  }
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = await import(`../src/core/armor-engine-client.mjs?test=${Date.now()}`);
    for (const method of ["solveLoadoutAsync", "solveInventoryAsync", "analyzeUpgradeAsync", "calculateReachabilityAsync"]) {
      const progress = [];
      const first = client[method]({}, {onProgress: result => progress.push(result)});
      const rejected = assert.rejects(first, {name: 'AbortError'});
      const old = FakeWorker.instances.at(-1);
      const second = client[method]({}, {onProgress: result => progress.push(result)});
      const fresh = FakeWorker.instances.at(-1);
      assert.equal(old.terminated, true);
      old.reply(0, {type: "progress", result: "stale"});
      fresh.reply(0, {type: "progress", result: "fresh"});
      fresh.reply(0, {type: "result", result: "finished"});
      assert.equal(await second, 'finished');
      await rejected;
      assert.deepEqual(progress, ["fresh"]);
    }
    client.cancelAllSearches();
  } finally { globalThis.Worker = original; }
});

test("AbortSignal terminates ordinary workers and the next request gets a fresh worker", {timeout: 5000}, async () => {
  class ConcurrentWorker {
    static instances = [];
    constructor() { this.events = {}; ConcurrentWorker.instances.push(this); }
    addEventListener(name, cb) { this.events[name] = cb; }
    postMessage(message) { (this.requests ||= []).push(message); }
    terminate() { this.terminated = true; }
    reply(result) { for (const request of this.requests || []) this.events.message({data: {...request, type: "result", result}}); this.requests = []; }
  }
  const original = globalThis.Worker;
  globalThis.Worker = ConcurrentWorker;
  try {
    const client = await import(`../src/core/armor-engine-client.mjs?concurrent=${Date.now()}`);
    for (const method of ['solveLoadoutAsync', 'solveInventoryAsync', 'analyzeUpgradeAsync', 'calculateReachabilityAsync']) {
      const controller = new AbortController();
      const first = client[method]({}, {signal: controller.signal});
      const rejected = assert.rejects(first, {name: 'AbortError'});
      const old = ConcurrentWorker.instances.at(-1);
      controller.abort();
      await rejected;
      assert.equal(old.terminated, true);
      const second = client[method]({});
      const fresh = ConcurrentWorker.instances.at(-1);
      assert.notEqual(fresh, old);
      fresh.reply({ok: true});
      assert.deepEqual(await second, {ok: true});
    }
    client.cancelAllSearches();
  } finally { globalThis.Worker = original; }
});
