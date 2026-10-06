import assert from "node:assert/strict";
import test from "node:test";
import { ExaHealth } from "../src/exa/health.js";
import { ExaError } from "../src/exa/errors.js";
function fail(health: ExaHealth, scope: "search" | "contents", error: ExaError): void {
  const admission = health.enter(scope); admission.failure(error); admission.finish();
}
test("endpoint failures open after three; one half-open probe and successful recovery", () => {
  let now = 1000; const health = new ExaHealth(() => now);
  for (let i = 0; i < 3; i++) fail(health, "search", new ExaError("transport_failed", "failure", "search"));
  assert.equal(health.available("search"), false); assert.equal(health.available("contents"), true);
  assert.throws(() => health.enter("search"), /unavailable/); now += 30000;
  const admission = health.enter("search"); assert.throws(() => health.enter("search"), /unavailable/);
  admission.success(); admission.finish(); assert.equal(health.available("search"), true);
});
test("account failure blocks all; concurrent endpoint success does not clear auth failure", () => {
  let now = 1000; const health = new ExaHealth(() => now);
  const stale = health.enter("contents"); fail(health, "search", new ExaError("auth_failed", "auth", "search")); stale.success(); stale.finish();
  assert.equal(health.available("contents"), false); now += 300000;
  const admission = health.enter("contents"); assert.throws(() => health.enter("search")); admission.success(); admission.finish();
  assert.equal(health.available("search"), true);
});
test("429 applies shared cooldown; input errors and caller aborts are neutral", () => {
  let now = 1000; const health = new ExaHealth(() => now);
  for (let i = 0; i < 10; i++) fail(health, "search", new ExaError("aborted", "abort", "search"));
  assert.equal(health.available("search"), true);
  fail(health, "search", new ExaError("rate_limited", "throttle", "search", 429, now + 5000));
  assert.equal(health.available("contents"), false); now += 5000; assert.equal(health.available("contents"), true);
});
for (const scope of ["search", "contents"] as const) {
  test(`stale ${scope} settlements cannot close a newer endpoint probe or reopen its recovery`, () => {
    let now = 1000; const health = new ExaHealth(() => now);
    const staleSuccess = health.enter(scope), staleFailure = health.enter(scope);
    for (let i = 0; i < 3; i++) fail(health, scope, new ExaError("transport_failed", "failure", scope));
    now += 30000;
    const probe = health.enter(scope);
    staleSuccess.success(); staleSuccess.finish();
    assert.equal(health.available(scope), false);
    assert.equal(health.snapshot().endpoints[scope].probing, true);
    probe.success(); probe.finish();
    const recovered = health.snapshot().endpoints[scope];
    staleFailure.failure(new ExaError("upstream_failed", "late failure", scope)); staleFailure.finish();
    assert.deepEqual(health.snapshot().endpoints[scope], recovered);
  });
}
test("stale account settlement cannot close a newer account probe or reopen recovered account", () => {
  let now = 1000; const health = new ExaHealth(() => now);
  const staleSuccess = health.enter("contents"), staleFailure = health.enter("contents");
  fail(health, "search", new ExaError("auth_failed", "auth", "search")); now += 300000;
  const probe = health.enter("search"); staleSuccess.success(); staleSuccess.finish();
  assert.equal(health.available("contents"), false);
  probe.success(); probe.finish(); const recovered = health.snapshot().account;
  staleFailure.failure(new ExaError("auth_failed", "late auth", "contents")); staleFailure.finish();
  assert.deepEqual(health.snapshot().account, recovered);
});
test("finishing an older neutral probe cannot release the replacement probe", () => {
  let now = 1000; const health = new ExaHealth(() => now);
  for (let i = 0; i < 3; i++) fail(health, "search", new ExaError("timeout", "failure", "search"));
  now += 30000; const old = health.enter("search"); old.finish();
  const next = health.enter("search"); old.finish(); old.success();
  assert.equal(health.available("search"), false); next.success(); next.finish();
});
test("ordinary successes reset the consecutive failure streak", () => {
  const health = new ExaHealth();
  for (let i = 0; i < 2; i++) fail(health, "search", new ExaError("timeout", "failure", "search"));
  const success = health.enter("search"); success.success(); success.finish();
  for (let i = 0; i < 2; i++) fail(health, "search", new ExaError("timeout", "failure", "search"));
  assert.equal(health.available("search"), true);
});
for (const code of ["transport_failed", "upstream_failed", "timeout", "rate_limited"] as const) {
  test(`failed owning account probe (${code}) renews account cooldown across endpoints`, () => {
    let now = 1000; const health = new ExaHealth(() => now);
    fail(health, "search", new ExaError("auth_failed", "auth", "search"));
    now += 300000;
    const probe = health.enter("contents");
    probe.failure(new ExaError(code, "probe failed", "contents")); probe.finish();
    assert.equal(health.snapshot().account.retryAt, now + 300000);
    if (code !== "rate_limited") assert.equal(health.snapshot().endpoints.contents.lastObserved, now);
    for (const scope of ["search", "contents", "research-create", "research-collection"] as const) {
      assert.equal(health.available(scope), false); assert.throws(() => health.enter(scope), /unavailable/);
    }
    now += 299999; assert.equal(health.available("search"), false);
    now++; const recovered = health.enter("search"); recovered.success(); recovered.finish();
    assert.equal(health.available("contents"), true);
  });
}
for (const code of ["aborted", "invalid_request", "invalid_response"] as const) {
  test(`neutral owning account probe (${code}) releases its claim without extending cooldown`, () => {
    let now = 1000; const health = new ExaHealth(() => now);
    fail(health, "search", new ExaError("auth_failed", "auth", "search"));
    now += 300000; const probe = health.enter("contents");
    probe.failure(new ExaError(code, "neutral probe", "contents")); probe.finish();
    assert.equal(health.snapshot().account.retryAt, now);
    const retry = health.enter("search"); retry.success(); retry.finish();
    assert.equal(health.available("contents"), true);
  });
}
