const PATCH_MARKER = "pi-escape-reliable-interrupt";

function replaceRequired(source, pattern, replacement, description) {
  if (!pattern.test(source)) {
    throw new Error(`Pi ${description} was not found; review the installed Pi version before patching`);
  }
  return source.replace(pattern, replacement);
}

export function patchPiEscapeInterruptEditorSource(value) {
  let source = String(value ?? "");
  if (source.includes(PATCH_MARKER)) return { source, changed: false };

  source = replaceRequired(
    source,
    /^([ \t]*)onPasteImage;$/m,
    `$&\n$1// ${PATCH_MARKER}: allow active agent work to be interrupted even when autocomplete consumed Escape.\n$1shouldInterruptAfterAutocomplete;`,
    "custom editor interrupt state field"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)\/\/ Check app keybindings first\n\1\/\/ Escape\/interrupt - only if autocomplete is NOT active\n\1if \(this\.keybindings\.matches\(data, "app\.interrupt"\)\) \{\n\1    if \(!this\.isShowingAutocomplete\(\)\) \{\n\1        \/\/ Use dynamic onEscape if set, otherwise registered handler\n\1        const handler = this\.onEscape \?\? this\.actionHandlers\.get\("app\.interrupt"\);\n\1        if \(handler\) \{\n\1            handler\(\);\n\1            return;\n\1        \}\n\1    \}\n\1    \/\/ Let parent handle escape for autocomplete cancellation\n\1    super\.handleInput\(data\);\n\1    return;\n\1\}/m,
    [
      `$1// Check app keybindings first`,
      `$1// Escape/interrupt. If autocomplete is open, let the editor close it first,`,
      `$1// then optionally pass Escape through to the app interrupt handler while Pi is busy.`,
      `$1if (this.keybindings.matches(data, "app.interrupt")) {`,
      `$1    const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");`,
      `$1    const hadAutocomplete = this.isShowingAutocomplete();`,
      `$1    if (!hadAutocomplete) {`,
      `$1        if (handler) {`,
      `$1            handler();`,
      `$1            return;`,
      `$1        }`,
      `$1    }`,
      `$1    super.handleInput(data);`,
      `$1    if (hadAutocomplete && !this.isShowingAutocomplete() && this.shouldInterruptAfterAutocomplete?.() && handler) {`,
      `$1        handler();`,
      `$1    }`,
      `$1    return;`,
      `$1}`
    ].join("\n"),
    "custom editor interrupt handler"
  );

  return { source, changed: true };
}

export function patchPiEscapeInterruptInteractiveSource(value) {
  let source = String(value ?? "");
  if (source.includes(PATCH_MARKER)) return { source, changed: false };

  source = replaceRequired(
    source,
    /^([ \t]*)this\.defaultEditor\.onEscape = \(\) => \{\n[\s\S]*?\n\1\};\n\1\/\/ Register app action handlers/m,
    (match, indent) => [
      match.replace(`${indent}// Register app action handlers`, "").trimEnd(),
      `${indent}// ${PATCH_MARKER}: Escape should still interrupt active work after closing autocomplete.`,
      `${indent}this.defaultEditor.shouldInterruptAfterAutocomplete = () => this.session.isStreaming || this.session.isBashRunning || this.session.isCompacting || this.session.isRetrying;`,
      `${indent}// Register app action handlers`
    ].join("\n"),
    "interactive escape handler"
  );

  return { source, changed: true };
}
