import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  aggregatePetSessions,
  codexAnimationSequence,
  createPetFocusRequest,
  createPetSnapshot,
  dragAnimationState,
  lookFrameForPointer,
  parsePetFocusRequest,
  petPhaseForState,
  readPetFocusRequest,
  writePetFocusRequest,
  writePetSnapshot
} from "../src/pet-runtime.mjs";

test("pet snapshots expose lifecycle metadata without accepting conversation content", () => {
  const snapshot = createPetSnapshot({
    sessionId: "session-123",
    pid: 42,
    state: {
      phase: "tool",
      activeTools: 2,
      children: 1,
      lastTool: "bash"
    },
    workspaceId: "workspace:7",
    surfaceId: "surface:9",
    updatedAt: "2026-07-24T20:00:00.000Z"
  });

  assert.deepEqual(snapshot, {
    version: 1,
    client: "pi",
    sessionId: "session-123",
    pid: 42,
    phase: "running",
    activeTools: 2,
    children: 1,
    workspaceId: "workspace:7",
    surfaceId: "surface:9",
    updatedAt: "2026-07-24T20:00:00.000Z"
  });
  assert.equal(JSON.stringify(snapshot).includes("bash"), false);
  assert.equal("prompt" in snapshot, false);
  assert.equal("transcript" in snapshot, false);
});

test("pet lifecycle phases distinguish waiting, failure, completion, and idle", () => {
  assert.equal(petPhaseForState({ phase: "tool", lastTool: "ask_user_question" }), "waiting");
  assert.equal(petPhaseForState({ phase: "thinking", lastTool: "ask_user_question" }), "running");
  assert.equal(petPhaseForState({ phase: "error" }), "failed");
  assert.equal(petPhaseForState({ phase: "done" }), "completed");
  assert.equal(petPhaseForState({ phase: "idle" }), "idle");
  assert.equal(petPhaseForState({ phase: "children" }), "running");
});

test("pet animation sequencing matches Codex playback semantics", () => {
  const idle = codexAnimationSequence("idle");
  assert.deepEqual(
    idle.frames.map(({ row, column, durationMs }) => [row, column, durationMs]),
    [
      [0, 0, 1680],
      [0, 1, 660],
      [0, 2, 660],
      [0, 3, 840],
      [0, 4, 840],
      [0, 5, 1920]
    ]
  );
  assert.equal(idle.loopStartIndex, 0);

  const completed = codexAnimationSequence("completed");
  assert.equal(completed.frames.length, 24);
  assert.equal(completed.loopStartIndex, 18);
  assert.deepEqual(
    completed.frames.slice(0, 6).map(({ row, column }) => [row, column]),
    [
      [8, 0],
      [8, 1],
      [8, 2],
      [8, 3],
      [8, 4],
      [8, 5]
    ]
  );
  assert.deepEqual(
    completed.frames.slice(18).map(({ row, column }) => [row, column]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5]
    ]
  );

  assert.deepEqual(codexAnimationSequence("failed", { reducedMotion: true }), {
    frames: [{ row: 5, column: 0, durationMs: 140 }],
    loopStartIndex: null
  });
});

test("dragging selects Codex directional movement rows after four pixels", () => {
  assert.equal(dragAnimationState(null, 3), null);
  assert.equal(dragAnimationState(null, 4), "running-right");
  assert.equal(dragAnimationState("running-right", -3), "running-right");
  assert.equal(dragAnimationState("running-right", -4), "running-left");
});

test("idle pointer gaze maps clockwise into the sixteen v2 look cells", () => {
  const center = { petCenterX: 100, petCenterY: 100 };
  assert.equal(
    lookFrameForPointer({ ...center, pointerX: 100, pointerY: 110, deadzone: 12 }),
    null
  );
  assert.deepEqual(
    lookFrameForPointer({ ...center, pointerX: 100, pointerY: 200, deadzone: 12 }),
    { row: 9, column: 0 }
  );
  assert.deepEqual(
    lookFrameForPointer({ ...center, pointerX: 200, pointerY: 100, deadzone: 12 }),
    { row: 9, column: 4 }
  );
  assert.deepEqual(
    lookFrameForPointer({ ...center, pointerX: 100, pointerY: 0, deadzone: 12 }),
    { row: 10, column: 0 }
  );
  assert.deepEqual(
    lookFrameForPointer({ ...center, pointerX: 0, pointerY: 100, deadzone: 12 }),
    { row: 10, column: 4 }
  );
  assert.equal(
    lookFrameForPointer({
      ...center,
      pointerX: 200,
      pointerY: 100,
      deadzone: 12,
      spriteVersionNumber: 1
    }),
    null
  );
});

