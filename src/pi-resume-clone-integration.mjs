import path from "node:path";

const KEYBINDING_MARKER = "pi-resume-clone-keybinding";
const SELECTOR_MARKER = "pi-resume-clone";
const CLONE_COMMAND = 'session="$PI_RESUME_CLONE_SESSION"; unset PI_RESUME_CLONE_SESSION; exec pi --fork "$session"';

function validAbsolutePath(value) {
  return typeof value === "string" &&
    path.isAbsolute(value) &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function buildResumeCloneWorkspaceArgs(session) {
  if (!validAbsolutePath(session?.path)) {
    throw new Error("resume clone requires an absolute session path");
  }
  const cwd = validAbsolutePath(session?.cwd) ? session.cwd : process.cwd();
  return [
    "new-workspace",
    "--name",
    "Forked Pi Session",
    "--cwd",
    cwd,
    "--env",
    `PI_RESUME_CLONE_SESSION=${session.path}`,
    "--command",
    CLONE_COMMAND,
    "--focus",
    "true"
  ];
}

export function patchPiResumeCloneKeybindingsSource(value) {
  const source = String(value ?? "");
  if (source.includes(KEYBINDING_MARKER)) return { source, changed: false };
  const anchor = [
    '    "app.session.rename": {',
    '        defaultKeys: "ctrl+r",',
    '        description: "Rename session",',
    '    },'
  ].join("\n");
  if (!source.includes(anchor)) {
    throw new Error("Pi session rename keybinding was not found; review the installed Pi version before patching");
  }
  const addition = [
    anchor,
    `    // ${KEYBINDING_MARKER}`,
    '    "app.session.clone": {',
    '        defaultKeys: "alt+enter",',
    '        description: "Clone selected session in a new cmux tab",',
    '    },'
  ].join("\n");
  return { source: source.replace(anchor, addition), changed: true };
}

export function patchPiResumeCloneSelectorSource(value) {
  let source = String(value ?? "");
  if (source.includes(SELECTOR_MARKER)) return { source, changed: false };

  const helperAnchor = "function canonicalizePath(path) {";
  const propertyAnchor = "    onRenameSession;";
  const hintAnchor = [
    '            if (this.showRenameHint) {',
    '                hint2Parts.push(keyHint("app.session.rename", "rename"));',
    '            }'
  ].join("\n");
  const inputAnchor = "        // Rename selected session";
  const wiringAnchor = "        // Sync list events to header";
  if (![helperAnchor, propertyAnchor, hintAnchor, inputAnchor, wiringAnchor].every((anchor) => source.includes(anchor))) {
    throw new Error("Pi session selector shape was not found; review the installed Pi version before patching");
  }

  const helper = [
    `// ${SELECTOR_MARKER}: clone a saved session without replacing the active session.`,
    "function launchResumeClone(session) {",
    '    const sessionPath = typeof session?.path === "string" ? session.path : "";',
    '    const cwd = typeof session?.cwd === "string" && session.cwd.startsWith("/") ? session.cwd : process.cwd();',
    '    if (!process.env.CMUX_WORKSPACE_ID) return { ok: false, error: "Clone in new tab requires cmux" };',
    '    if (!sessionPath.startsWith("/") || /[\\u0000-\\u001f\\u007f]/.test(sessionPath)) return { ok: false, error: "Invalid saved session path" };',
    "    const result = spawnSync(\"cmux\", [",
    '        "new-workspace", "--name", "Forked Pi Session",',
    '        "--cwd", cwd,',
    '        "--env", `PI_RESUME_CLONE_SESSION=${sessionPath}`,',
    '        "--command", \'session="$PI_RESUME_CLONE_SESSION"; unset PI_RESUME_CLONE_SESSION; exec pi --fork "$session"\',',
    '        "--focus", "true",',
    '    ], { encoding: "utf8" });',
    '    if (result.error) return { ok: false, error: result.error.message };',
    '    if (result.status !== 0) return { ok: false, error: result.stderr?.trim() || result.stdout?.trim() || `cmux exited ${result.status}` };',
    "    return { ok: true };",
    "}",
    ""
  ].join("\n");
  source = source.replace(helperAnchor, `${helper}${helperAnchor}`);
  source = source.replace(propertyAnchor, `${propertyAnchor}\n    onCloneSession;`);
  source = source.replace(
    hintAnchor,
    `${hintAnchor}\n            hint2Parts.push(keyHint("app.session.clone", "clone in new tab"));`
  );
  source = source.replace(
    inputAnchor,
    [
      '        if (kb.matches(keyData, "app.session.clone")) {',
      "            const selected = this.filteredSessions[this.selectedIndex];",
      "            if (selected) this.onCloneSession?.(selected.session);",
      "            return;",
      "        }",
      "",
      inputAnchor
    ].join("\n")
  );
  source = source.replace(
    wiringAnchor,
    [
      "        this.sessionList.onCloneSession = (session) => {",
      "            const result = launchResumeClone(session);",
      "            if (result.ok) {",
      "                clearStatusMessage();",
      "                onCancel();",
      "                return;",
      "            }",
      '            this.header.setStatusMessage({ type: "error", message: `Clone failed: ${result.error}` }, 4000);',
      "            this.requestRender();",
      "        };",
      wiringAnchor
    ].join("\n")
  );
  return { source, changed: true };
}
