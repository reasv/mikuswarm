/**
 * Startup checks of judged retrieval (ARCHITECTURE.md §9d, §9c, §8h):
 * `[retrieval.filters].model` names a decision model, and the memory
 * capacity warning counts the real per-build demand. Synthetic config only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateDecisionsConfig } from "../src/decisions/config.js";
import { judgedPerBuildMax, resolveRetrievalConfig } from "../src/retrieval/config.js";

const models: any = {
  decider: { id: "d", provider: "p", api: "system-one", endpoint: "http://x", api_key: "k", input_modalities: ["text"], max_tokens: 1 },
  chat: { id: "c", provider: "p", endpoint: "http://x", api_key: "k", input_modalities: ["text"], max_tokens: 100 },
};

function warnings(config: any): Array<[string, any]> {
  const out: Array<[string, any]> = [];
  validateDecisionsConfig(config, { warn: (e, f) => out.push([e, f]) });
  return out;
}

test("[retrieval.filters].model may name a decision model, globally and per agent", () => {
  assert.doesNotThrow(() =>
    validateDecisionsConfig({ models, decisions: { enabled: true, model: "decider" }, retrieval: { filters: { model: "decider" } } } as any),
  );
  assert.doesNotThrow(() =>
    validateDecisionsConfig({
      models,
      decisions: { enabled: true, model: "decider" },
      agents: { a: { workspace_root: "/w", retrieval: { filters: { model: "decider" } } } },
    } as any),
  );
});

test("[retrieval.filters].model naming a chat model or nothing is a clear startup error", () => {
  assert.throws(
    () => validateDecisionsConfig({ models, decisions: { enabled: true, model: "decider" }, retrieval: { filters: { model: "chat" } } } as any),
    /retrieval\.filters\.model = "chat" is a chat model; memory filters are judged by a decision model/,
  );
  assert.throws(
    () =>
      validateDecisionsConfig({
        models,
        decisions: { enabled: true, model: "decider" },
        agents: { a: { workspace_root: "/w", retrieval: { filters: { model: "nope" } } } },
      } as any),
    /agents\.a\.retrieval\.filters\.model = "nope" does not name a \[models\.\*\] block/,
  );
});

test("memory capacity warning: skipped when retrieval, auto-retrieval or the judge is off", () => {
  const base = { models, decisions: { enabled: true, model: "decider" }, rate_limits: { llm: { "decision:decider": { max_in_flight: 2 } } } };
  const memoryWarn = (cfg: any) => warnings(cfg).some(([e]) => e === "decisions_memory_capacity_low");
  assert.equal(memoryWarn({ ...base, retrieval: { enabled: true } }), true);
  assert.equal(memoryWarn({ ...base, retrieval: { enabled: false } }), false);
  assert.equal(memoryWarn({ ...base }), false, "an absent [retrieval] is off");
  assert.equal(memoryWarn({ ...base, retrieval: { enabled: true, auto_retrieval: false } }), false);
  assert.equal(memoryWarn({ ...base, retrieval: { enabled: true, auto: { judge: false } } }), false);
});

test("memory capacity warning counts the real per-build maximum plus routing and records on the same group", () => {
  const resolved = resolveRetrievalConfig({ enabled: true } as any);
  assert.equal(judgedPerBuildMax(resolved), 12, "12 ranked + 8 person-cued, capped by max_judged 12");
  assert.equal(judgedPerBuildMax(resolveRetrievalConfig({ enabled: true, auto: { max_judged: 30 } } as any)), 20);
  assert.equal(judgedPerBuildMax(resolveRetrievalConfig({ enabled: true, auto: { max_judged: 30, person_recent: 0 } } as any)), 12);

  const at = (maxInFlight: number, decisions: any) =>
    warnings({
      models,
      decisions: { enabled: true, model: "decider", ...decisions },
      retrieval: { enabled: true },
      rate_limits: { llm: { "decision:decider": { max_in_flight: maxInFlight } } },
    }).find(([e]) => e === "decisions_memory_capacity_low")?.[1];

  assert.equal(at(12, {}), undefined);
  const withRouting = at(12, { routing: { enabled: true } });
  assert.equal(withRouting?.needed, 13);
  const withRecords = at(13, { routing: { enabled: true }, records: { enabled: true, candidates: 3 } });
  assert.equal(withRecords?.needed, 17);
  assert.equal(at(17, { routing: { enabled: true }, records: { enabled: true, candidates: 3 } }), undefined);
});