test("session aggregation prioritizes attention states and ignores stopped sessions", () => {
  const records = [
    { sessionId: "idle", phase: "idle", updatedAt: "2026-07-24T20:00:00.000Z" },
    { sessionId: "work", phase: "running", updatedAt: "2026-07-24T20:00:01.000Z" },
    { sessionId: "done", phase: "completed", updatedAt: "2026-07-24T20:00:02.000Z" },
    { sessionId: "wait", phase: "waiting", updatedAt: "2026-07-24T20:00:03.000Z" },
    { sessionId: "fail", phase: "failed", updatedAt: "2026-07-24T20:00:04.000Z" },
    { sessionId: "gone", phase: "stopped", updatedAt: "2026-07-24T20:00:05.000Z" }
  ];

  assert.equal(aggregatePetSessions(records).sessionId, "fail");
  assert.equal(
    aggregatePetSessions(records.filter((record) => record.phase !== "failed")).sessionId,
    "wait"
  );
  assert.equal(
    aggregatePetSessions(
      records.filter((record) => !["failed", "waiting"].includes(record.phase))
    ).sessionId,
    "done"
  );
});

test("session aggregation uses the newest record when priorities match", () => {
  const selected = aggregatePetSessions([
    { sessionId: "old", phase: "running", updatedAt: "2026-07-24T20:00:00.000Z" },
    { sessionId: "new", phase: "running", updatedAt: "2026-07-24T20:00:01.000Z" }
  ]);

  assert.equal(selected.sessionId, "new");
});

test("native pet applies the same bounded inbox attention window", async () => {
  const source = await readFile(
    new URL("../pet-app/Sources/PiPet/main.swift", import.meta.url),
    "utf8"
  );
  assert.match(source, /inboxAttentionWindow:\s*TimeInterval\s*=\s*15\s*\*\s*60/);
  assert.match(source, /inboxItemRequiresAttention/);
});

test("native pet acknowledges stale waiting, failed, and completed session states", async () => {
  const source = await readFile(
    new URL("../pet-app/Sources/PiPet/main.swift", import.meta.url),
    "utf8"
  );
  assert.match(source, /phaseRequiresAcknowledgement/);
  assert.match(source, /acknowledgedAttentionStates/);
  assert.match(source, /!acknowledgedAttentionStates\.contains\(snapshot\.completionKey\)/);
  assert.match(source, /acknowledgedAttentionStates\.insert\(selected\.completionKey\)/);
  assert.match(source, /withTimeInterval:\s*0\.5/);
});

test("pet snapshots are atomically stored as owner-only JSON", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-pet-runtime-"));
  try {
    const snapshot = createPetSnapshot({
      sessionId: "private-session",
      pid: process.pid,
      phase: "idle",
      state: {}
    });
    const destination = await writePetSnapshot(runtimeDir, snapshot);
    const stored = JSON.parse(await readFile(destination, "utf8"));
    const metadata = await stat(destination);

    assert.deepEqual(stored, snapshot);
    assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("concurrent pet snapshots for one session never share a temporary file", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-pet-concurrent-"));
  try {
    const snapshots = Array.from({ length: 20 }, (_, index) =>
      createPetSnapshot({
        sessionId: "busy-session",
        pid: process.pid,
        phase: index % 2 === 0 ? "running" : "waiting",
        state: { activeTools: index },
        updatedAt: new Date(Date.UTC(2026, 6, 24, 20, 0, index)).toISOString()
      })
    );

    const destinations = await Promise.all(
      snapshots.map((snapshot) => writePetSnapshot(runtimeDir, snapshot))
    );
    const stored = JSON.parse(await readFile(destinations[0], "utf8"));
    const files = await readdir(path.join(runtimeDir, "sessions"));

    assert.ok(snapshots.some((snapshot) => snapshot.updatedAt === stored.updatedAt));
    assert.deepEqual(new Set(destinations).size, 1);
    assert.deepEqual(files, [path.basename(destinations[0])]);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("pet reloads its runtime module and awaits asynchronous event emissions", async () => {
  const extension = await readFile(
    new URL("../extensions/pi-lifecycle-pet.ts", import.meta.url),
    "utf8"
  );

  assert.match(extension, /importFreshSourceModule\(runtimePath\)/);
  assert.doesNotMatch(
    extension,
    /from ["']\.\.\/src\/pet-runtime\.mjs["']/
  );
  assert.match(
    extension,
    /pi\.events\.on\("subagent:async-started", async \(\) =>/
  );
  assert.match(
    extension,
    /pi\.events\.on\("subagent:async-complete", async \(\) =>/
  );
});

test("focus requests accept only fixed routing metadata", () => {
  assert.deepEqual(
    parsePetFocusRequest({
      version: 1,
      sessionId: "session-123",
      requestedAt: "2026-07-24T20:00:00.000Z"
    }),
    {
      version: 1,
      sessionId: "session-123",
      requestedAt: "2026-07-24T20:00:00.000Z"
    }
  );
  assert.equal(
    parsePetFocusRequest({
      version: 1,
      sessionId: "session-123",
      requestedAt: "2026-07-24T20:00:00.000Z",
      prompt: "copied conversation"
    }),
    undefined
  );
});

test("focus requests round-trip through an owner-only atomic file", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "pi-pet-focus-"));
  try {
    const request = createPetFocusRequest(
      "session-focus",
      "2026-07-24T20:00:00.000Z"
    );
    const destination = await writePetFocusRequest(runtimeDir, request);
    const metadata = await stat(destination);

    assert.deepEqual(await readPetFocusRequest(runtimeDir), request);
    assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
