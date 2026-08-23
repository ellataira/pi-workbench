import { createServer } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Marked } from "marked";

export const MAX_REVIEW_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_REVIEW_FILE_BYTES;
const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
const MAX_SELECTION_CHARS = 16_000;
const MAX_COMMENT_CHARS = 8_000;
const MAX_RENDER_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_OPEN_CAPABILITIES = 64;
const MAX_REVIEW_WORKSPACES = 8;
const MAX_REVIEW_WORKSPACE_FILES = 100;
const MAX_BATCH_COMMENTS = 50;
const MAX_BATCH_DRAFT_CHARS = 16_000;

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".rmd", ".qmd"]);
const DIFF_EXTENSIONS = new Set([".diff", ".patch"]);
const IMAGE_CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp",
  ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".lua", ".m",
  ".mm", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts",
  ".tsx", ".txt", ".xml", ".yaml", ".yml", ".zig"
]);

export function positionAnchoredOverlay({
  anchor,
  viewport,
  overlay,
  headerBottom = 0,
  gap = 8,
  align = "start",
  preferred = "below"
}) {
  const margin = 12;
  const minTop = Math.max(margin, headerBottom + gap);
  const maxLeft = Math.max(margin, viewport.width - overlay.width - margin);
  const requestedLeft = align === "center"
    ? anchor.left + (anchor.right - anchor.left - overlay.width) / 2
    : anchor.left;
  const left = Math.max(margin, Math.min(requestedLeft, maxLeft));
  const above = anchor.top - gap - overlay.height;
  const below = anchor.bottom + gap;
  const maxTop = Math.max(minTop, viewport.height - overlay.height - margin);
  const preferredTop = preferred === "above" ? above : below;
  const fallbackTop = preferred === "above" ? below : above;
  const preferredFits = preferredTop >= minTop && preferredTop <= maxTop;
  const fallbackFits = fallbackTop >= minTop && fallbackTop <= maxTop;
  const requestedTop = preferredFits
    ? preferredTop
    : fallbackFits
      ? fallbackTop
      : preferredTop;
  const top = Math.max(minTop, Math.min(requestedTop, maxTop));
  return { left, top };
}

export function scrollDeltaToPreserveAnchor(beforeTop, afterTop) {
  if (!Number.isFinite(beforeTop) || !Number.isFinite(afterTop)) return 0;
  return afterTop - beforeTop;
}

export function reviewDiskUpdateAction({
  changed,
  savedContent,
  editorContent,
  submittedContent,
  annotationCount
}) {
  if (!changed) return "none";
  if (
    submittedContent !== null &&
    editorContent === submittedContent
  ) {
    return "reload-submitted";
  }
  if (editorContent === savedContent && annotationCount === 0) {
    return "reload-clean";
  }
  return "conflict";
}

function normalizedSingleLine(value, maxLength) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

function clampSelection(value, maxLength = MAX_SELECTION_CHARS) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n… [selection truncated]`;
}

function normalizedAnnotationComment(value) {
  return normalizedSingleLine(value, MAX_COMMENT_CHARS).replace(/\]/g, ")");
}

export function classifyReviewFile(filePath) {
  const extension = path.extname(String(filePath ?? "")).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (DIFF_EXTENSIONS.has(extension)) return "diff";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

export function insertMarkdownAnnotation(
  source,
  start,
  end,
  comment,
  { allowEmpty = false } = {}
) {
  const content = String(source ?? "");
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > content.length) {
    throw new Error("Invalid Markdown selection");
  }
  const note = normalizedAnnotationComment(comment);
  if (!note && !allowEmpty) throw new Error("Annotation comment is required");
  const marker = ` [an: ${note}]`;
  return {
    content: `${content.slice(0, end)}${marker}${content.slice(end)}`,
    selection: { start, end }
  };
}

export function parseMarkdownAnnotations(source) {
  const content = String(source ?? "");
  const annotations = [];
  const pattern = /([ \t]?)\[an:\s*([^\]\r\n]*)\]/gi;
  let match;
  let scannedUntil = 0;
  let lineNumber = 1;
  while ((match = pattern.exec(content)) !== null) {
    for (let index = scannedUntil; index < match.index; index += 1) {
      if (content[index] === "\n") lineNumber += 1;
    }
    scannedUntil = match.index;
    const lineStart = content.lastIndexOf("\n", match.index - 1) + 1;
    const context = content
      .slice(lineStart, match.index)
      .trim()
      .slice(-1_000);
    annotations.push({
      index: annotations.length,
      start: match.index,
      end: pattern.lastIndex,
      comment: normalizedAnnotationComment(match[2]),
      context,
      lineNumber
    });
  }
  return annotations;
}

export function updateMarkdownAnnotation(source, annotationIndex, comment) {
  const content = String(source ?? "");
  const annotations = parseMarkdownAnnotations(content);
  const annotation = annotations[annotationIndex];
  if (!annotation) throw new Error("Markdown annotation not found");
  const replacement = comment == null
    ? ""
    : ` [an: ${normalizedAnnotationComment(comment)}]`;
  if (comment != null && !normalizedAnnotationComment(comment)) {
    throw new Error("Annotation comment is required");
  }
  const updated = `${content.slice(0, annotation.start)}${replacement}${content.slice(annotation.end)}`;
  return {
    content: updated,
    annotations: parseMarkdownAnnotations(updated)
  };
}

export function decorateAnnotationHtml(html) {
  let index = 0;
  return String(html ?? "").replace(
    /\[an:\s*([^\]]*)\]/gi,
    (_match, comment) => {
      const annotationIndex = index++;
      const safeComment = String(comment)
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<button type="button" class="annotation" data-annotation-index="${annotationIndex}" aria-label="Edit inline comment ${annotationIndex + 1}"><span class="annotation-label">Comment ${annotationIndex + 1}</span><span class="annotation-comment">${safeComment}</span></button>`;
    }
  );
}

export function formatAnnotationBatchDraft({
  sourcePath,
  annotations
}) {
  const usable = Array.isArray(annotations)
    ? annotations.slice(0, MAX_BATCH_COMMENTS)
    : [];
  if (!usable.length) throw new Error("At least one Markdown annotation is required");
  if (usable.some((annotation) => !normalizedAnnotationComment(annotation?.comment))) {
    throw new Error("Finish or remove every unfinished inline comment");
  }
  const lines = [
    `Markdown review batch from ${sourcePath || "review document"} (${usable.length} inline comments):`
  ];
  usable.forEach((annotation, index) => {
    const comment = normalizedAnnotationComment(annotation?.comment);
    if (!comment) return;
    const context = normalizedSingleLine(annotation?.context, 1_000);
    const lineNumber = Number(annotation?.lineNumber);
    const location =
      Number.isInteger(lineNumber) && lineNumber > 0
        ? `Line ${lineNumber}: `
        : "";
    lines.push(`${index + 1}. ${location}${comment}`);
    if (context) lines.push(`   Context: ${context}`);
  });
  return lines.join("\n").slice(0, MAX_BATCH_DRAFT_CHARS);
}

function projectMarkdownText(source) {
  const text = String(source ?? "");
  const projected = [];
  const sourceIndexes = [];
  let lineStart = true;
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    if (text[index] === "\n") {
      projected.push(" ");
      sourceIndexes.push(index);
      index += 1;
      lineStart = true;
      continue;
    }
    if (lineStart) {
      const prefix = rest.match(/^(?: {0,3}#{1,6}[ \t]+| {0,3}>[ \t]?| {0,3}(?:[-+*]|\d+[.)])[ \t]+)/);
      if (prefix) {
        index += prefix[0].length;
        lineStart = false;
        continue;
      }
      lineStart = false;
    }
    if (text[index] === "\\" && index + 1 < text.length) {
      projected.push(text[index + 1]);
      sourceIndexes.push(index + 1);
      index += 2;
      continue;
    }
    const codeDelimiter = rest.match(/^`+/);
    if (codeDelimiter) {
      const delimiter = codeDelimiter[0];
      const close = text.indexOf(delimiter, index + delimiter.length);
      if (close !== -1) {
        for (
          let codeIndex = index + delimiter.length;
          codeIndex < close;
          codeIndex += 1
        ) {
          projected.push(text[codeIndex] === "\n" ? " " : text[codeIndex]);
          sourceIndexes.push(codeIndex);
        }
        index = close + delimiter.length;
        continue;
      }
    }
    const annotation = rest.match(/^\[an:\s*[^\]\r\n]*\]/i);
    if (annotation) {
      index += annotation[0].length;
      continue;
    }
    if (rest.startsWith("![")) {
      index += 2;
      continue;
    }
    if (text[index] === "[") {
      index += 1;
      continue;
    }
    if (rest.startsWith("](")) {
      const close = text.indexOf(")", index + 2);
      index = close === -1 ? index + 2 : close + 1;
      continue;
    }
    const marker = rest.match(/^(?:\*{1,3}|_{1,3}|~{2}|`{1,3})/);
    if (marker) {
      index += marker[0].length;
      continue;
    }
    projected.push(text[index]);
    sourceIndexes.push(index);
    index += 1;
  }
  return { text: projected.join(""), sourceIndexes };
}

