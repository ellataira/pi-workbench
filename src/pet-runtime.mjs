import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const allowedPhases = new Set([
  "idle",
  "running",
  "waiting",
  "review",
  "failed",
  "completed",
  "stopped"
]);

const phasePriority = {
  stopped: 0,
  idle: 10,
  running: 20,
  review: 25,
  completed: 30,
  waiting: 40,
  failed: 50
};

const idleFrames = [
  { row: 0, column: 0, durationMs: 280 },
  { row: 0, column: 1, durationMs: 110 },
  { row: 0, column: 2, durationMs: 110 },
  { row: 0, column: 3, durationMs: 140 },
  { row: 0, column: 4, durationMs: 140 },
  { row: 0, column: 5, durationMs: 320 }
];

const animationRows = {
  failed: { row: 5, count: 8, durationMs: 140, finalDurationMs: 240 },
  idle: { row: 0, count: 6, durationMs: 0, finalDurationMs: 0 },
  jumping: { row: 4, count: 5, durationMs: 140, finalDurationMs: 280 },
  review: { row: 8, count: 6, durationMs: 150, finalDurationMs: 280 },
  running: { row: 7, count: 6, durationMs: 120, finalDurationMs: 220 },
  "running-left": { row: 2, count: 8, durationMs: 120, finalDurationMs: 220 },
  "running-right": { row: 1, count: 8, durationMs: 120, finalDurationMs: 220 },
  waving: { row: 3, count: 4, durationMs: 140, finalDurationMs: 280 },
  waiting: { row: 6, count: 6, durationMs: 150, finalDurationMs: 260 }
};

const phaseAnimationState = {
  completed: "review",
  failed: "failed",
  idle: "idle",
  review: "review",
  running: "running",
  waiting: "waiting"
};

function rowFrames({ row, count, durationMs, finalDurationMs }) {
  return Array.from({ length: count }, (_, column) => ({
    row,
    column,
    durationMs: column === count - 1 ? finalDurationMs : durationMs
  }));
}

export function codexAnimationSequence(phase, { reducedMotion = false } = {}) {
  const state = phaseAnimationState[phase] ?? phase;
  const spec = animationRows[state] ?? animationRows.idle;
  const frames = state === "idle" ? idleFrames : rowFrames(spec);
  if (reducedMotion) {
    return { frames: [frames[0]], loopStartIndex: null };
  }

  const slowIdle = idleFrames.map((frame) => ({
    ...frame,
    durationMs: frame.durationMs * 6
  }));
  if (state === "idle") {
    return { frames: slowIdle, loopStartIndex: 0 };
  }

  const eventFrames = [...frames, ...frames, ...frames];
  return {
    frames: [...eventFrames, ...slowIdle],
    loopStartIndex: eventFrames.length
  };
}

export function dragAnimationState(currentState, deltaX) {
  if (deltaX >= 4) return "running-right";
  if (deltaX <= -4) return "running-left";
  return currentState;
}

export function lookFrameForPointer({
  pointerX,
  pointerY,
  petCenterX,
  petCenterY,
  deadzone = 24,
  spriteVersionNumber = 2
}) {
  if (spriteVersionNumber < 2) return null;
  const deltaX = pointerX - petCenterX;
  const deltaY = pointerY - petCenterY;
  if (Math.hypot(deltaX, deltaY) <= deadzone) return null;

  const degrees = (Math.atan2(deltaX, deltaY) * 180) / Math.PI;
  const direction = Math.round(((degrees + 360) % 360) / 22.5) % 16;
  return {
    row: direction < 8 ? 9 : 10,
    column: direction % 8
  };
}

function boundedCount(value) {
  return Math.max(0, Math.min(999, Number.isFinite(value) ? Math.trunc(value) : 0));
}

function optionalIdentifier(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

export function petPhaseForState(state) {
  if (state?.phase === "error") return "failed";
  if (state?.phase === "done") return "completed";
  if (state?.phase === "review") return "review";
  if (state?.phase === "idle") return "idle";
  if (state?.phase === "tool" && state?.lastTool === "ask_user_question") return "waiting";
  return "running";
}

export function createPetSnapshot({
  sessionId,
  pid,
  state,
  phase,
  workspaceId,
  surfaceId,
  updatedAt = new Date().toISOString()
}) {
  const normalizedPhase = phase ?? petPhaseForState(state);
  if (!allowedPhases.has(normalizedPhase)) {
    throw new Error(`Unsupported pet phase: ${normalizedPhase}`);
  }

  const snapshot = {
    version: 1,
    client: "pi",
    sessionId: String(sessionId).slice(0, 160),
    pid: Number.isInteger(pid) && pid > 0 ? pid : process.pid,
    phase: normalizedPhase,
    activeTools: boundedCount(state?.activeTools),
    children: boundedCount(state?.children),
    workspaceId: optionalIdentifier(workspaceId),
    surfaceId: optionalIdentifier(surfaceId),
    updatedAt
  };

  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined)
  );
}

export function aggregatePetSessions(records) {
  return records
    .filter((record) => allowedPhases.has(record?.phase) && record.phase !== "stopped")
    .sort((left, right) => {
      const priority = phasePriority[right.phase] - phasePriority[left.phase];
      if (priority) return priority;
      return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    })[0];
}

export function petSnapshotPath(runtimeDir, sessionId) {
  const digest = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 24);
  return path.join(runtimeDir, "sessions", `${digest}.json`);
}

export async function writePetSnapshot(runtimeDir, snapshot) {
  const destination = petSnapshotPath(runtimeDir, snapshot.sessionId);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  return destination;
}

export async function removePetSnapshot(runtimeDir, sessionId) {
  await rm(petSnapshotPath(runtimeDir, sessionId), { force: true });
}

export function petFocusRequestPath(runtimeDir) {
  return path.join(runtimeDir, "requests", "focus.json");
}

export function createPetFocusRequest(sessionId, requestedAt = new Date().toISOString()) {
  return parsePetFocusRequest({
    version: 1,
    sessionId: String(sessionId),
    requestedAt
  });
}

export function parsePetFocusRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "requestedAt,sessionId,version") return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 160) {
    return undefined;
  }
  if (typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt))) {
    return undefined;
  }
  return {
    version: 1,
    sessionId: value.sessionId,
    requestedAt: value.requestedAt
  };
}

export async function writePetFocusRequest(runtimeDir, request) {
  const parsed = parsePetFocusRequest(request);
  if (!parsed) throw new Error("Invalid pet focus request");
  const destination = petFocusRequestPath(runtimeDir);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  return destination;
}

export async function readPetFocusRequest(runtimeDir) {
  try {
    return parsePetFocusRequest(
      JSON.parse(await readFile(petFocusRequestPath(runtimeDir), "utf8"))
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function clearPetFocusRequest(runtimeDir) {
  await rm(petFocusRequestPath(runtimeDir), { force: true });
}
