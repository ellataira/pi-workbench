const UUID = /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i;

function collect(value, keyPath = "", output = []) {
  if (typeof value === "string") {
    output.push({ keyPath, value });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collect(entry, `${keyPath}.${index}`, output));
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collect(entry, keyPath ? `${keyPath}.${key}` : key, output);
    }
  }
  return output;
}

export function parseCmuxTarget(output, kind) {
  const source = String(output ?? "").trim();
  if (!source || !/^(?:window|surface)$/.test(kind)) return "";
  try {
    const values = collect(JSON.parse(source));
    const named = values.filter(({ keyPath }) =>
      keyPath.toLowerCase().includes(kind)
    );
    const shortRef = named.find(({ value }) =>
      new RegExp(`^${kind}:\\d+$`).test(value)
    );
    if (shortRef) return shortRef.value;
    const identifier = named.find(({ value }) => UUID.test(value));
    if (identifier) return identifier.value;
  } catch {
    // Fall through to the bounded plain-text compatibility parser.
  }
  const shortRef = source.match(new RegExp(`\\b${kind}:\\d+\\b`))?.[0];
  if (shortRef) return shortRef;
  return source.match(/[a-f0-9]{8}-[a-f0-9-]{27,}/i)?.[0] ?? "";
}

export function parseCmuxSurfaceTargets(output) {
  const source = String(output ?? "").trim();
  if (!source) return [];
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [...new Set(source.match(/\bsurface:\d+\b/g) ?? [])];
  }
  const targets = [];
  function visit(value, insideSurfaces = false) {
    if (Array.isArray(value)) {
      if (insideSurfaces) {
        for (const entry of value) {
          const target = parseCmuxTarget(JSON.stringify(entry), "surface");
          if (target) targets.push(target);
        }
        return;
      }
      value.forEach((entry) => visit(entry, false));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      visit(entry, key.toLowerCase() === "surfaces");
    }
  }
  visit(parsed);
  return [...new Set(targets)];
}

export function reviewUrlMatches(actual, expected) {
  try {
    const actualUrl = new URL(String(actual).trim());
    const expectedUrl = new URL(String(expected).trim());
    return actualUrl.origin === expectedUrl.origin &&
      actualUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}
