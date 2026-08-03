const PATCH_MARKER = "pi-copy-command-picker";
const NATIVE_COPY_HANDLER = /(\s*)if \(text === "\/copy"\) \{\n\1    await this\.handleCopyCommand\(\);\n\1    this\.editor\.setText\(""\);\n\1    return;\n\1\}/;

export function patchPiCopySource(value) {
  const source = String(value ?? "");
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  const match = source.match(NATIVE_COPY_HANDLER);
  if (!match) throw new Error("Pi native /copy handler was not found; review the installed Pi version before patching");
  const indent = match[1];
  const replacement = [
    `${indent}if (text === "/copy") {`,
    `${indent}    // ${PATCH_MARKER}: delegate to the vendor-neutral command picker extension.`,
    `${indent}    if (this.session.extensionRunner.getCommand("copy-command")) {`,
    `${indent}        this.editor.setText("");`,
    `${indent}        await this.session.prompt("/copy-command");`,
    `${indent}        return;`,
    `${indent}    }`,
    `${indent}    await this.handleCopyCommand();`,
    `${indent}    this.editor.setText("");`,
    `${indent}    return;`,
    `${indent}}`
  ].join("\n");
  return {
    source: source.replace(NATIVE_COPY_HANDLER, replacement),
    changed: true
  };
}
