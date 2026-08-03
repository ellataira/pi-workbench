#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReviewServer } from "../src/review-surface.mjs";

const CHROME_PATH =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT_MS = 10_000;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, message, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    }
  };
}

async function run() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-e2e-"));
  const profile = path.join(root, "chrome-profile");
  const markdownPath = path.join(root, "review.md");
  const commentsPath = path.join(root, "comments.json");
  await writeFile(
    markdownPath,
    [
      "# Multiple comment flow",
      "",
      "The first passage contains alpha for the initial comment.",
      "",
      "The second passage contains beta for the follow-up comment.",
      "",
      "The third passage contains gamma for batch mode.",
      "",
      "The fourth passage contains delta for the final comment.",
      "",
      "`nccl_test.mfu` is a DogStatsD workload signal. When its 30-second value range exceeds `range_epsilon`, lookback forwards retained GPU context. The monitor metric is admitted automatically; it does not need to appear under `dogstatsd.metric_names`.",
      ""
    ].join("\n"),
    "utf8"
  );

  const drafts = [];
  const service = await createReviewServer({
    allowedRoots: [root],
    commentsPath,
    onAppendDraft: async (draft) => drafts.push(draft)
  });
  const opened = await service.openFile(markdownPath);
  const chrome = spawn(CHROME_PATH, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });
  const chromeExited = new Promise((resolve) => chrome.once("exit", resolve));
  let cdp;

  try {
    const port = await waitFor(async () => {
      try {
        const value = await readFile(path.join(profile, "DevToolsActivePort"), "utf8");
        return Number(value.split(/\r?\n/, 1)[0]) || 0;
      } catch {
        return 0;
      }
    }, "Chrome did not expose a debugging port");
    const target = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(opened.url)}`,
      { method: "PUT" }
    ).then((response) => response.json());
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
      }
      return result.result.value;
    };
    await waitFor(
      () => evaluate("document.readyState === 'complete' && !!document.querySelector('#preview')"),
      "Review page did not load"
    );

    const wordRect = (word) => evaluate(`(() => {
      const walker = document.createTreeWalker(
        document.querySelector("#preview"),
        NodeFilter.SHOW_TEXT
      );
      let node;
      while ((node = walker.nextNode())) {
        const index = node.textContent.indexOf(${JSON.stringify(word)});
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + ${JSON.stringify(word)}.length);
        const rect = range.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom
        };
      }
      return null;
    })()`);

    const selectWord = async (word, { mayBeConsumed = false } = {}) => {
      const rect = await waitFor(
        () => wordRect(word),
        `Could not locate rendered word ${word}`
      );
      const y = (rect.top + rect.bottom) / 2;
      const x = (rect.left + rect.right) / 2;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 2
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 2
      });
      await delay(100);
      const selection = await evaluate("window.getSelection().toString()");
      if (mayBeConsumed && !selection.includes(word)) return;
      if (!selection.includes(word)) {
        const debug = await evaluate(`(() => {
          const node = document.elementFromPoint(${(rect.left + rect.right) / 2}, ${y});
          return {
            selection: window.getSelection().toString(),
            target: node?.outerHTML?.slice(0, 240) ?? null
          };
        })()`);
        throw new Error(
          `Native selection did not capture ${word}: ${JSON.stringify(debug)}`
        );
      }
    };

    const selectAcrossWords = async (startWord, endWord) => {
      const endpoints = await waitFor(
        () => evaluate(`(() => {
          const preview = document.querySelector("#preview");
          const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
          let node;
          let start = null;
          let end = null;
          while ((node = walker.nextNode())) {
            if (!start) {
              const index = node.textContent.indexOf(${JSON.stringify(startWord)});
              if (index !== -1) {
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + 1);
                start = range.getBoundingClientRect();
              }
            }
            const index = node.textContent.indexOf(${JSON.stringify(endWord)});
            if (index !== -1) {
              const range = document.createRange();
              range.setStart(node, index + ${JSON.stringify(endWord)}.length - 1);
              range.setEnd(node, index + ${JSON.stringify(endWord)}.length);
              end = range.getBoundingClientRect();
            }
          }
          if (!start || !end) return null;
          return {
            start: { x: start.left + 1, y: (start.top + start.bottom) / 2 },
            end: { x: end.right - 1, y: (end.top + end.bottom) / 2 }
          };
        })()`),
        `Could not locate rendered range ${startWord}…${endWord}`
      );
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: endpoints.start.x,
        y: endpoints.start.y
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: endpoints.start.x,
        y: endpoints.start.y,
        button: "left",
        buttons: 1,
        clickCount: 1
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: endpoints.end.x,
        y: endpoints.end.y,
        button: "left",
        buttons: 1
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: endpoints.end.x,
        y: endpoints.end.y,
        button: "left",
        buttons: 0,
        clickCount: 1
      });
      await delay(100);
    };

    const click = async (selector) => {
      const rect = await waitFor(
        () => evaluate(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node || node.classList.contains("hidden")) return null;
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        })()`),
        `Control did not appear: ${selector}`
      );
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1
      });
    };

    const fillComment = async (value) => {
      await click("#inline-comment-edit");
      await cdp.send("Input.insertText", { text: value });
    };

    await selectWord("alpha");
    await click("#selection-action");
    await waitFor(
      () => evaluate("!document.querySelector('#inline-editor').classList.contains('hidden')"),
      "First inline editor did not open"
    );
    await fillComment("First review comment");
    await click("#inline-update");
    await waitFor(
      () => evaluate(`(() => {
        const editor = document.querySelector("#inline-editor");
        return editor.classList.contains("hidden") &&
          document.querySelectorAll(".annotation").length === 1;
      })()`),
      "First normal update did not settle"
    );

    await selectWord("beta");
    await click("#selection-action");
    await waitFor(
      () => evaluate(`(() => {
        const editor = document.querySelector("#inline-editor");
        return !editor.classList.contains("hidden") &&
          document.querySelectorAll(".annotation").length === 2;
      })()`),
      "Second inline editor did not open from the floating action"
    );
    await fillComment("Second review comment");
    await click("#inline-update");
    await waitFor(
      () => evaluate(`(() => {
        const editor = document.querySelector("#inline-editor");
        return editor.classList.contains("hidden") &&
          document.querySelectorAll(".annotation").length === 2 &&
          document.querySelector("#status").textContent === "Inline comment updated";
      })()`),
      "Second normal update did not settle"
    );

    await selectWord("gamma");
    await click("#selection-action");
    await waitFor(
      () => evaluate("!document.querySelector('#inline-editor').classList.contains('hidden')"),
      "Batch-mode editor did not open"
    );
    await fillComment("Third review comment");
    await click("#inline-update-next");
    await waitFor(
      () => evaluate("document.querySelector('#status').textContent === 'Comment saved — select another passage'"),
      "Add-another mode was not armed"
    );

    await selectWord("delta", { mayBeConsumed: true });
    await waitFor(
      () => evaluate(`(() => {
        const editor = document.querySelector("#inline-editor");
        return !editor.classList.contains("hidden") &&
          document.querySelectorAll(".annotation").length === 4;
      })()`),
      "Add-another editor did not open automatically"
    );
    await fillComment("Fourth review comment");
    await click("#inline-update");
    await waitFor(
      () => evaluate("document.querySelector('#inline-editor').classList.contains('hidden')"),
      "Fourth normal update did not settle"
    );

    await selectAcrossWords("initial", "follow-up");
    await click("#selection-action");
    await waitFor(
      () => evaluate(`(() => {
        const editor = document.querySelector("#inline-editor");
        return !editor.classList.contains("hidden") &&
          document.querySelectorAll(".annotation").length === 5;
      })()`),
      "Multi-line inline editor did not open"
    );
    await fillComment("Multi-line review comment");
    await click("#inline-update");
    await waitFor(
      () => evaluate("document.querySelector('#inline-editor').classList.contains('hidden')"),
      "Multi-line update did not settle"
    );

    await selectAcrossWords("nccl_test.mfu", "dogstatsd.metric_names");
    await click("#selection-action");
    await waitFor(
      () => evaluate(`(() => {
        const editor = document.querySelector("#inline-editor");
        return !editor.classList.contains("hidden") &&
          document.querySelectorAll(".annotation").length === 6;
      })()`),
      "Wrapped inline-code editor did not open"
    );
    await fillComment("Wrapped inline-code review comment");
    await click("#inline-update");
    const result = await waitFor(
      () => evaluate(`(() => {
        const annotations = [...document.querySelectorAll(".annotation")];
        if (annotations.length !== 6) return null;
        const comments = annotations.map((node) => node.textContent);
        const expected = [
          "First review comment",
          "Second review comment",
          "Third review comment",
          "Fourth review comment",
          "Multi-line review comment",
          "Wrapped inline-code review comment"
        ];
        if (!expected.every((comment) =>
          comments.some((rendered) => rendered.includes(comment))
        )) return null;
        const commentNodes = [...document.querySelectorAll(".annotation-comment")];
        if (
          commentNodes.length !== annotations.length ||
          commentNodes.some((node) => getComputedStyle(node).textAlign !== "left")
        ) return null;
        return {
          annotationCount: annotations.length,
          commentTextAlign: getComputedStyle(commentNodes[0]).textAlign,
          comments,
          source: document.querySelector("#editor").value
        };
      })()`),
      "All completed comments were not rendered"
    );
    if (
      !result.source.includes("[an: First review comment]") ||
      !result.source.includes("[an: Second review comment]") ||
      !result.source.includes("[an: Third review comment]") ||
      !result.source.includes("[an: Fourth review comment]") ||
      !result.source.includes("[an: Multi-line review comment]") ||
      !result.source.includes("[an: Wrapped inline-code review comment]")
    ) {
      throw new Error("All comments were not staged in Markdown source");
    }
    await click("#send");
    await waitFor(
      () => evaluate("document.querySelector('#status').textContent === 'Waiting for file changes'"),
      "Submitted review did not enter waiting state"
    );
    if (
      drafts.length !== 1 ||
      !/^1\. Line \d+: First review comment$/m.test(drafts[0]) ||
      !/^6\. Line \d+: Wrapped inline-code review comment$/m.test(drafts[0])
    ) {
      throw new Error("Submitted review batch omitted Markdown source line numbers");
    }
    const revisedSource = "# Revised after review\n\nAll submitted comments were addressed.\n";
    await writeFile(markdownPath, revisedSource, "utf8");
    const refreshed = await waitFor(
      () => evaluate(`(() => {
        const source = document.querySelector("#editor").value;
        const status = document.querySelector("#status").textContent;
        const annotations = document.querySelectorAll(".annotation").length;
        if (source !== ${JSON.stringify(revisedSource)} ||
            status !== "Updated after review" ||
            annotations !== 0) return null;
        return { source, status, annotations };
      })()`),
      "Submitted review did not reload after the file changed"
    );
    process.stdout.write(`${JSON.stringify({ ...result, draft: drafts[0], refreshed })}\n`);
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await Promise.race([chromeExited, delay(2_000)]);
    await service.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  }
}

await run();
