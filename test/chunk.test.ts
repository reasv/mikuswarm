import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdownText } from "../src/tools/chunk.js";

describe("chunkMarkdownText", () => {
  describe("fence opened with openFence=null (first chunk)", () => {
    it("first chunk must not exceed limit when a fence opens in the candidate", () => {
      // Build content: a code fence that opens within a tight limit.
      // "```python\n" = 10 chars, then we add body to force chunking.
      const fence = "```python";
      const body = "x".repeat(50);
      const text = `${fence}\n${body}\n\`\`\``;
      const limit = 50;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
      // Recombining (stripping inserted fence markers) should preserve content
      assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
    });

    it("handles the exact example from the bug report: ```python at limit 50", () => {
      // "```python\n" (10) + 40 chars body = 50 before close marker
      const text = "```python\n" + "a".repeat(40) + "\n```";
      const limit = 50;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
    });

    it("handles fence that opens near the very start of the text", () => {
      const text = "```\n" + "y".repeat(100) + "\n```";
      const limit = 30;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
    });
  });

  describe("subsequent chunks with openFence set", () => {
    it("chunks with reopened fences do not exceed limit", () => {
      // Long fenced block that requires multiple chunks
      const text = "```python\n" + "line\n".repeat(100) + "```";
      const limit = 60;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
      assert.ok(chunks.length >= 3, `Expected at least 3 chunks, got ${chunks.length}`);
    });
  });

  describe("content without fences", () => {
    it("plain text is unaffected", () => {
      const text = "Hello world. ".repeat(20).trim();
      const limit = 50;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
      // All content should be preserved
      const joined = chunks.join(" ");
      assert.ok(joined.includes("Hello world"), "Content should be preserved");
    });

    it("returns single chunk when text fits within limit", () => {
      const text = "Short text";
      const chunks = chunkMarkdownText(text, 100);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0], text);
    });

    it("returns empty array for empty string", () => {
      const chunks = chunkMarkdownText("", 100);
      assert.deepEqual(chunks, []);
    });
  });

  describe("paragraph and newline breaks", () => {
    it("prefers paragraph breaks", () => {
      const text = "First paragraph.\n\nSecond paragraph that is longer.";
      const limit = 30;
      const chunks = chunkMarkdownText(text, limit);

      // Should split at the paragraph break
      assert.ok(chunks[0].includes("First paragraph"), "First chunk should contain first paragraph");
      assert.ok(chunks.length >= 2, "Should produce multiple chunks");
      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
    });

    it("falls back to newline breaks", () => {
      const text = "Line one\nLine two is a bit longer\nLine three";
      const limit = 25;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
    });

    it("falls back to word boundaries", () => {
      const text = "This is a long line without any newlines but with spaces between words";
      const limit = 30;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
    });
  });

  describe("edge cases with fences", () => {
    it("fence that opens and closes within the same chunk", () => {
      const text = "before\n```\ncode\n```\nafter";
      const limit = 100;
      const chunks = chunkMarkdownText(text, limit);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0], text);
    });

    it("tilde fences work the same as backtick fences", () => {
      const text = "~~~python\n" + "z".repeat(80) + "\n~~~";
      const limit = 50;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
    });

    it("mixed prose and fenced code", () => {
      const text =
        "Some prose before.\n\n```js\nconsole.log('hello');\nconsole.log('world');\n```\n\nSome prose after.";
      const limit = 40;
      const chunks = chunkMarkdownText(text, limit);

      for (let i = 0; i < chunks.length; i++) {
        assert.ok(
          chunks[i].length <= limit,
          `Chunk ${i} is ${chunks[i].length} chars, exceeds limit ${limit}: ${JSON.stringify(chunks[i])}`
        );
      }
    });
  });
});
