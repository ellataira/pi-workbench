import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  parseCmuxTarget,
  parseCmuxSurfaceTargets,
  reviewUrlMatches
} from "../src/review-cmux.mjs";

test("cmux review popout parses structured window and surface identifiers", () => {
  assert.equal(
    parseCmuxTarget('{"ok":true,"data":{"window_ref":"window:4"}}', "window"),
    "window:4"
  );
  assert.equal(
    parseCmuxTarget('{"surface":{"id":"123e4567-e89b-42d3-a456-426614174000"}}', "surface"),
    "123e4567-e89b-42d3-a456-426614174000"
  );
});

test("review popout verifies the exact loopback page", () => {
  assert.equal(
    reviewUrlMatches(
      "http://127.0.0.1:4312/review/abc",
      "http://127.0.0.1:4312/review/abc"
    ),
    true
  );
  assert.equal(
    reviewUrlMatches("about:blank", "http://127.0.0.1:4312/review/abc"),
    false
  );
});

test("review popout identifies every surface in its dedicated window", () => {
  assert.deepEqual(
    parseCmuxSurfaceTargets(JSON.stringify({
      windows: [{ workspaces: [{ panes: [
        { surfaces: [{ surface_ref: "surface:1" }] },
        { surfaces: [{ surface_ref: "surface:2" }] }
      ] }] }]
    })),
    ["surface:1", "surface:2"]
  );
});

test("review popout uses structured browser open and closes incomplete windows", async () => {
  const source = await readFile(
    new URL("../extensions/pi-review-surface.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /"--json", "browser", "open", url/);
  assert.match(source, /"wait", "--url", url, "--timeout-ms", "3000"/);
  assert.match(source, /"close-window", "--window", createdWindow/);
  assert.match(source, /pruneReviewWindowSurfaces\(createdWindow, createdSurface\)/);
  assert.match(source, /reviewUrlMatches/);
  assert.doesNotMatch(source, /"browser", "new", url/);
});
