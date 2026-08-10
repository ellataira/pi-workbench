const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIME_ZONE = "America/New_York";

function zonedParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function previousDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function nextDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export async function distillationCatchupPlan(
  startDate,
  latestDate,
  candidatesForDate,
  { maxDays = 31 } = {}
) {
  let date = startDate;
  let emptyThrough;
  for (let count = 0; count < maxDays && date <= latestDate; count += 1) {
    const candidates = await candidatesForDate(date);
    if (candidates.length) {
      return { emptyThrough, reviewDate: date, candidates };
    }
    emptyThrough = date;
    date = nextDate(date);
  }
  return { emptyThrough, reviewDate: undefined, candidates: [] };
}

export function previousLocalDate(
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE
) {
  return previousDate(localDateKey(now, timeZone));
}

export function localDateKey(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = zonedParts(now, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function distillationTarget(now = new Date(), state = {}, options = {}) {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const hour = Number(options.hour ?? 9);
  const parts = zonedParts(now, timeZone);
  if (Number(parts.hour) < hour) return undefined;
  const latest = previousDate(`${parts.year}-${parts.month}-${parts.day}`);
  const completed = String(state.completedThrough ?? "");
  if (completed >= latest) return undefined;
  const target = /^\d{4}-\d{2}-\d{2}$/.test(completed)
    ? nextDate(completed)
    : latest;
  if (state.lastPromptedFor === target) return undefined;
  return target;
}

export function isRetentionEligible(timestamp, now = new Date(), days = 30) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return false;
  return value <= now.getTime() - Number(days) * DAY_MS;
}

export function shouldRunCleanupAudit(now = new Date(), state = {}) {
  const previous = Date.parse(state.lastCleanupAuditAt ?? "");
  return !Number.isFinite(previous) || previous <= now.getTime() - 7 * DAY_MS;
}

export const maintenanceDefaults = Object.freeze({
  distillationHour: 9,
  timeZone: DEFAULT_TIME_ZONE,
  nativeSessionRetentionDays: 30,
  cleanupAuditDays: 7
});
