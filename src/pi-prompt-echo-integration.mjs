const PATCH_MARKER = "pi-prompt-immediate-echo";

function replaceRequired(source, pattern, replacement, description) {
  if (!pattern.test(source)) {
    throw new Error(`Pi ${description} was not found; review the installed Pi version before patching`);
  }
  return source.replace(pattern, replacement);
}

export function patchPiPromptEchoSource(value) {
  let source = String(value ?? "");
  if (source.includes(PATCH_MARKER)) return { source, changed: false };

  source = replaceRequired(
    source,
    /^([ \t]*)pendingUserInputs = \[\];/m,
    `$&\n$1// ${PATCH_MARKER}: submitted prompts awaiting Pi's canonical user-message event.\n$1pendingPromptEchoes = [];`,
    "prompt state field"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)setupEditorSubmitHandler\(\) \{/m,
    [
      `$1showSubmittedPromptEcho(text) {`,
      `$1    this.pendingPromptEchoes.push(text);`,
      `$1    this.addMessageToChat({`,
      `$1        role: "user",`,
      `$1        content: [{ type: "text", text }],`,
      `$1        timestamp: Date.now(),`,
      `$1    });`,
      `$1    this.ui.requestRender();`,
      `$1}`,
      `$1consumeSubmittedPromptEcho() {`,
      `$1    if (this.pendingPromptEchoes.length === 0)`,
      `$1        return false;`,
      `$1    this.pendingPromptEchoes.shift();`,
      `$1    return true;`,
      `$1}`,
      `$1releaseSubmittedPromptEcho(text) {`,
      `$1    const index = this.pendingPromptEchoes.indexOf(text);`,
      `$1    if (index >= 0)`,
      `$1        this.pendingPromptEchoes.splice(index, 1);`,
      `$1}`,
      `$1setupEditorSubmitHandler() {`,
    ].join("\n"),
    "editor submit handler"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)this\.flushPendingBashComponents\(\);\n([ \t]*)if \(this\.onInputCallback\) \{/m,
    `$1this.flushPendingBashComponents();\n$1if (!this.isExtensionCommand(text))\n$1    this.showSubmittedPromptEcho(text);\n$2if (this.onInputCallback) {`,
    "normal prompt submission path"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)else \{\n\1    this\.queueCompactionMessage\(text, "steer"\);/m,
    `$1else {\n$1    this.showSubmittedPromptEcho(text);\n$1    this.queueCompactionMessage(text, "steer");`,
    "compaction steering submission path"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)await this\.session\.prompt\(text, \{ streamingBehavior: "steer" \}\);/m,
    `$1if (!this.isExtensionCommand(text))\n$1    this.showSubmittedPromptEcho(text);\n$1await this.session.prompt(text, { streamingBehavior: "steer" });`,
    "streaming steering submission path"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)await this\.session\.prompt\(text, \{ streamingBehavior: "followUp" \}\);/m,
    `$1if (!this.isExtensionCommand(text))\n$1    this.showSubmittedPromptEcho(text);\n$1await this.session.prompt(text, { streamingBehavior: "followUp" });`,
    "streaming follow-up submission path"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)else if \(event\.message\.role === "user"\) \{\n([ \t]*)this\.addMessageToChat\(event\.message\);/m,
    `$1else if (event.message.role === "user") {\n$2if (!this.consumeSubmittedPromptEcho())\n$2    this.addMessageToChat(event.message);`,
    "user message event handler"
  );

  source = replaceRequired(
    source,
    /^([ \t]*)while \(true\) \{\n\1    const userInput = await this\.getUserInput\(\);\n\1    try \{\n\1        await this\.session\.prompt\(userInput\);\n\1    \}\n\1    catch \(error\) \{\n\1        const errorMessage = error instanceof Error \? error\.message : "Unknown error occurred";\n\1        this\.showError\(errorMessage\);\n\1    \}\n\1\}/m,
    `$1while (true) {\n$1    const userInput = await this.getUserInput();\n$1    try {\n$1        await this.session.prompt(userInput);\n$1    }\n$1    catch (error) {\n$1        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";\n$1        this.showError(errorMessage);\n$1    }\n$1    finally {\n$1        this.releaseSubmittedPromptEcho(userInput);\n$1    }\n$1}`,
    "interactive prompt loop"
  );

  return { source, changed: true };
}
