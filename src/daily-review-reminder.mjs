import { distillationTarget } from "./maintenance-policy.mjs";

export function dailyReviewReminder(now = new Date(), state = {}) {
  const date = distillationTarget(now, state, {
    hour: 9,
    timeZone: "America/New_York"
  });
  if (!date) return undefined;
  return {
    id: `distillation:${date}`,
    state: "approval",
    source: "distillation",
    code: "daily-distillation",
    automationId: "pi-daily-memory-review",
    updatedAt: now.toISOString()
  };
}

export async function sendDailyReviewNotification(
  reminder,
  execute,
  platform = process.platform
) {
  if (platform !== "darwin") return false;
  try {
    await execute("/usr/bin/osascript", [
      "-e",
      `display notification "Open Pi and run /distill ${reminder.id.slice(
        "distillation:".length
      )}" with title "Daily Pi memory review"`
    ]);
    return true;
  } catch {
    return false;
  }
}
