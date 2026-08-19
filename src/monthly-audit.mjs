export function monthlyAuditSucceeded(result) {
  return result.auditExit === 0 &&
    result.canaryExit === 0 &&
    result.testExit === 0 &&
    result.issueCount === 0;
}

export function monthlyAuditInboxItem(now = new Date(), succeeded = false) {
  const timestamp = now.toISOString();
  return {
    id: "automation:pi-monthly-health",
    state: succeeded ? "completed" : "failed",
    source: "automation",
    code: "health-audit",
    automationId: "pi-monthly-health",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
