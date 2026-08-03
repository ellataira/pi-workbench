import test from "node:test";
import assert from "node:assert/strict";

import { initialPetState, petLabel, reducePetState } from "../src/pet-state.mjs";

test("pet follows thinking, parallel tools, failure, and settled lifecycle", () => {
  let state = reducePetState(initialPetState(), { type: "agent-start" });
  assert.equal(petLabel(state), "◔ᴥ◔ thinking");

  state = reducePetState(state, { type: "tool-start", toolName: "read" });
  state = reducePetState(state, { type: "tool-start", toolName: "grep" });
  assert.equal(petLabel(state), "•ᴥ• 2 tools");

  state = reducePetState(state, { type: "tool-end", isError: true });
  assert.equal(petLabel(state), "×ᴥ× tool error");

  state = reducePetState(state, { type: "agent-settled" });
  assert.equal(petLabel(state), "ᵔᴥᵔ done");
});

test("pet surfaces active subagents without losing tool counts", () => {
  let state = reducePetState(initialPetState(), { type: "subagent-start" });
  state = reducePetState(state, { type: "tool-start", toolName: "bash" });
  assert.equal(petLabel(state), "ᵔᴥᵔ 1 pup · 1 tool");

  state = reducePetState(state, { type: "subagent-complete" });
  assert.equal(petLabel(state), "•ᴥ• bash");
});
