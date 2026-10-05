import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { recordBehaviourChanges } from "../src/behaviour/changes.js";
import { readModelBehaviour } from "../src/behaviour/read.js";
import { ModelBehaviourRollups } from "../src/behaviour/rollups.js";
import { Storage } from "../src/storage/index.js";
import { H, HOUR, agentFor, seedScenario } from "./behaviour-fixtures.js";

// ---------------------------------------------------------------------------
// The console's `GET /api/models/behaviour` sample is generated here by the real
// read API over synthetic rows, so the console's Effect schemas decode exactly what
// the agent serves. The test fails when the response shape drifts from the
// committed fixture; regenerate it with
//   UPDATE_MODEL_BEHAVIOUR_FIXTURE=1 node --import tsx --test test/model-behaviour-fixture.test.ts
// ---------------------------------------------------------------------------

const FIXTURE = new URL("../console/src/lib/server/api/demo/model-behaviour.json", import.meta.url);

async function generate(): Promise<unknown> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedScenario(storage);
    await new ModelBehaviourRollups({ storage, agentForTimelineKey: agentFor }).flush();
    await recordBehaviourChanges(storage, [{
      kind: "prompt_changed",
      sentence: "agent agent_a, default on model_a: system prompt changed (aaa → bbb)",
      agents: ["agent_a"], sites: ["default"], models: ["model_a"],
      detail: { prompt: "system", oldHash: "aaa", newHash: "bbb" },
    }], H + 60_000);
    await recordBehaviourChanges(storage, [{
      kind: "head_model_changed",
      sentence: "agent agent_a, default: head model model_a → model_b",
      path: "agents.agent_a.sites.default", old: "model_a", new: "model_b",
      agents: ["agent_a"], sites: ["default"], models: ["model_a", "model_b"],
    }], H + 90_000);
    const response = readModelBehaviour(
      {
        storage,
        agentForTimelineKey: agentFor,
        familyOf: (m) => m,
        checkKind: (code) => (code.startsWith("style_") ? "style" : undefined),
      },
      { window: "24h", groupBy: "model", family: false, now: H + 2 * HOUR, selected: "model_b" },
    );
    await storage.waitForIdle();
    return JSON.parse(JSON.stringify(response));
  } finally {
    storage.close();
  }
}

test("console model behaviour sample matches what the read API serves", { skip: !existsSync(FIXTURE) && process.env["UPDATE_MODEL_BEHAVIOUR_FIXTURE"] !== "1" }, async () => {
  const body = await generate();
  if (process.env["UPDATE_MODEL_BEHAVIOUR_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(body, null, "\t")}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), body);
});
