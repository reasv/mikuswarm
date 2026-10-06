import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AppConfigSchema, type AppConfig } from "../src/config/schema.js";
import { resolveExaConfig } from "../src/exa/config.js";
test("Exa resolves inert defaults and root-on requires nonblank key", () => {
  assert.equal(resolveExaConfig(undefined).enabled, false);
  assert.equal(resolveExaConfig({ enabled: false, api_key: "" }).research.enabled, false);
  assert.throws(() => resolveExaConfig({ enabled: true }), /api_key/);
  assert.throws(() => resolveExaConfig({ enabled: true, api_key: " " }), /api_key/);
  assert.equal(resolveExaConfig({ enabled: true, api_key: "secret" }).enabled, true);
});
test("coherent limits and fixed effort enforcement", () => {
  assert.throws(() => resolveExaConfig({ search: { max_results: 5 } }), /max_results/);
  assert.throws(() => resolveExaConfig({ search: { allowed_modes: ["fast"] } }), /auto/);
  assert.throws(() => resolveExaConfig({ fetch: { extraction_chars: 10 } }), /display_chars/);
  assert.throws(() => resolveExaConfig({ research: { default_effort: "high" } }), /max_effort/);
  assert.throws(() => resolveExaConfig({ research: { poll_interval_ms: 100, wait_timeout_ms: 50 } }), /wait_timeout/);
});
test("schema rejects unknown knobs, unsupported modes, fractional concurrency", () => {
  const exaSchema = AppConfigSchema.properties.exa;
  assert.equal(Value.Check(exaSchema, { enabled: true, api_key: "abc", search: { allowed_modes: ["auto", "deep"] } }), true);
  for (const config of [{ max_in_flight: 1.5 }, { search: { allowed_modes: ["deep-lite"] } }, { research: { max_effort: "auto" } }, { mystery: true }]) assert.equal(Value.Check(exaSchema, config), false);
});
