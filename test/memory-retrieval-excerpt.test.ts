/** Excerpts and compact citations (ARCHITECTURE.md §9d "Excerpts"). */
import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanBlockText,
  formatCitation,
  headingOnlyRestatesTime,
  makeExcerpt,
  queryTerms,
} from "../src/retrieval/excerpt.js";
import { configureAgentTimezone, resetAgentTimezone, parseZonedWallClock } from "../src/time/index.js";

const HEADER = "## 2026-05-22 19:00 → 2026-05-22 19:40 · UTC · general";

test("headings: markers stripped, time-only headings dropped, the diary header line removed", () => {
  assert.equal(headingOnlyRestatesTime("Evening Events (~7:33 PM)"), true);
  assert.equal(headingOnlyRestatesTime("2026-05-22"), true);
  assert.equal(headingOnlyRestatesTime("Tuesday night"), true);
  assert.equal(headingOnlyRestatesTime("The pancake debate"), false);
  const clean = cleanBlockText(`${HEADER}\n### Evening Events (~7:33 PM)\n- we argued\n\n\n### The pancake debate\n- buttermilk won\n`);
  assert.equal(clean.heading, "The pancake debate");
  assert.deepEqual(clean.lines, ["- we argued", "", "The pancake debate", "- buttermilk won"]);
});

test("a block within the budget is shown whole (cleaned)", async () => {
  const text = `${HEADER}\nWe decided the launch is in October.\nAlice agreed.\n`;
  const ex = await makeExcerpt(text, { queries: ["launch"], budget: { tokens: 400 } });
  assert.equal(ex, "We decided the launch is in October.\nAlice agreed.");
});

test("a longer block shows its heading and a match-centred window, cut with …", async () => {
  const filler = Array.from({ length: 40 }, (_, i) => `Line ${i} about nothing in particular here.`);
  filler[25] = "The secret recipe uses buttermilk and nutmeg.";
  const text = `${HEADER}\n## Kitchen notes\n${filler.join("\n")}\n`;
  const ex = await makeExcerpt(text, { queries: ["what is the recipe with nutmeg"], budget: { tokens: 60 } });
  assert.ok(ex.startsWith("Kitchen notes\n"), "own heading leads");
  assert.ok(ex.includes("buttermilk and nutmeg"), "window centred on the match");
  assert.ok(ex.includes("… ") && ex.endsWith(" …"), "cut marks on both sides");
  assert.ok(!ex.includes("Line 0 "), "far lines dropped");
});

test("without a lexical match, a semantic unit scorer picks the window", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `Entry number ${i} with plain words.`);
  const text = `${HEADER}\n${lines.join("\n")}\n`;
  const ex = await makeExcerpt(text, {
    queries: ["zzz"],
    budget: { tokens: 30 },
    scoreUnits: async (units) => units.map((u) => (u.includes("number 20 ") ? 1 : 0)),
  });
  assert.ok(ex.includes("number 20 "));
});

test("character budget (recall_memory) caps the excerpt", async () => {
  const text = `${HEADER}\n${"word ".repeat(500)}match here ${"word ".repeat(500)}\n`;
  const ex = await makeExcerpt(text, { queries: ["match"], budget: { chars: 600 } });
  assert.ok(ex.length <= 610, `excerpt length ${ex.length}`);
  assert.ok(ex.includes("match"));
});

test("citation: path and lines, room when known, date only when the file name lacks it", () => {
  configureAgentTimezone("UTC");
  try {
    const ts = parseZonedWallClock("2026-05-14 10:00", "UTC")!;
    assert.equal(formatCitation({ path: "memory/2026-05-22.md", startLine: 90, endLine: 109, room: "general", entryTs: ts }), "memory/2026-05-22.md:90-109 · general");
    assert.equal(formatCitation({ path: "memory/notes.md", startLine: 1, endLine: 4, room: null, entryTs: ts }), "memory/notes.md:1-4 · 2026-05-14");
  } finally {
    resetAgentTimezone();
  }
});

test("queryTerms drops stopwords and dedupes", () => {
  assert.deepEqual(queryTerms(["What did we decide about the Launch", "launch"]), ["decide", "about", "launch"]);
});
