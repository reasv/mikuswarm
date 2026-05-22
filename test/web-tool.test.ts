import assert from "node:assert/strict";
import test from "node:test";
import { createWebFetchTool } from "../src/tools/web.js";

test("web_fetch blocks local addresses", async () => {
  const tool = createWebFetchTool();
  await assert.rejects(
    () =>
      tool.execute("tool-1", {
        url: "http://127.0.0.1/",
      }),
    /Local or private address is blocked/,
  );
  await assert.rejects(
    () =>
      tool.execute("tool-2", {
        url: "http://localhost/",
      }),
    /Local addresses are blocked/,
  );
  await assert.rejects(
    () =>
      tool.execute("tool-3", {
        url: "http://[::ffff:7f00:1]/",
      }),
    /Local or private address is blocked/,
  );
});
