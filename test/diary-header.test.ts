import assert from "node:assert/strict";
import test from "node:test";
import { configureAgentTimezone } from "../src/time/index.js";
import { buildDiaryHeader, diaryHeaderRegex, draftBeginsWithHeader } from "../src/diary/index.js";

// node --test runs each file in its own process, so setting the zone here is safe.
configureAgentTimezone("UTC");

const EARLIEST = Date.UTC(2026, 5, 3, 14, 5); // 2026-06-03 14:05 UTC
const LATEST = Date.UTC(2026, 5, 3, 15, 30); // 2026-06-03 15:30 UTC

test("buildDiaryHeader renders the canonical uniform header", () => {
  const header = buildDiaryHeader({
    earliestTimestamp: EARLIEST,
    latestTimestamp: LATEST,
    room: "Project Hammer (Earendil)",
    timezone: "America/Los_Angeles",
  });
  assert.equal(
    header,
    "## 2026-06-03 14:05 → 2026-06-03 15:30 · America/Los_Angeles · Project Hammer (Earendil)",
  );
});

test("buildDiaryHeader keeps both full dates for a cross-midnight range", () => {
  const header = buildDiaryHeader({
    earliestTimestamp: Date.UTC(2026, 5, 3, 22, 30),
    latestTimestamp: Date.UTC(2026, 5, 4, 1, 15),
    room: "#general",
    timezone: "UTC",
  });
  assert.equal(header, "## 2026-06-03 22:30 → 2026-06-04 01:15 · UTC · #general");
});

test("diaryHeaderRegex matches headers with arbitrary room names but not prose or single-#", () => {
  const header = buildDiaryHeader({ earliestTimestamp: EARLIEST, latestTimestamp: LATEST, room: "Weird · Room → Name", timezone: "UTC" });
  assert.match(header, diaryHeaderRegex());

  // A `# Daily Memory` top header (single #) must never match.
  assert.doesNotMatch("# 2026-06-03 Daily Memory", diaryHeaderRegex());
  // Prose with an en-dash / hyphen must not false-match (we require U+2192).
  assert.doesNotMatch("## 2026-06-03 14:05 - 2026-06-03 15:30 · UTC · Room", diaryHeaderRegex());
  // A normal markdown H2 must not match.
  assert.doesNotMatch("## Some heading", diaryHeaderRegex());
});

test("diaryHeaderRegex finds every block boundary in a multi-entry file", () => {
  const a = buildDiaryHeader({ earliestTimestamp: EARLIEST, latestTimestamp: LATEST, room: "A", timezone: "UTC" });
  const b = buildDiaryHeader({ earliestTimestamp: LATEST, latestTimestamp: LATEST + 1000, room: "B", timezone: "UTC" });
  const text = `# 2026-06-03 Daily Memory\n\n${a}\nfirst entry body\n\n${b}\nsecond entry body\n`;
  const matches = text.match(diaryHeaderRegex());
  assert.equal(matches?.length, 2);
});

test("draftBeginsWithHeader normalizes surrounding whitespace but requires the exact header", () => {
  const header = buildDiaryHeader({ earliestTimestamp: EARLIEST, latestTimestamp: LATEST, room: "Room", timezone: "UTC" });
  assert.ok(draftBeginsWithHeader(`${header}\nbody`, header));
  assert.ok(draftBeginsWithHeader(`\n\n  ${header}\nbody`, header)); // leading whitespace tolerated
  assert.ok(!draftBeginsWithHeader("Dear diary,\nstuff", header));
  assert.ok(!draftBeginsWithHeader(`## wrong header\n${header}`, header));
});
