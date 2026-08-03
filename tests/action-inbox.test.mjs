import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acknowledgeInbox,
  buildInboxChoices,
  clearCompletedInbox,
  clearStaleInbox,
  createInboxItem,
  selectInboxItem,
  upsertInboxItem
} from "../src/action-inbox.mjs";
import {
  mutateInboxFile,
  readInboxFile
} from "../src/action-inbox-store.mjs";

test("action inbox stores fixed metadata without prompts or task text", () => {
  const item = createInboxItem({
    id: "session:abc",
    state: "blocked",
    source: "session",
    code: "authentication",
    sessionId: "abc",
    workspaceId: "workspace:7",
    task: "secret prompt",
    title: "copied user text",
    updatedAt: "2026-07-27T12:00:00Z"
  });

  assert.deepEqual(item, {
    id: "session:abc",
    state: "blocked",
    source: "session",
    code: "authentication",
    sessionId: "abc",
    workspaceId: "workspace:7",
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:00.000Z"
  });
  assert.equal("task" in item, false);
  assert.equal("title" in item, false);
});

test("action inbox updates one item, prioritizes blocked work, and acknowledges explicitly", () => {
  const completed = createInboxItem({
    id: "session:one",
    state: "completed",
    source: "session",
    code: "agent-complete",
    updatedAt: "2026-07-27T11:00:00Z"
  });
  const blocked = createInboxItem({
    id: "automation:two",
    state: "blocked",
    source: "automation",
    code: "authentication",
    updatedAt: "2026-07-27T10:00:00Z"
  });
  const updated = upsertInboxItem([completed], blocked);

  assert.equal(selectInboxItem(updated).id, "automation:two");
  assert.deepEqual(acknowledgeInbox(updated, "automation:two").map((item) => item.id), [
    "session:one"
  ]);
});

test("action inbox file mutations are atomic, owner-only, and preserve concurrent items", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-action-inbox-"));
  const file = path.join(root, "inbox.json");
  await Promise.all([
    mutateInboxFile(file, (items) =>
      upsertInboxItem(items, {
        id: "session:one",
        state: "completed",
        source: "session",
        code: "agent-complete"
      })
    ),
    mutateInboxFile(file, (items) =>
      upsertInboxItem(items, {
        id: "automation:two",
        state: "blocked",
        source: "automation",
        code: "authentication"
      })
    )
  ]);

  assert.equal((await readInboxFile(file)).length, 2);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
});

test("inbox choices use state, action, age, and source instead of raw identifiers", () => {
  const now = new Date("2026-07-30T12:00:00Z");
  const item = createInboxItem({
    id: "session:secret-uuid",
    state: "failed",
    source: "session",
    code: "tool-error",
    workspaceId: "workspace:7",
    updatedAt: "2026-07-30T11:55:00Z"
  });
  assert.deepEqual(buildInboxChoices([item], now), [
    {
      id: "session:secret-uuid",
      label: "Failed · Tool failed · 5m · session"
    }
  ]);
  assert.doesNotMatch(buildInboxChoices([item], now)[0].label, /secret-uuid|workspace:7/);
});

test("inbox maintenance clears completed work and only stale non-actionable work", () => {
  const now = new Date("2026-07-30T12:00:00Z");
  const items = [
    createInboxItem({
      id: "completed:new",
      state: "completed",
      source: "session",
      code: "agent-complete",
      updatedAt: "2026-07-30T11:00:00Z"
    }),
    createInboxItem({
      id: "completed:old",
      state: "completed",
      source: "automation",
      code: "automation-complete",
      updatedAt: "2026-07-20T11:00:00Z"
    }),
    createInboxItem({
      id: "failed:old",
      state: "failed",
      source: "automation",
      code: "automation-failed",
      updatedAt: "2026-07-20T11:00:00Z"
    })
  ];
  assert.deepEqual(clearCompletedInbox(items), [items[2]]);
  assert.deepEqual(clearStaleInbox(items, now), [items[0], items[2]]);
});