function normalizedProjection(projected, sourceIndexes) {
  let text = "";
  const starts = [];
  const ends = [];
  let whitespace = false;
  for (let index = 0; index < projected.length; index += 1) {
    const character = projected[index];
    if (/\s/.test(character)) {
      if (!whitespace && text) {
        text += " ";
        starts.push(sourceIndexes[index]);
        ends.push(sourceIndexes[index] + 1);
      } else if (whitespace && ends.length) {
        ends[ends.length - 1] = sourceIndexes[index] + 1;
      }
      whitespace = true;
      continue;
    }
    whitespace = false;
    text += character;
    starts.push(sourceIndexes[index]);
    ends.push(sourceIndexes[index] + 1);
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

function normalizedSelectionText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function wordTokens(value) {
  const tokens = [];
  const pattern = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;
  let match;
  while ((match = pattern.exec(String(value ?? ""))) !== null) {
    tokens.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return tokens;
}

function selectionContextScore(before, after, prefix, suffix) {
  const normalizedPrefix = normalizedSelectionText(prefix);
  const normalizedSuffix = normalizedSelectionText(suffix);
  let score = 0;
  if (normalizedPrefix && before.trimEnd().endsWith(normalizedPrefix)) {
    score += normalizedPrefix.length;
  }
  if (normalizedSuffix && after.trimStart().startsWith(normalizedSuffix)) {
    score += normalizedSuffix.length;
  }
  return score;
}

function tokenSequenceCandidates(source, normalized, selected, prefix, suffix) {
  const selectedTokens = wordTokens(selected);
  if (selectedTokens.length < 2) return [];
  const projectedTokens = wordTokens(normalized.text);
  const candidates = [];
  for (
    let tokenIndex = 0;
    tokenIndex <= projectedTokens.length - selectedTokens.length;
    tokenIndex += 1
  ) {
    const matches = selectedTokens.every(
      (token, offset) =>
        projectedTokens[tokenIndex + offset].value === token.value
    );
    if (!matches) continue;
    const first = projectedTokens[tokenIndex];
    const last = projectedTokens[tokenIndex + selectedTokens.length - 1];
    candidates.push({
      score: selectionContextScore(
        normalized.text.slice(0, first.start),
        normalized.text.slice(last.end),
        prefix,
        suffix
      ),
      start: normalized.starts[first.start],
      end: advancePastClosingMarkdown(
        String(source),
        normalized.ends[last.end - 1]
      )
    });
  }
  return candidates;
}

function advancePastClosingMarkdown(source, initialEnd) {
  let end = initialEnd;
  let advanced = true;
  while (advanced) {
    advanced = false;
    const closing = source.slice(end).match(/^(?:\*{1,3}|_{1,3}|~{2}|`{1,3})/);
    if (closing) {
      end += closing[0].length;
      advanced = true;
      continue;
    }
    if (source.startsWith("](", end)) {
      const close = source.indexOf(")", end + 2);
      if (close !== -1) {
        end = close + 1;
        advanced = true;
      }
    }
  }
  return end;
}

export function resolveMarkdownSelection(source, {
  text,
  prefix = "",
  suffix = ""
}) {
  const selected = normalizedSelectionText(text);
  if (!selected) throw new Error("Select rendered Markdown text first");
  const projection = projectMarkdownText(source);
  const normalized = normalizedProjection(projection.text, projection.sourceIndexes);
  const candidates = [];
  let cursor = 0;
  while (cursor <= normalized.text.length - selected.length) {
    const found = normalized.text.indexOf(selected, cursor);
    if (found === -1) break;
    const before = normalized.text.slice(0, found);
    const after = normalized.text.slice(found + selected.length);
    candidates.push({
      score: selectionContextScore(before, after, prefix, suffix),
      start: normalized.starts[found],
      end: advancePastClosingMarkdown(
        String(source),
        normalized.ends[found + selected.length - 1]
      )
    });
    cursor = found + 1;
  }
  if (!candidates.length) {
    candidates.push(
      ...tokenSequenceCandidates(
        source,
        normalized,
        selected,
        prefix,
        suffix
      )
    );
  }
  if (!candidates.length) {
    throw new Error("Rendered selection could not be mapped to Markdown source");
  }
  candidates.sort((left, right) => right.score - left.score);
  if (
    candidates.length > 1 &&
    candidates[0].score === candidates[1].score
  ) {
    throw new Error("Rendered selection is ambiguous; select a slightly larger passage");
  }
  return { start: candidates[0].start, end: candidates[0].end };
}

export function createDiffComment(value, {
  id = randomUUID(),
  now = new Date().toISOString()
} = {}) {
  const side = value?.side === "old" ? "old" : "new";
  const startLine = Number(value?.startLine);
  const endLine = Number(value?.endLine);
  const comment = normalizedSingleLine(value?.comment, MAX_COMMENT_CHARS);
  if (!value?.sourcePath || !value?.filePath || !Number.isInteger(startLine) || startLine < 1) {
    throw new Error("Diff comment requires sourcePath, filePath, and a positive line");
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new Error("Diff comment end line must follow its start line");
  }
  if (!comment) throw new Error("Diff comment text is required");
  return {
    id,
    sourcePath: path.resolve(String(value.sourcePath)),
    filePath: String(value.filePath),
    side,
    startLine,
    endLine,
    comment,
    contextHash: createHash("sha256")
      .update(String(value.selectedText ?? ""))
      .digest("hex")
      .slice(0, 16),
    createdAt: new Date(now).toISOString(),
    resolved: false
  };
}

export function updateDiffCommentCollection(comments, {
  id,
  comment,
  remove = false
}) {
  const existing = Array.isArray(comments) ? comments : [];
  const index = existing.findIndex((entry) => entry?.id === id);
  if (index < 0) throw new Error("Diff comment not found");
  if (remove) return existing.filter((_, candidate) => candidate !== index);
  const note = normalizedSingleLine(comment, MAX_COMMENT_CHARS);
  if (!note) throw new Error("Diff comment text is required");
  return existing.map((entry, candidate) =>
    candidate === index ? { ...entry, comment: note } : entry
  );
}

export function formatDiffCommentBatchDraft({
  sourcePath,
  comments
}) {
  const usable = (Array.isArray(comments) ? comments : [])
    .filter((entry) => entry && !entry.resolved)
    .slice(0, MAX_BATCH_COMMENTS);
  if (!usable.length) throw new Error("At least one diff comment is required");
  const plural = usable.length === 1 ? "comment" : "comments";
  const lines = [
    `Diff review batch from ${sourcePath || "review diff"} (${usable.length} inline ${plural}):`
  ];
  usable.forEach((entry, index) => {
    const range = entry.endLine !== entry.startLine
      ? `${entry.startLine}-${entry.endLine}`
      : String(entry.startLine);
    lines.push(
      `${index + 1}. ${entry.filePath}:${range} (${entry.side}): ${normalizedSingleLine(entry.comment, MAX_COMMENT_CHARS)}`
    );
  });
  return lines.join("\n").slice(0, MAX_BATCH_DRAFT_CHARS);
}

export function formatReviewDraft({
  sourcePath,
  selection,
  comment,
  filePath,
  side,
  startLine,
  endLine,
  maxSelectionChars = MAX_SELECTION_CHARS
}) {
  const selected = clampSelection(selection, maxSelectionChars);
  const note = normalizedSingleLine(comment, MAX_COMMENT_CHARS);
  const displayPath = filePath || sourcePath || "review selection";
  const lineSuffix = Number.isInteger(startLine)
    ? `:${startLine}${Number.isInteger(endLine) && endLine !== startLine ? `-${endLine}` : ""}${side ? ` (${side})` : ""}`
    : "";
  const parts = [`Review context from ${displayPath}${lineSuffix}:`];
  if (selected) parts.push(`\n\`\`\`\n${selected}\n\`\`\``);
  if (note) parts.push(`\nComment: ${note}`);
  return parts.join("\n");
}

export function appendReviewDraft(current, addition) {
  const existing = String(current ?? "");
  const next = String(addition ?? "").trim();
  if (!existing.trim()) return next;
  if (!next) return existing;
  return `${existing.replace(/\s+$/u, "")}\n\n${next}`;
}

function pathIsInside(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function selectReviewSession(sessions, { workspaceId = "", filePath = "" } = {}) {
  const usable = sessions.filter((entry) => entry && typeof entry === "object");
  if (workspaceId) {
    const exact = usable
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    if (exact.length) return exact[0];
  }
  const absoluteFile = filePath ? path.resolve(filePath) : "";
  const matching = usable
    .filter((entry) => absoluteFile && entry.cwd && pathIsInside(absoluteFile, path.resolve(entry.cwd)))
    .sort((a, b) => {
      const lengthDelta = path.resolve(b.cwd).length - path.resolve(a.cwd).length;
      return lengthDelta || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    });
  if (matching.length) return matching[0];
  return usable.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0] ?? null;
}

async function resolveReviewPath(filePath, allowedRoots) {
  const resolved = await realpath(path.resolve(filePath));
  const roots = await Promise.all(allowedRoots.map(async (root) => {
    try {
      return await realpath(path.resolve(root));
    } catch {
      return path.resolve(root);
    }
  }));
  if (!roots.some((root) => pathIsInside(resolved, root))) {
    throw new Error("Review path is outside the allowed roots");
  }
  const kind = classifyReviewFile(resolved);
  if (!kind) throw new Error("Unsupported review file type");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Review path must be a regular file");
  if (info.size > MAX_FILE_BYTES) throw new Error("Review file is too large");
  return { path: resolved, kind, info };
}

function sendJson(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(encoded);
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeMarkdownUrl(value, { image = false, assetBase = "" } = {}) {
  const href = String(value ?? "").trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return "";
  if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
  if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(href)) {
    return href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return "";
  if (image && assetBase) {
    return `${assetBase}?path=${encodeURIComponent(href)}`;
  }
  return href;
}

export async function renderMarkdownForReview(markdown, {
  assetBase = ""
} = {}) {
  const renderer = {
    html(token) {
      return escapeHtml(token.text);
    },
    link(token) {
      const href = safeMarkdownUrl(token.href);
      const label = this.parser.parseInline(token.tokens);
      if (!href) return `<span class="unsafe-link">${label}</span>`;
      const title = token.title
        ? ` title="${escapeHtml(token.title)}"`
        : "";
      return `<a href="${escapeHtml(href)}"${title}>${label}</a>`;
    },
    image(token) {
      const href = safeMarkdownUrl(token.href, { image: true, assetBase });
      if (!href) return `<span class="unsafe-link">${escapeHtml(token.text)}</span>`;
      const title = token.title
        ? ` title="${escapeHtml(token.title)}"`
        : "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}"${title}>`;
    }
  };
  const markdownParser = new Marked({
    async: false,
    breaks: false,
    gfm: true,
    renderer
  });
  const rendered = String(markdownParser.parse(String(markdown ?? "")));
  if (Buffer.byteLength(rendered) > MAX_RENDER_BYTES) {
    throw new Error("Rendered Markdown is too large");
  }
  return decorateAnnotationHtml(rendered);
}

async function atomicWrite(filePath, content, mode) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, filePath);
}

async function readComments(commentsPath) {
  try {
    const parsed = JSON.parse(await readFile(commentsPath, "utf8"));
    return parsed?.version === 1 && Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function writeComments(commentsPath, comments) {
  await mkdir(path.dirname(commentsPath), { recursive: true, mode: 0o700 });
  const temporary = `${commentsPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, comments }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, commentsPath);
  await chmod(commentsPath, 0o600);
}

function reviewPageHtml(state, scriptNonce) {
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");
  const positionOverlaySource = positionAnchoredOverlay.toString();
  const preserveAnchorSource = scrollDeltaToPreserveAnchor.toString();
  const diskUpdateActionSource = reviewDiskUpdateAction.toString();
  const navigationGroups = [];
  for (const item of state.navigation ?? []) {
    const group = item.group || "Session files";
    const current = navigationGroups.at(-1);
    if (!current || current.group !== group) navigationGroups.push({ group, items: [item] });
    else current.items.push(item);
  }
  const navigationLinkHtml = (item, group) => {
    const separator = item.label.indexOf(" — ");
    const content = separator >= 0
      ? `<span class="nav-name">${escapeHtml(item.label.slice(0, separator))}</span><small>${escapeHtml(item.label.slice(separator + 3))}</small>`
      : escapeHtml(item.label);
    const classes = [item.current ? "active" : "", group === "Review modes" ? "mode" : ""]
      .filter(Boolean)
      .join(" ");
    return `<a href="${escapeHtml(item.url)}" title="${escapeHtml(item.label)}" class="${classes}">${content}</a>`;
  };
  const navigationHtml = navigationGroups.map(({ group, items }) => {
    const links = items.map((item) => navigationLinkHtml(item, group)).join("");
    if (group.startsWith("Earlier this session")) {
      const opened = items.some((item) => item.current) ? " open" : "";
      return `<details class="nav-group"${opened}><summary>${escapeHtml(group)}</summary>${links}</details>`;
    }
    return `<strong>${escapeHtml(group)}</strong>${links}`;
  }).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi Review · ${escapeHtml(state.displayTitle ?? path.basename(state.sourcePath))}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#202124;--muted:#68707a;--border:#d7dce2;--accent:#6750a4;--annotation-bg:#fff0f7;--annotation-border:#e66aa5;--annotation-text:#8b2454;--add:#e7f7eb;--del:#fdeaea}
@media(prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1d2024;--text:#edf0f4;--muted:#9da6b1;--border:#353b43;--accent:#c7b3ff;--annotation-bg:#3b1d2c;--annotation-border:#f08ab9;--annotation-text:#ffc1dd;--add:#173523;--del:#3b2023}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:5;display:flex;gap:8px;align-items:center;padding:9px 14px;background:color-mix(in srgb,var(--card) 94%,transparent);border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}
.review-identity{margin-right:auto;min-width:0}.review-identity strong,.review-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.review-identity strong{max-width:42vw}.review-identity small{max-width:42vw;color:var(--muted);font-size:11px}
button{border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:6px;padding:6px 10px;cursor:pointer}button.primary{background:var(--accent);color:white;border-color:transparent}button:disabled{opacity:.45}
main{min-width:0;width:100%;max-width:1480px;margin:18px auto;padding:0 clamp(14px,2.5vw,36px)}.comment-box{width:100%;min-height:64px;margin-bottom:12px;padding:9px;border:1px solid var(--border);border-radius:7px;background:var(--card);color:var(--text)}
#annotations{margin-bottom:14px;border:1px solid var(--border);border-radius:8px;background:var(--card);overflow:hidden}#annotations summary{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;font-weight:650;list-style:none}#annotations summary::-webkit-details-marker{display:none}#annotations summary::before{content:"›";color:var(--muted);font-size:18px;transition:transform .15s}#annotations[open] summary::before{transform:rotate(90deg)}#annotation-list{padding:0 12px 10px}.count{padding:1px 7px;border-radius:999px;background:var(--accent);color:white;font-size:11px}.summary-hint{margin-left:auto;color:var(--muted);font-size:12px;font-weight:400}.empty{color:var(--muted);font-size:12px;padding:4px 0}
.annotation-card{display:grid;grid-template-columns:minmax(120px,1fr) minmax(220px,2fr) auto;gap:8px;align-items:start;padding:9px 0;border-top:1px solid var(--border)}.annotation-card:first-child{border-top:0}.annotation-context{color:var(--muted);font-size:12px;overflow-wrap:anywhere}.annotation-edit{width:100%;min-height:54px;padding:7px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);resize:vertical}.annotation-actions{display:flex;gap:5px}
#editor{width:100%;min-height:70vh;resize:vertical;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2}
#preview{padding:34px 42px;border:1px solid var(--border);border-radius:9px;background:var(--card);min-height:70vh;line-height:1.65;overflow-wrap:anywhere}#preview>*:first-child{margin-top:0}#preview>*:last-child{margin-bottom:0}#preview h1,#preview h2,#preview h3{line-height:1.25;margin:1.5em 0 .6em}#preview h1,#preview h2{padding-bottom:.28em;border-bottom:1px solid var(--border)}#preview p,#preview ul,#preview ol,#preview blockquote,#preview table,#preview pre{margin:0 0 1em}#preview ul,#preview ol{padding-left:1.7em}#preview li+li{margin-top:.25em}#preview blockquote{margin-left:0;padding:.15em 1em;border-left:4px solid var(--accent);color:var(--muted);background:color-mix(in srgb,var(--accent) 5%,transparent)}#preview table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse}#preview th,#preview td{padding:7px 10px;border:1px solid var(--border)}#preview th{background:var(--bg);font-weight:650}#preview pre{overflow:auto;padding:13px 15px;border-radius:7px;background:var(--bg)}#preview code{padding:.12em .32em;border-radius:4px;background:var(--bg);font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}#preview pre code{padding:0;background:transparent}#preview img{display:block;max-width:100%;height:auto;margin:1em auto;border-radius:6px}#preview hr{margin:2em 0;border:0;border-top:1px solid var(--border)}#preview input[type=checkbox]{margin-right:.45em;accent-color:var(--accent)}#preview a{color:var(--accent);text-underline-offset:2px}.unsafe-link{color:var(--muted);text-decoration:line-through}.annotation{display:inline-flex;gap:5px;align-items:flex-start;justify-content:flex-start;max-width:min(100%,560px);text-align:left;margin:0 3px;padding:1px 6px;border:0;border-left:3px solid var(--annotation-border);border-radius:3px;background:var(--annotation-bg);color:var(--annotation-text);font:500 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;vertical-align:baseline;user-select:none}.annotation:hover,.annotation:focus{outline:2px solid var(--annotation-border);outline-offset:1px}.annotation-label{flex:0 0 auto;color:var(--annotation-border);font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.04em}.annotation-comment{display:block;min-width:0;white-space:normal;overflow-wrap:anywhere;text-align:left}
#inline-editor{position:fixed;z-index:20;width:min(420px,calc(100vw - 24px));padding:12px;border:1px solid var(--annotation-border);border-radius:9px;background:var(--annotation-bg);box-shadow:0 12px 38px rgb(0 0 0/.24)}#inline-editor strong{display:block;margin-bottom:7px;color:var(--annotation-text)}.inline-editor-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin-top:8px}#inline-comment-edit{width:100%;min-height:76px;padding:8px;border:1px solid var(--annotation-border);border-radius:6px;background:var(--card);color:var(--text);resize:vertical}
#selection-action{position:fixed;z-index:18;padding:6px 10px;border:0;border-radius:999px;background:var(--accent);color:white;box-shadow:0 6px 20px rgb(0 0 0/.22);font-weight:650}
#diff{border:1px solid var(--border);border-radius:8px;overflow:auto;background:var(--card);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.diff-row{display:grid;grid-template-columns:58px 58px 1fr;white-space:pre;min-width:max-content}.diff-row>span{padding:0 8px}.diff-row .ln{color:var(--muted);text-align:right;border-right:1px solid var(--border);user-select:none}.diff-row.add{background:var(--add)}.diff-row.del{background:var(--del)}.diff-row.meta{color:var(--muted);font-weight:600}.diff-row.selected{outline:2px solid var(--annotation-border);outline-offset:-2px}.inline-comment{display:block;width:calc(100% - 146px);text-align:left;padding:6px 10px;margin:4px 10px 8px 126px;border:0;border-left:3px solid var(--annotation-border);border-radius:3px;background:var(--annotation-bg);color:var(--annotation-text);white-space:normal;font:500 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}.inline-comment:hover,.inline-comment:focus{outline:2px solid var(--annotation-border);outline-offset:1px}
.status{color:var(--muted);font-size:12px}.dirty{padding:2px 7px;border-radius:999px;background:var(--bg)}.dirty.unsaved{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}.hidden{display:none!important}
.review-shell{display:grid;grid-template-columns:minmax(250px,310px) minmax(0,1fr);width:100%;align-items:start}.review-sidebar{position:sticky;top:51px;height:calc(100vh - 51px);overflow:auto;padding:14px 10px;border-right:1px solid var(--border);background:var(--card)}.review-sidebar strong{display:block;padding:10px 9px 5px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.review-sidebar strong:first-child{padding-top:3px}.review-sidebar a{display:block;margin:2px 0;padding:8px 9px;border-radius:7px;color:var(--text);text-decoration:none;font-size:12px;overflow-wrap:anywhere}.review-sidebar a.mode{border:1px solid var(--border);margin-bottom:5px}.review-sidebar a .nav-name{display:block;font-weight:650}.review-sidebar a small{display:block;margin-top:2px;color:var(--muted);font-size:10.5px;font-weight:400}.review-sidebar a:hover{background:var(--bg)}.review-sidebar a.active{background:color-mix(in srgb,var(--accent) 14%,var(--card));color:var(--accent);font-weight:650}.review-sidebar a.active small{color:inherit;opacity:.78}.nav-group{margin-top:7px;border-top:1px solid var(--border)}.nav-group summary{padding:10px 9px 6px;color:var(--muted);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}.nav-group summary:hover{color:var(--text)}
@media(max-width:800px){header{flex-wrap:wrap}header .review-identity{flex:1 0 100%}.review-identity strong,.review-identity small{max-width:100%}.review-shell{grid-template-columns:1fr}.review-sidebar{position:sticky;top:91px;z-index:4;display:flex;height:auto;max-height:34vh;gap:5px;overflow:auto;padding:8px;border-right:0;border-bottom:1px solid var(--border)}.review-sidebar strong{position:sticky;left:0;flex:0 0 auto;padding:8px 5px;background:var(--card)}.review-sidebar a{flex:0 0 auto;max-width:240px}.nav-group{flex:0 0 min(280px,80vw);margin-top:0;border-top:0}.nav-group summary{padding:8px 5px}main{padding:0 12px}#preview{padding:22px 18px}.annotation-card{grid-template-columns:1fr}.annotation-actions{justify-content:flex-end}}
</style>
</head>
<body>
<header>
  <span class="review-identity">
    <strong>${escapeHtml(state.displayTitle ?? state.sourcePath)}</strong>
    <small title="${escapeHtml(state.sourcePath)}">${escapeHtml(state.displayScope ?? state.sourcePath)}</small>
  </span>
  <span id="status" class="status">Ready</span>
  <span id="dirty-state" class="status dirty ${state.kind === "markdown" ? "" : "hidden"}">Saved</span>
  <button id="toggle" class="${state.kind === "markdown" ? "" : "hidden"}">Edit source</button>
  <button id="annotate" class="${state.kind === "markdown" ? "" : "hidden"}">Comment selection</button>
  <button id="diff-comment" class="${state.kind === "diff" ? "" : "hidden"}">Comment on lines</button>
  <button id="reload-file" class="hidden">Reload from disk</button>
  <button id="save" class="${state.kind === "markdown" ? "" : "hidden"}">Save</button>
  <button id="send" class="primary">Add to Pi</button>
</header>
<div class="review-shell">
${state.navigation?.length > 1 ? `<nav id="review-sidebar" class="review-sidebar" aria-label="Session review files">${navigationHtml}</nav>` : ""}
<main>
  <textarea id="comment" class="comment-box hidden" placeholder="Optional review comment"></textarea>
  <details id="annotations" class="${state.kind === "markdown" ? "" : "hidden"}" ${state.annotations?.length ? "open" : ""}>
    <summary>Review comments <span id="annotation-count" class="count">0</span><span class="summary-hint">Batch overview</span></summary>
    <div id="annotation-list"></div>
  </details>
  <textarea id="editor" class="${state.kind === "markdown" || state.kind === "diff" ? "hidden" : ""}" ${state.kind === "text" ? "readonly" : ""}></textarea>
  <article id="preview" class="${state.kind === "markdown" ? "" : "hidden"}"></article>
  <button id="selection-action" class="hidden">Comment</button>
  <aside id="inline-editor" class="hidden" aria-label="Edit inline comment">
    <strong>Edit inline comment</strong>
    <textarea id="inline-comment-edit"></textarea>
    <div class="inline-editor-actions">
      <button id="inline-close">Close</button>
      <button id="inline-remove">Remove</button>
      <button id="inline-update">Update</button>
      <button id="inline-update-next" class="primary">Update &amp; add another</button>
    </div>
  </aside>
  <section id="diff" class="${state.kind === "diff" ? "" : "hidden"}"></section>
</main>
</div>
<script nonce="${scriptNonce}">
const state=${stateJson};
const positionAnchoredOverlay=${positionOverlaySource};
const scrollDeltaToPreserveAnchor=${preserveAnchorSource};
const reviewDiskUpdateAction=${diskUpdateActionSource};
const editor=document.getElementById("editor");
const preview=document.getElementById("preview");
const diff=document.getElementById("diff");
const comment=document.getElementById("comment");
const statusEl=document.getElementById("status");
const annotationList=document.getElementById("annotation-list");
const annotationCount=document.getElementById("annotation-count");
const annotationPanel=document.getElementById("annotations");
const reviewSidebar=document.getElementById("review-sidebar");
const sendButton=document.getElementById("send");
const saveButton=document.getElementById("save");
const inlineEditor=document.getElementById("inline-editor");
const inlineCommentEdit=document.getElementById("inline-comment-edit");
const reloadFileButton=document.getElementById("reload-file");
const dirtyState=document.getElementById("dirty-state");
const selectionAction=document.getElementById("selection-action");
let activeInlineAnnotation=-1;
let activeDiffCommentId="";
editor.value=state.content;
let showingPreview=state.kind==="markdown";
let savedContent=state.content;
let selectedRows=[];
let annotations=state.annotations||[];
let annotationRefreshTimer;
let renderedSelection=null;
let actionSelection=null;
let commentMode=false;
let addingAnnotation=false;
let reviewSubmittedContent=null;
let checkingFileState=false;
const setStatus=(text)=>{statusEl.textContent=text;};
function clearRenderedSelection(){
  selectionAction.classList.add("hidden");selectionAction.style.visibility="";renderedSelection=null;actionSelection=null;
}
const requestApi=(action,body)=>fetch("/api/"+state.capability+"/"+action,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
async function recoverCapability(){
  let response;
  for(let attempt=0;attempt<10;attempt+=1){
    try{
      response=await fetch("/recover",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sourcePath:state.sourcePath,recoveryToken:state.recoveryToken,displayTitle:state.displayTitle,displayScope:state.displayScope,workspaceToken:state.workspaceToken,workspaceIndex:state.workspaceIndex})});
      break;
    }catch(error){
      if(attempt===9)throw new Error("Review session changed; run /review once to reopen this file");
      await new Promise((resolve)=>setTimeout(resolve,150));
    }
  }
  if(!response.ok)throw new Error("Review session changed; run /review once to reopen this file");
  const recovered=await response.json();
  state.capability=recovered.capability;
  history.replaceState(null,"","/review/"+state.capability);
}
const api=async(action,body={})=>{
  let response;
  try{response=await requestApi(action,body)}
  catch{await recoverCapability();response=await requestApi(action,body)}
  if(response.status===404){await recoverCapability();response=await requestApi(action,body)}
  if(!response.ok){let detail="";try{detail=(await response.json()).error||""}catch{}const error=new Error(detail||("Request failed: "+response.status));error.status=response.status;throw error}
  if(response.status===204)return null;
  return response.json();
};
function renderWorkspaceNavigation(navigation){
  if(!reviewSidebar||!Array.isArray(navigation))return;
  const signature=navigation.map((item)=>(item.group||"")+"|"+item.label+"|"+item.url+"|"+item.current).join("\\n");
  if(reviewSidebar.dataset.signature===signature)return;
  reviewSidebar.dataset.signature=signature;reviewSidebar.innerHTML="";
  let group="",container=reviewSidebar;for(const item of navigation){const nextGroup=item.group||"Session files";if(nextGroup!==group){group=nextGroup;if(group.startsWith("Earlier this session")){const details=document.createElement("details");details.className="nav-group";details.open=navigation.some((candidate)=>candidate.current&&(candidate.group||"Session files")===group);const summary=document.createElement("summary");summary.textContent=group;details.appendChild(summary);reviewSidebar.appendChild(details);container=details}else{const heading=document.createElement("strong");heading.textContent=group;reviewSidebar.appendChild(heading);container=reviewSidebar}}const link=document.createElement("a");link.href=item.url;link.title=item.label;if(item.current)link.classList.add("active");if(nextGroup==="Review modes")link.classList.add("mode");const separator=item.label.indexOf(" — ");if(separator>=0){const name=document.createElement("span");name.className="nav-name";name.textContent=item.label.slice(0,separator);const detail=document.createElement("small");detail.textContent=item.label.slice(separator+3);link.append(name,detail)}else{link.textContent=item.label}container.appendChild(link)}
}
async function checkWorkspaceNavigation(){
  if(document.hidden||!reviewSidebar)return;
  try{const result=await api("navigation");renderWorkspaceNavigation(result.navigation)}catch{}
}
const refreshPreview=async()=>{
  setStatus("Rendering…");
  clearRenderedSelection();
  const result=await api("render",{content:editor.value});
  preview.innerHTML=result.html;
  wireInlineAnnotations();
  setStatus(annotations.length?annotations.length+" review comment"+(annotations.length===1?"":"s"):"Select rendered text to comment");
};
const setPreview=async(next)=>{
  showingPreview=next;
  if(!next)commentMode=false;
  closeInlineEditor();clearRenderedSelection();
  editor.classList.toggle("hidden",showingPreview);
  preview.classList.toggle("hidden",!showingPreview);
  document.getElementById("toggle").textContent=showingPreview?"Edit source":"Preview";
  if(showingPreview)await refreshPreview();
};
function captureRenderedSelection(){
  if(!showingPreview)return null;
  const selection=window.getSelection();
  if(!selection||selection.rangeCount!==1||selection.isCollapsed){return null}
  const range=selection.getRangeAt(0);
  if(!preview.contains(range.commonAncestorContainer)){return null}
  const text=rangeTextWithoutAnnotations(range).trim();
  if(!text){return null}
  const before=range.cloneRange();before.selectNodeContents(preview);before.setEnd(range.startContainer,range.startOffset);
  const after=range.cloneRange();after.selectNodeContents(preview);after.setStart(range.endContainer,range.endOffset);
  const clientRects=Array.from(range.getClientRects()).filter((rect)=>rect.width>0&&rect.height>0);
  const rect=clientRects[clientRects.length-1]||range.getBoundingClientRect();
  renderedSelection={text,prefix:rangeTextWithoutAnnotations(before).slice(-240),suffix:rangeTextWithoutAnnotations(after).slice(0,240),viewportTop:rect.top};
  selectionAction.style.visibility="hidden";selectionAction.classList.remove("hidden");
  const overlayRect=selectionAction.getBoundingClientRect();
  const headerBottom=document.querySelector("header").getBoundingClientRect().bottom;
  const position=positionAnchoredOverlay({
    anchor:rect,
    viewport:{width:window.innerWidth,height:window.innerHeight},
    overlay:{width:overlayRect.width,height:overlayRect.height},
    headerBottom,
    align:"center",
    preferred:"above"
  });
  selectionAction.style.left=position.left+"px";selectionAction.style.top=position.top+"px";selectionAction.style.visibility="";
  if(commentMode){
    const nextSelection=renderedSelection;commentMode=false;selectionAction.classList.add("hidden");
    setTimeout(()=>addRenderedAnnotation(nextSelection),0);
  }
  return renderedSelection;
}
function rangeTextWithoutAnnotations(range){
  const fragment=range.cloneContents();
  fragment.querySelectorAll(".annotation").forEach((node)=>node.remove());
  return fragment.textContent||"";
}
async function addRenderedAnnotation(selectionOverride){
  if(addingAnnotation)return;
  const selection=selectionOverride||renderedSelection||captureRenderedSelection();
  if(!selection){setStatus("Select text in the rendered document first");return}
  addingAnnotation=true;
  try{
    const result=await api("annotate-selection",{content:editor.value,...selection,comment:""});
    editor.value=result.content;annotations=result.annotations;renderAnnotationTray();await refreshPreview();openInlineEditorAt(result.annotationIndex,selection.viewportTop);setStatus("Write the comment beside the selected passage");
  }catch(error){setStatus(error.message)}
  finally{addingAnnotation=false}
}
preview.addEventListener("mouseup",()=>setTimeout(captureRenderedSelection,0));
preview.addEventListener("pointerup",()=>setTimeout(captureRenderedSelection,0));
preview.addEventListener("keyup",()=>setTimeout(captureRenderedSelection,0));
document.addEventListener("selectionchange",()=>{if(showingPreview&&!actionSelection)setTimeout(captureRenderedSelection,0)});
document.addEventListener("pointerdown",(event)=>{
  const target=event.target;
  if(selectionAction.contains(target)||inlineEditor.contains(target))return;
  clearRenderedSelection();
},{capture:true});
selectionAction.addEventListener("pointerdown",(event)=>{actionSelection=renderedSelection;event.preventDefault()});
selectionAction.addEventListener("mousedown",(event)=>{if(!actionSelection)actionSelection=renderedSelection;event.preventDefault()});
selectionAction.onclick=async()=>{const selection=actionSelection;actionSelection=null;await addRenderedAnnotation(selection)};
function closeInlineEditor(){inlineEditor.classList.add("hidden");activeInlineAnnotation=-1;activeDiffCommentId=""}
function openInlineEditor(index,target){
  const annotation=annotations[index];if(!annotation)return;
  activeInlineAnnotation=index;activeDiffCommentId="";inlineEditor.querySelector("strong").textContent="Edit inline comment";inlineCommentEdit.value=annotation.comment;
  inlineEditor.style.visibility="hidden";inlineEditor.classList.remove("hidden");
  const rect=target.getBoundingClientRect();
  const overlayRect=inlineEditor.getBoundingClientRect();
  const headerBottom=document.querySelector("header").getBoundingClientRect().bottom;
  const position=positionAnchoredOverlay({
    anchor:rect,
    viewport:{width:window.innerWidth,height:window.innerHeight},
    overlay:{width:overlayRect.width,height:overlayRect.height},
    headerBottom,
    preferred:"below"
  });
  inlineEditor.style.left=position.left+"px";inlineEditor.style.top=position.top+"px";inlineEditor.style.visibility="";inlineCommentEdit.focus({preventScroll:true});
}
function openInlineEditorAt(index,preserveViewportTop){
  const target=preview.querySelector('.annotation[data-annotation-index="'+index+'"]');
  if(!target)return;
  const delta=scrollDeltaToPreserveAnchor(preserveViewportTop,target.getBoundingClientRect().top);
  if(Math.abs(delta)>.5)window.scrollBy(0,delta);
  openInlineEditor(index,target);
}
function wireInlineAnnotations(){
  preview.querySelectorAll(".annotation[data-annotation-index]").forEach((node)=>{
    node.addEventListener("click",()=>openInlineEditor(Number(node.dataset.annotationIndex),node));
  });
}
async function mutateInlineAnnotation(index,value,status,{addAnother=false}={}){
  const result=await api("annotation-update",{content:editor.value,index,comment:value});
  editor.value=result.content;annotations=result.annotations;renderAnnotationTray();closeInlineEditor();
  if(showingPreview)await refreshPreview();
  if(addAnother){commentMode=true;setStatus("Comment saved — select another passage")}
  else setStatus(status);
}
function openDiffEditor(commentId,target){
  const existing=commentId?state.comments.find((entry)=>entry.id===commentId):null;
  activeInlineAnnotation=-1;activeDiffCommentId=commentId||"";inlineEditor.querySelector("strong").textContent=existing?"Edit diff comment":"Add diff comment";inlineCommentEdit.value=existing?.comment||"";
  inlineEditor.style.visibility="hidden";inlineEditor.classList.remove("hidden");
  const rect=target.getBoundingClientRect(),overlayRect=inlineEditor.getBoundingClientRect(),headerBottom=document.querySelector("header").getBoundingClientRect().bottom;
  const position=positionAnchoredOverlay({anchor:rect,viewport:{width:window.innerWidth,height:window.innerHeight},overlay:{width:overlayRect.width,height:overlayRect.height},headerBottom,preferred:"below"});
  inlineEditor.style.left=position.left+"px";inlineEditor.style.top=position.top+"px";inlineEditor.style.visibility="";inlineCommentEdit.focus({preventScroll:true});
}
async function saveDiffComment({addAnother=false}={}){
  const note=inlineCommentEdit.value.trim();if(!note){setStatus("Write a comment first");return}
  if(activeDiffCommentId){
    const result=await api("comment-update",{id:activeDiffCommentId,comment:note});state.comments=result.comments;
  }else{
    const rows=selectedRows.map((index)=>diffLines[index]).filter((line)=>line&&line.line>0);
    if(!rows.length){setStatus("Select diff lines first");return}
    const first=rows[0];if(rows.some((row)=>row.filePath!==first.filePath||row.side!==first.side)){setStatus("Select lines from one file and one diff side");return}
    const lineNumbers=rows.map((row)=>row.line);
    const saved=await api("comment",{filePath:first.filePath||state.sourcePath,side:first.side,startLine:Math.min(...lineNumbers),endLine:Math.max(...lineNumbers),comment:note,selectedText:rows.map((row)=>row.text).join("\\n")});
    state.comments.push(saved.comment);
  }
  closeInlineEditor();renderDiff();selectedRows=[];if(addAnother)setStatus("Comment saved — select more diff lines");else setStatus("Diff comment saved");
}
document.getElementById("inline-close").onclick=closeInlineEditor;
document.getElementById("inline-update").onclick=async()=>{
  try{
    if(state.kind==="diff")await saveDiffComment();
    else if(activeInlineAnnotation>=0)await mutateInlineAnnotation(activeInlineAnnotation,inlineCommentEdit.value,"Inline comment updated");
  }catch(error){setStatus(error.message)}
};
document.getElementById("inline-update-next").onclick=async()=>{
  try{
    if(state.kind==="diff")await saveDiffComment({addAnother:true});
    else if(activeInlineAnnotation>=0)await mutateInlineAnnotation(activeInlineAnnotation,inlineCommentEdit.value,"Inline comment updated",{addAnother:true});
  }catch(error){setStatus(error.message)}
};
document.getElementById("inline-remove").onclick=async()=>{
  try{
    if(state.kind==="diff"&&activeDiffCommentId){const result=await api("comment-remove",{id:activeDiffCommentId});state.comments=result.comments;closeInlineEditor();renderDiff();setStatus("Diff comment removed")}
    else if(activeInlineAnnotation>=0)await mutateInlineAnnotation(activeInlineAnnotation,null,"Inline comment removed");
  }catch(error){setStatus(error.message)}
};
inlineCommentEdit.addEventListener("keydown",(event)=>{
  if((event.metaKey||event.ctrlKey)&&event.key==="Enter"){event.preventDefault();document.getElementById("inline-update").click()}
  else if(event.key==="Escape"){event.preventDefault();closeInlineEditor()}
});
document.getElementById("toggle").onclick=async()=>setPreview(!showingPreview);
function renderAnnotationTray(){
  const hasPending=annotations.some((annotation)=>!annotation.comment.trim());
  const dirty=editor.value!==savedContent;
  dirtyState.textContent=dirty?"Unsaved":"Saved";
  dirtyState.classList.toggle("unsaved",dirty);
  annotationCount.textContent=String(annotations.length);
  sendButton.disabled=state.kind==="markdown"&&hasPending;
  saveButton.disabled=state.kind==="markdown"&&(hasPending||!dirty);
  sendButton.textContent=state.kind==="markdown"&&hasPending?"Finish inline comment":state.kind==="markdown"&&annotations.length?(annotations.length===1?"Add comment to Pi":"Add "+annotations.length+" comments to Pi"):"Add to Pi";
  annotationList.innerHTML="";
  if(!annotations.length){
    const empty=document.createElement("div");empty.className="empty";empty.textContent="Select text directly in the rendered document, then choose Comment.";annotationList.appendChild(empty);return;
  }
  annotations.forEach((annotation,index)=>{
    const card=document.createElement("div");card.className="annotation-card";
    const context=document.createElement("div");context.className="annotation-context";context.textContent=annotation.context||"Inline location "+(index+1);
    const input=document.createElement("textarea");input.className="annotation-edit";input.value=annotation.comment;input.placeholder="Write this inline comment…";
    const actions=document.createElement("div");actions.className="annotation-actions";
    const update=document.createElement("button");update.textContent="Update";update.onclick=async()=>{
      try{await mutateInlineAnnotation(index,input.value,"Inline comment updated")}catch(error){setStatus(error.message)}
    };
    const remove=document.createElement("button");remove.textContent="Remove";remove.onclick=async()=>{
      try{await mutateInlineAnnotation(index,null,"Inline comment removed")}catch(error){setStatus(error.message)}
    };
    input.addEventListener("keydown",(event)=>{if((event.metaKey||event.ctrlKey)&&event.key==="Enter"){event.preventDefault();update.click()}});
    const locate=document.createElement("button");locate.textContent="Locate";locate.onclick=async()=>{await setPreview(true);openInlineEditorAt(index)};
    actions.append(locate,update,remove);card.append(context,input,actions);annotationList.appendChild(card);
  });
}
editor.addEventListener("input",()=>{
  dirtyState.textContent="Unsaved";dirtyState.classList.add("unsaved");saveButton.disabled=annotations.some((annotation)=>!annotation.comment.trim());
  clearTimeout(annotationRefreshTimer);
  annotationRefreshTimer=setTimeout(async()=>{
    try{const result=await api("annotations",{content:editor.value});annotations=result.annotations;renderAnnotationTray()}catch{}
  },250);
});
document.getElementById("annotate").onclick=async()=>{
  if(showingPreview){await addRenderedAnnotation();return}
  const start=editor.selectionStart,end=editor.selectionEnd,note=comment.value.trim().slice(0,8000);
  if(start===end){setStatus("Select Markdown text first");editor.focus();return}
  try{
    const result=await api("annotate",{content:editor.value,start,end,comment:note});
    editor.value=result.content;annotations=result.annotations;comment.value="";renderAnnotationTray();await setPreview(true);const annotationIndex=annotations.findIndex((annotation)=>annotation.start===end);openInlineEditorAt(annotationIndex);setStatus("Write the inline comment at the selected passage");
  }catch(error){setStatus(error.message)}
};
document.getElementById("save").onclick=async()=>{
  if(annotations.some((annotation)=>!annotation.comment.trim())){setStatus("Finish or remove every unfinished inline comment before saving");return}
  try{
    setStatus("Saving…");
    const result=await api("save",{content:editor.value,expectedMtimeMs:state.mtimeMs});
    state.mtimeMs=result.mtimeMs;savedContent=editor.value;reviewSubmittedContent=null;renderAnnotationTray();reloadFileButton.classList.add("hidden");setStatus("Saved to disk");
  }catch(error){
    if(error.status===409)reloadFileButton.classList.remove("hidden");
    setStatus("Save failed: "+error.message);
  }
};
async function reloadCurrentFile(statusText){
  const scrollTop=window.scrollY;
  const result=await api("reload");
  state.content=result.content;editor.value=result.content;savedContent=result.content;state.mtimeMs=result.mtimeMs;annotations=result.annotations||[];reviewSubmittedContent=null;reloadFileButton.classList.add("hidden");closeInlineEditor();
  if(state.kind==="markdown"){renderAnnotationTray();if(showingPreview)await refreshPreview()}
  else if(state.kind==="diff"){diffLines=parseDiff(result.content);selectedRows=[];renderDiff()}
  window.scrollTo(0,scrollTop);
  setStatus(statusText);
}
reloadFileButton.onclick=async()=>{
  if(!window.confirm("Discard unsaved review changes and reload the current file from disk?"))return;
  try{
    await reloadCurrentFile("Reloaded current file from disk");
  }catch(error){setStatus("Reload failed: "+error.message)}
};
async function checkFileState(){
  if(document.hidden||checkingFileState)return;
  checkingFileState=true;
  try{
    const result=await api("file-state");
    if(state.kind!=="markdown"){
      if(result.changed)await reloadCurrentFile("Updated from disk");
      return;
    }
    const action=reviewDiskUpdateAction({changed:result.changed,savedContent,editorContent:editor.value,submittedContent:reviewSubmittedContent,annotationCount:annotations.length});
    if(action==="none")return;
    if(action==="reload-submitted"||action==="reload-clean"){
      await reloadCurrentFile(action==="reload-submitted"?"Updated after review":"Updated from disk");
      return;
    }
    reloadFileButton.classList.remove("hidden");
    setStatus("File changed on disk — reload when ready");
  }catch{}
  finally{checkingFileState=false}
}
setInterval(checkFileState,2000);
setInterval(checkWorkspaceNavigation,2000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden){checkFileState();checkWorkspaceNavigation()}});
function parseDiff(source){
  let oldLine=0,newLine=0,filePath="";
  return source.split("\\n").map((text,index)=>{
    let kind="ctx",side="new",line=0,old=0,newer=0;
    if(text.startsWith("+++ ")){filePath=text.slice(4).replace(/^b\\//,"");kind="meta"}
    else if(text.startsWith("--- ")||text.startsWith("diff --git ")||text.startsWith("index ")){kind="meta"}
    else if(text.startsWith("@@")){const m=text.match(/@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);if(m){oldLine=Number(m[1]);newLine=Number(m[2])}kind="meta"}
    else if(text.startsWith("+")){kind="add";side="new";line=newLine;newer=newLine++}
    else if(text.startsWith("-")){kind="del";side="old";line=oldLine;old=oldLine++}
    else {old=oldLine++;newer=newLine++;line=newer;side="new"}
    return {index,text,kind,side,line,old,new:newer,filePath};
  });
}
let diffLines=state.kind==="diff"?parseDiff(state.content):[];
function renderDiff(){
  diff.innerHTML="";
  diffLines.forEach((line)=>{
    const row=document.createElement("div");row.className="diff-row "+line.kind;row.dataset.index=String(line.index);
    row.innerHTML='<span class="ln">'+(line.old||"")+'</span><span class="ln">'+(line.new||"")+'</span><span></span>';
    row.lastElementChild.textContent=line.text;row.onclick=(event)=>selectDiffRow(line.index,event.shiftKey);diff.appendChild(row);
    state.comments.filter((entry)=>entry.filePath===line.filePath&&entry.side===line.side&&entry.endLine===line.line).forEach((entry)=>{
      const note=document.createElement("button");note.type="button";note.className="inline-comment";note.textContent=entry.comment;note.onclick=()=>openDiffEditor(entry.id,note);diff.appendChild(note);
    });
  });
  sendButton.textContent=state.comments.length?(state.comments.length===1?"Add comment to Pi":"Add "+state.comments.length+" comments to Pi"):"Add to Pi";
  sendButton.disabled=!state.comments.length;
}
function selectDiffRow(index,extend){
  if(!extend||!selectedRows.length)selectedRows=[index];
  else{const start=Math.min(selectedRows[0],index),end=Math.max(selectedRows[0],index);selectedRows=[];for(let i=start;i<=end;i++)selectedRows.push(i)}
  document.querySelectorAll(".diff-row").forEach((row)=>row.classList.toggle("selected",selectedRows.includes(Number(row.dataset.index))));
  const target=document.querySelector('.diff-row[data-index="'+index+'"]');if(target)setTimeout(()=>openDiffEditor("",target),0);
}
if(state.kind==="diff")renderDiff();
if(state.kind==="markdown"){renderAnnotationTray();setPreview(true).catch((error)=>setStatus(error.message))}
document.getElementById("diff-comment").onclick=async()=>{
  const target=document.querySelector('.diff-row[data-index="'+selectedRows[selectedRows.length-1]+'"]');if(!target){setStatus("Select diff lines first");return}openDiffEditor("",target);
};
document.getElementById("send").onclick=async()=>{
  if(state.kind==="markdown"&&annotations.some((annotation)=>!annotation.comment.trim())){setStatus("Finish or remove every unfinished inline comment first");return}
  if(state.kind==="markdown"&&annotations.length){
    try{await api("draft-batch",{content:editor.value});reviewSubmittedContent=editor.value;setStatus("Waiting for file changes")}catch(error){setStatus(error.message)}return;
  }
  if(state.kind==="diff"){
    if(!state.comments.length){setStatus("Add at least one inline diff comment first");return}
    try{await api("draft-comments");setStatus("Added "+state.comments.length+" diff comment"+(state.comments.length===1?"":"s")+" to Pi")}catch(error){setStatus(error.message)}return;
  }
  let selection="",location={};
  if(state.kind==="diff"){
    const rows=selectedRows.map((index)=>diffLines[index]).filter(Boolean);selection=rows.map((row)=>row.text).join("\\n");
    if(rows.length)location={filePath:rows[0].filePath,side:rows[0].side,startLine:rows[0].line,endLine:rows[rows.length-1].line};
  }else selection=editor.value.slice(editor.selectionStart,editor.selectionEnd);
  if(!selection&&window.getSelection)selection=String(window.getSelection());
  if(!selection&&!comment.value.trim()){setStatus("Select text or write a comment first");return}
  await api("draft",{selection,comment:comment.value,...location});setStatus("Added to Pi draft");
};
document.addEventListener("keydown",(event)=>{
  if(state.kind!=="markdown")return;
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){event.preventDefault();if(!saveButton.disabled)saveButton.click()}
  else if(event.key==="Escape"){commentMode=false;clearRenderedSelection()}
});
</script>
</body>
</html>`;
}

export async function createReviewServer({
  allowedRoots,
  commentsPath,
  onAppendDraft,
  onOpen,
  renderMarkdown = renderMarkdownForReview,
  port = 0,
  recoverySecret = randomBytes(32).toString("hex")
}) {
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) {
    throw new Error("Review server requires at least one allowed root");
  }
  if (typeof onAppendDraft !== "function") {
    throw new Error("Review server requires an onAppendDraft callback");
  }
  if (!commentsPath) {
    throw new Error("Review server requires a comments path");
  }
  const capabilities = new Map();
  const workspaces = new Map();
  const bridgeToken = randomBytes(32).toString("hex");
  let commentMutation = Promise.resolve();

  function recoveryTokenFor(sourcePath) {
    return createHmac("sha256", recoverySecret)
      .update(path.resolve(sourcePath))
      .digest("hex");
  }

  function validRecoveryToken(sourcePath, value) {
    if (!/^[a-f0-9]{64}$/.test(String(value ?? ""))) return false;
    const actual = Buffer.from(String(value), "hex");
    const expected = Buffer.from(recoveryTokenFor(sourcePath), "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async function mutateComments(mutator) {
    let updated;
    const mutation = commentMutation.then(async () => {
      updated = mutator(await readComments(commentsPath));
      await writeComments(commentsPath, updated);
    });
    commentMutation = mutation.catch(() => {});
    await mutation;
    return updated;
  }

  async function openFile(filePath, display = {}) {
    const resolved = await resolveReviewPath(filePath, allowedRoots);
    const content = await readFile(resolved.path, "utf8");
    const capability = randomBytes(24).toString("hex");
    const comments = resolved.kind === "diff"
      ? (await readComments(commentsPath)).filter((entry) => entry.sourcePath === resolved.path && !entry.resolved)
      : [];
    if (capabilities.size >= MAX_OPEN_CAPABILITIES) {
      capabilities.delete(capabilities.keys().next().value);
    }
    capabilities.set(capability, {
      sourcePath: resolved.path,
      displayTitle: display.title,
      displayScope: display.scope,
      kind: resolved.kind,
      content,
      mtimeMs: resolved.info.mtimeMs,
      mode: resolved.info.mode & 0o777,
      comments,
      annotations: resolved.kind === "markdown"
        ? parseMarkdownAnnotations(content)
        : [],
      recoveryToken: recoveryTokenFor(resolved.path)
    });
    return {
      capability,
      url: `${baseUrl}/review/${capability}`,
      sourcePath: resolved.path
    };
  }

  function workspaceNavigation(token, index) {
    const items = workspaces.get(token) ?? [];
    return items.map((candidate, candidateIndex) => ({
      label: candidate.label,
      group: candidate.group,
      url: `${baseUrl}/workspace/${token}/${candidateIndex}`,
      current: candidateIndex === index
    }));
  }

  async function openWorkspaceItem(token, index) {
    const items = workspaces.get(token);
    if (!items || !Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new Error("Review workspace item is unavailable");
    }
    const item = items[index];
    const opened = await openFile(item.filePath, item.display);
    const state = capabilities.get(opened.capability);
    state.workspaceToken = token;
    state.workspaceIndex = index;
    state.navigation = workspaceNavigation(token, index);
    return { ...opened, count: items.length };
  }

  async function setWorkspace(filePaths, { workspaceKey = "" } = {}) {
    const seen = new Set();
    const items = [];
    for (const value of filePaths) {
      const requestedPath = path.resolve(typeof value === "string" ? value : value.filePath);
      const filePath = (await resolveReviewPath(requestedPath, allowedRoots)).path;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const display = typeof value === "string" ? {} : (value.display ?? {});
      items.push({
        filePath,
        display,
        group: typeof value === "string" ? "" : (value.group || ""),
        label: typeof value === "string"
          ? path.basename(filePath)
          : (value.label || display.title || path.basename(filePath))
      });
      if (items.length >= MAX_REVIEW_WORKSPACE_FILES) break;
    }
    if (!items.length) throw new Error("Review set requires at least one file");
    let token = workspaceKey
      ? createHmac("sha256", recoverySecret)
        .update(`workspace:${workspaceKey}`)
        .digest("hex")
        .slice(0, 36)
      : "";
    if (!token) {
      if (workspaces.size >= MAX_REVIEW_WORKSPACES) {
        const oldest = workspaces.keys().next().value;
        workspaces.delete(oldest);
      }
      token = randomBytes(18).toString("hex");
    }
    workspaces.set(token, items);
    return { token, count: items.length };
  }

  async function openFiles(filePaths, options = {}) {
    const { token } = await setWorkspace(filePaths, options);
    return openWorkspaceItem(token, 0);
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", baseUrl);
      const pageMatch = url.pathname.match(/^\/review\/([a-f0-9]+)$/);
      const workspaceMatch = url.pathname.match(/^\/workspace\/([a-f0-9]+)\/(\d+)$/);
      const assetMatch = url.pathname.match(/^\/asset\/([a-f0-9]+)$/);
      const apiMatch = url.pathname.match(/^\/api\/([a-f0-9]+)\/([a-z-]+)$/);

      if (request.method === "GET" && pageMatch) {
        const capability = pageMatch[1];
        const entry = capabilities.get(capability);
        if (!entry) return sendJson(response, 404, { error: "Review capability not found" });
        const scriptNonce = randomBytes(18).toString("base64url");
        const html = reviewPageHtml({ ...entry, capability }, scriptNonce);
        const encoded = Buffer.from(html);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": encoded.length,
          "cache-control": "no-store",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        });
        response.end(encoded);
        return;
      }

      if (request.method === "GET" && workspaceMatch) {
        const opened = await openWorkspaceItem(
          workspaceMatch[1],
          Number.parseInt(workspaceMatch[2], 10)
        );
        response.writeHead(302, {
          location: opened.url,
          "cache-control": "no-store"
        });
        response.end();
        return;
      }

      if (request.method === "GET" && assetMatch) {
        const entry = capabilities.get(assetMatch[1]);
        if (!entry) return sendJson(response, 404, { error: "Review capability not found" });
        const requested = url.searchParams.get("path") ?? "";
        if (!requested || path.isAbsolute(requested)) {
          return sendJson(response, 400, { error: "Invalid Markdown asset path" });
        }
        const sourceDirectory = await realpath(path.dirname(entry.sourcePath));
        const assetPath = await realpath(path.resolve(sourceDirectory, requested));
        if (!pathIsInside(assetPath, sourceDirectory)) {
          return sendJson(response, 403, { error: "Markdown asset is outside the document directory" });
        }
        const contentType = IMAGE_CONTENT_TYPES.get(path.extname(assetPath).toLowerCase());
        if (!contentType) return sendJson(response, 415, { error: "Unsupported Markdown asset type" });
        const info = await stat(assetPath);
        if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
          return sendJson(response, 413, { error: "Markdown asset is unavailable or too large" });
        }
        const content = await readFile(assetPath);
        response.writeHead(200, {
          "content-type": contentType,
          "content-length": content.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        response.end(content);
        return;
      }

      if (request.method === "POST" && url.pathname === "/open") {
        if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
          return sendJson(response, 401, { error: "Unauthorized" });
        }
        const body = await readJsonBody(request);
        const opened = await openFile(body.path);
        await onOpen?.(opened.url);
        return sendJson(response, 200, opened);
      }

      if (request.method === "POST" && url.pathname === "/recover") {
        const body = await readJsonBody(request);
        const sourcePath = path.resolve(String(body.sourcePath ?? ""));
        if (!validRecoveryToken(sourcePath, body.recoveryToken)) {
          return sendJson(response, 401, { error: "Invalid review recovery token" });
        }
        const opened = await openFile(sourcePath, {
          title: body.displayTitle,
          scope: body.displayScope
        });
        const entry = capabilities.get(opened.capability);
        const workspaceToken = String(body.workspaceToken ?? "");
        const workspaceItems = /^[a-f0-9]{36}$/.test(workspaceToken)
          ? workspaces.get(workspaceToken)
          : undefined;
        const workspaceIndex = workspaceItems?.findIndex(
          (item) => item.filePath === sourcePath
        ) ?? -1;
        if (workspaceIndex >= 0) {
          entry.workspaceToken = workspaceToken;
          entry.workspaceIndex = workspaceIndex;
          entry.navigation = workspaceNavigation(workspaceToken, workspaceIndex);
        }
        return sendJson(response, 200, {
          capability: opened.capability,
          mtimeMs: entry.mtimeMs
        });
      }

      if (request.method === "POST" && apiMatch) {
        const [, capability, action] = apiMatch;
        const entry = capabilities.get(capability);
        if (!entry) return sendJson(response, 404, { error: "Review capability not found" });
        const body = await readJsonBody(request);

        if (action === "annotate") {
          if (entry.kind !== "markdown") return sendJson(response, 400, { error: "Only Markdown accepts inline annotations" });
          const content = String(body.content ?? "");
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) return sendJson(response, 413, { error: "Markdown is too large" });
          const updated = insertMarkdownAnnotation(
            content,
            Number(body.start),
            Number(body.end),
            body.comment,
            { allowEmpty: true }
          );
          return sendJson(response, 200, {
            content: updated.content,
            annotations: parseMarkdownAnnotations(updated.content)
          });
        }

        if (action === "navigation") {
          if (!entry.workspaceToken) {
            return sendJson(response, 200, { navigation: entry.navigation ?? [] });
          }
          entry.navigation = workspaceNavigation(
            entry.workspaceToken,
            entry.workspaceIndex
          );
          return sendJson(response, 200, { navigation: entry.navigation });
        }

        if (action === "annotate-selection") {
          if (entry.kind !== "markdown") return sendJson(response, 400, { error: "Only Markdown accepts inline annotations" });
          const content = String(body.content ?? "");
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) return sendJson(response, 413, { error: "Markdown is too large" });
          try {
            const selection = resolveMarkdownSelection(content, {
              text: body.text,
              prefix: body.prefix,
              suffix: body.suffix
            });
            const updated = insertMarkdownAnnotation(
              content,
              selection.start,
              selection.end,
              body.comment,
              { allowEmpty: true }
            );
            const annotations = parseMarkdownAnnotations(updated.content);
            const annotationIndex = annotations.findIndex(
              (annotation) => annotation.start === selection.end
            );
            return sendJson(response, 200, {
              content: updated.content,
              annotations,
              annotationIndex,
              selection
            });
          } catch (error) {
            return sendJson(response, 400, { error: String(error?.message ?? error) });
          }
        }

        if (action === "annotation-update") {
          if (entry.kind !== "markdown") return sendJson(response, 400, { error: "Only Markdown accepts inline annotations" });
          const content = String(body.content ?? "");
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) return sendJson(response, 413, { error: "Markdown is too large" });
          const updated = updateMarkdownAnnotation(
            content,
            Number(body.index),
            body.comment == null ? null : body.comment
          );
          return sendJson(response, 200, updated);
        }

        if (action === "annotations") {
          if (entry.kind !== "markdown") return sendJson(response, 400, { error: "Only Markdown has inline annotations" });
          const content = String(body.content ?? "");
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) return sendJson(response, 413, { error: "Markdown is too large" });
          return sendJson(response, 200, {
            annotations: parseMarkdownAnnotations(content)
          });
        }

        if (action === "file-state") {
          const current = await stat(entry.sourcePath);
          return sendJson(response, 200, {
            changed: current.mtimeMs !== entry.mtimeMs,
            mtimeMs: current.mtimeMs
          });
        }

        if (action === "reload") {
          const current = await stat(entry.sourcePath);
          if (!current.isFile() || current.size > MAX_FILE_BYTES) {
            return sendJson(response, 413, { error: "Review file is unavailable or too large" });
          }
          const content = await readFile(entry.sourcePath, "utf8");
          entry.content = content;
          entry.mtimeMs = current.mtimeMs;
          entry.mode = current.mode & 0o777;
          entry.annotations = entry.kind === "markdown"
            ? parseMarkdownAnnotations(content)
            : [];
          return sendJson(response, 200, {
            content,
            mtimeMs: entry.mtimeMs,
            annotations: entry.annotations
          });
        }

        if (action === "render") {
          if (entry.kind !== "markdown") return sendJson(response, 400, { error: "Only Markdown can be rendered" });
          const content = String(body.content ?? "");
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) return sendJson(response, 413, { error: "Markdown is too large" });
          return sendJson(response, 200, {
            html: await renderMarkdown(content, {
              assetBase: `/asset/${capability}`
            })
          });
        }

        if (action === "save") {
          if (entry.kind !== "markdown") return sendJson(response, 403, { error: "Only Markdown files are editable" });
          const current = await stat(entry.sourcePath);
          if (Number(body.expectedMtimeMs) !== entry.mtimeMs || current.mtimeMs !== entry.mtimeMs) {
            return sendJson(response, 409, { error: "File changed on disk; reopen before saving" });
          }
          const content = String(body.content ?? "");
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) return sendJson(response, 413, { error: "Markdown is too large" });
          if (parseMarkdownAnnotations(content).some((annotation) => !annotation.comment)) {
            return sendJson(response, 400, { error: "Finish or remove every unfinished inline comment before saving" });
          }
          await atomicWrite(entry.sourcePath, content, entry.mode);
          const updated = await stat(entry.sourcePath);
          entry.content = content;
          entry.mtimeMs = updated.mtimeMs;
          return sendJson(response, 200, { mtimeMs: entry.mtimeMs });
        }

        if (action === "draft") {
          const addition = formatReviewDraft({
            sourcePath: entry.sourcePath,
            selection: body.selection,
            comment: body.comment,
            filePath: body.filePath,
            side: body.side,
            startLine: Number.isInteger(body.startLine) ? body.startLine : undefined,
            endLine: Number.isInteger(body.endLine) ? body.endLine : undefined
          });
          await onAppendDraft(addition);
          return sendEmpty(response);
        }

        if (action === "draft-batch") {
          if (entry.kind !== "markdown") return sendJson(response, 400, { error: "Only Markdown accepts annotation batches" });
          const addition = formatAnnotationBatchDraft({
            sourcePath: entry.sourcePath,
            annotations: body.content == null
              ? body.annotations
              : parseMarkdownAnnotations(String(body.content))
          });
          await onAppendDraft(addition);
          return sendEmpty(response);
        }

        if (action === "draft-comments") {
          if (entry.kind !== "diff") return sendJson(response, 400, { error: "Only diffs accept comment batches" });
          const addition = formatDiffCommentBatchDraft({
            sourcePath: entry.sourcePath,
            comments: entry.comments
          });
          await onAppendDraft(addition);
          return sendEmpty(response);
        }

        if (action === "comment") {
          if (entry.kind !== "diff") return sendJson(response, 400, { error: "Only diffs accept anchored comments" });
          const comment = createDiffComment({
            ...body,
            sourcePath: entry.sourcePath
          });
          await mutateComments((comments) => [...comments, comment]);
          entry.comments.push(comment);
          return sendJson(response, 200, { comment });
        }

        if (action === "comment-update" || action === "comment-remove") {
          if (entry.kind !== "diff") return sendJson(response, 400, { error: "Only diffs accept anchored comments" });
          const updated = await mutateComments((comments) =>
            updateDiffCommentCollection(comments, {
              id: body.id,
              comment: body.comment,
              remove: action === "comment-remove"
            })
          );
          entry.comments = updated.filter(
            (comment) => comment.sourcePath === entry.sourcePath && !comment.resolved
          );
          return sendJson(response, 200, { comments: entry.comments });
        }

        return sendJson(response, 404, { error: "Unknown review action" });
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      sendJson(response, status, { error: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    bridgeToken,
    recoveryState: {
      port: address.port,
      secret: recoverySecret
    },
    openFile,
    openFiles,
    setWorkspace,
    close: () => new Promise((resolve) => {
      capabilities.clear();
      server.close(() => resolve());
    })
  };
}
