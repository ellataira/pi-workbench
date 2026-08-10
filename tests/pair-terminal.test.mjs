import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  pairObservationMessage,
  parseCmuxSurface,
  terminalDelta,
  terminalOutputReady
} from "../src/pair-terminal.mjs";

test("pair terminal resolves the new cmux surface", () => {
  assert.equal(parseCmuxSurface("pane:4 surface:7\n"), "surface:7");
  assert.equal(
    parseCmuxSurface("created 123e4567-e89b-42d3-a456-426614174000"),
    "123e4567-e89b-42d3-a456-426614174000"
  );
  assert.throws(() => parseCmuxSurface("pane:4"), /surface/i);
});

test("pair terminal waits for execution instead of reacting to typed text", () => {
  assert.equal(terminalOutputReady("repo % npm test", "repo % npm test", 6000), false);
  assert.equal(
    terminalOutputReady("npm test\npassed\nrepo %", "npm test\npassed\nrepo %", 1200),
    true
  );
  assert.equal(
    terminalOutputReady("Choose an account:\n1. staging", "Choose an account:\n1. staging", 6000),
    true
  );
});

test("pair terminal emits only bounded redacted new output", () => {
  const before = "repo % npm test\nstarting\n";
  const after = `${before}\u001b[31mfailed\u001b[0m\nAPI_TOKEN=super-secret\nrepo % `;
  const delta = terminalDelta(before, after, { maxChars: 120, maxLines: 8 });
  assert.match(delta, /failed/);
  assert.match(delta, /API_TOKEN=\[redacted\]/);
  assert.doesNotMatch(delta, /super-secret|\u001b/);
  assert.doesNotMatch(delta, /npm test/);
});

test("pair observation requires analysis and one manual next command", () => {
  const message = pairObservationMessage("tests failed\nrepo % ");
  assert.match(message, /do not execute/i);
  assert.match(message, /exactly one next command/i);
  assert.match(message, /tests failed/);
});

test("pair terminal registers one guided command and one model-callable tool", async () => {
  const source = await readFile(
    new URL("../extensions/pi-pair-terminal.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /registerCommand\("pair"/);
  assert.match(source, /name: "pair_terminal"/);
  assert.doesNotMatch(source, /cmux\(\["send(?:-key)?"/);
});
