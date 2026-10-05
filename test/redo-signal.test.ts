import assert from "node:assert/strict";
import test from "node:test";
import { SessionRedoControl } from "../src/agent/redo-signal.js";

test("SessionRedoControl: first request wins until taken; take clears", () => {
  const control = new SessionRedoControl();
  assert.equal(control.peek(), undefined);
  assert.equal(control.take(), undefined);
  control.request({ kind: "refusal", toolCallId: "call_1", checkCode: "refusal_persona", probability: 0.92 });
  control.request({ kind: "contract" });
  assert.deepEqual(control.peek(), { kind: "refusal", toolCallId: "call_1", checkCode: "refusal_persona", probability: 0.92 });
  assert.equal(control.peek()?.kind, "refusal", "peek leaves it in place");
  assert.equal(control.take()?.toolCallId, "call_1");
  assert.equal(control.peek(), undefined);
  control.request({ kind: "contract" });
  assert.deepEqual(control.take(), { kind: "contract" });
});

test("SessionRedoControl: a request is copied, later caller mutation does not leak in", () => {
  const control = new SessionRedoControl();
  const req = { kind: "refusal" as const, ruleName: "a" };
  control.request(req);
  req.ruleName = "b";
  assert.equal(control.take()?.ruleName, "a");
});
