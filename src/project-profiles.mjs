const thinkingLevels = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

function shortString(value, maxLength = 240) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, maxLength);
}

function uniqueStrings(value, maxItems, maxLength = 160) {
  if (!Array.isArray(value)) return undefined;
  const values = [...new Set(
    value
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim().slice(0, maxLength))
  )].slice(0, maxItems);
  return values.length ? values : undefined;
}

export function normalizeProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile must be an object");
  }
  const provider = shortString(value.provider);
  const model = shortString(value.model);
  if (Boolean(provider) !== Boolean(model)) {
    throw new Error("Profile model selection requires both provider and model");
  }
  const thinkingLevel = thinkingLevels.has(value.thinkingLevel)
    ? value.thinkingLevel
    : undefined;
  const tools = uniqueStrings(value.tools, 128);
  const verification = uniqueStrings(value.verification, 12, 80);
  let agentPolicy;
  if (value.agentPolicy && typeof value.agentPolicy === "object") {
    const maxConcurrency = Number.isInteger(value.agentPolicy.maxConcurrency)
      ? Math.max(1, Math.min(16, value.agentPolicy.maxConcurrency))
      : undefined;
    const oneWriterPerCheckout =
      typeof value.agentPolicy.oneWriterPerCheckout === "boolean"
        ? value.agentPolicy.oneWriterPerCheckout
        : undefined;
    agentPolicy = Object.fromEntries(
      Object.entries({ maxConcurrency, oneWriterPerCheckout }).filter(
        ([, entry]) => entry !== undefined
      )
    );
    if (!Object.keys(agentPolicy).length) agentPolicy = undefined;
  }
  return Object.fromEntries(
    Object.entries({
      provider,
      model,
      thinkingLevel,
      tools,
      verification,
      agentPolicy
    }).filter(([, entry]) => entry !== undefined)
  );
}

export function mergeProfiles(globalProfiles, projectProfiles) {
  const result = {};
  for (const [name, profile] of Object.entries({
    ...(globalProfiles ?? {}),
    ...(projectProfiles ?? {})
  })) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) continue;
    result[name] = normalizeProfile(profile);
  }
  return result;
}

export function profileInstructions(name, profile) {
  const lines = [`PROJECT PROFILE: ${name}`];
  if (profile.agentPolicy?.maxConcurrency) {
    lines.push(`- Cap concurrent agents at ${profile.agentPolicy.maxConcurrency}.`);
  }
  if (profile.agentPolicy?.oneWriterPerCheckout) {
    lines.push("- Keep one writer per checkout.");
  }
  if (profile.verification?.length) {
    lines.push(`- Required verification categories: ${profile.verification.join(", ")}.`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

export function buildProfileChoices(profiles, activeName) {
  const choices = Object.keys(profiles ?? {})
    .sort()
    .map((name) => {
      const profile = profiles[name];
      const details = [
        profile.thinkingLevel ? `think:${profile.thinkingLevel}` : "",
        profile.verification?.length
          ? `verify: ${profile.verification.join(", ")}`
          : ""
      ].filter(Boolean);
      return {
        name,
        label: `${name === activeName ? "Active · " : ""}${name}${details.length ? ` · ${details.join(" · ")}` : ""}`
      };
    });
  choices.push({ name: "off", label: "Turn profile off" });
  return choices;
}
