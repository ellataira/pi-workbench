import { DatabaseSync } from "node:sqlite";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  normalizeCheckpoint,
  validateCheckpoint,
  validateMemoryPromotion
} from "./schema.mjs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPathUnder(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function chmodIfPresent(targetPath, mode) {
  try {
    await chmod(targetPath, mode);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function yamlList(values) {
  if (!values?.length) return "[]";
  return `[${values.map(quote).join(", ")}]`;
}

function dateParts(timestamp) {
  const date = new Date(timestamp);
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0")
  };
}

function safeFilename(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function checkpointText(value, headingPrefix = "Checkpoint") {
  const lines = [
    `<!-- agent-journal:${value.idempotencyKey} -->`,
    `## ${headingPrefix}: ${value.timestamp}`,
    "",
    `**Kind:** ${value.checkpointKind}`,
    `**Status:** ${value.status || "recorded"}`
  ];
  if (value.summary.goal) lines.push("", `**Goal:** ${value.summary.goal}`);
  if (value.summary.outcomes.length) {
    lines.push("", "**Outcomes:**", ...value.summary.outcomes.map((item) => `- ${item}`));
  }
  if (value.summary.decisions.length) {
    lines.push("", "**Decisions:**", ...value.summary.decisions.map((item) => `- ${item}`));
  }
  if (value.summary.nextSteps.length) {
    lines.push("", "**Next steps:**", ...value.summary.nextSteps.map((item) => `- ${item}`));
  }
  if (value.summary.artifacts.length) {
    lines.push("", "**Artifacts:**", ...value.summary.artifacts.map((item) => `- ${item}`));
  }
  const usage = value.usage;
  if (
    usage.inputTokens ||
    usage.outputTokens ||
    usage.cacheReadTokens ||
    usage.cacheWriteTokens ||
    usage.costUsd ||
    usage.model
  ) {
    lines.push(
      "",
      `**Usage:** model=${usage.model || "unknown"} input=${usage.inputTokens} output=${usage.outputTokens} cache-read=${usage.cacheReadTokens} cache-write=${usage.cacheWriteTokens} cost-usd=${usage.costUsd}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function initialNote(value) {
  const parent = value.parent ? `${value.parent.client}:${value.parent.sessionId}` : "";
  return [
    "---",
    "schema_version: 1",
    "representation: compressed-summary-v1",
    `journal_id: ${quote(value.identity)}`,
    `client: ${quote(value.client)}`,
    `session_id: ${quote(value.sessionId)}`,
    `parent_session: ${quote(parent)}`,
    `started_at: ${quote(value.startedAt)}`,
    `updated_at: ${quote(value.timestamp)}`,
    `cwd: ${quote(value.cwd)}`,
    `repository: ${quote(value.repository)}`,
    `branch: ${quote(value.branch)}`,
    `tags: ${yamlList(value.summary.tags)}`,
    `source_path: ${quote(value.sourcePath)}`,
    "---",
    "",
    `# ${value.title}`,
    "",
    "This note stores structured session summaries only. The original transcript remains in its agent harness.",
    ""
  ].join("\n");
}

function replaceUpdatedAt(text, timestamp) {
  return text.replace(/^updated_at:.*$/m, `updated_at: ${quote(timestamp)}`);
}

function topicsFromFrontmatter(text) {
  const match = String(text).match(/^tags:\s*(\[.*\])\s*$/m);
  if (!match) return [];
  try {
    const value = JSON.parse(match[1]);
    return Array.isArray(value) ? value.map(safeFilename).filter(Boolean).slice(0, 4) : [];
  } catch {
    return [];
  }
}

function frontmatterValue(text, key) {
  const match = String(text).match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].replace(/^["']|["']$/g, "");
  }
}

async function markdownFilesUnder(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
    }
  }
  return files.sort();
}

function mergeTopics(current, previous = []) {
  return [...new Set([...(current ?? []), ...(previous ?? [])].map(safeFilename).filter(Boolean))]
    .slice(0, 4);
}

function replaceTopics(text, topics) {
  const line = `tags: ${yamlList(topics)}`;
  return /^tags:.*$/m.test(text)
    ? text.replace(/^tags:.*$/m, line)
    : text.replace(/^source_path:/m, `${line}\nsource_path:`);
}

function plainText(text) {
  return text
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/<!--.*?-->/g, "")
    .replace(/[*#`[\]()>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryTerms(query) {
  return [...new Set(String(query).toLowerCase().match(/[a-z0-9][a-z0-9._-]+/g) ?? [])].slice(0, 12);
}

function ftsQuery(terms) {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function exactTopicTerms(terms) {
  const values = [...terms];
  for (let index = 0; index < terms.length - 1; index += 1) {
    values.push(`${terms[index]}-${terms[index + 1]}`);
  }
  return new Set(values);
}

export class AgentJournal {
  constructor({ vaultRoot, stateRoot }) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.stateRoot = path.resolve(stateRoot);
    this.sessionsRoot = path.join(this.vaultRoot, "sessions");
    this.memoryRoot = path.join(this.vaultRoot, "memory");
    this.dailyRoot = path.join(this.vaultRoot, "daily");
    this.locksRoot = path.join(this.stateRoot, "locks");
    this.databasePath = path.join(this.stateRoot, "index.sqlite");
    this.maintenancePath = path.join(this.stateRoot, "maintenance.json");
    this.database = undefined;
    this.driveReceiptsSynced = false;
    this.initialization = undefined;
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  async initializeOnce() {
    await Promise.all([
      mkdir(this.sessionsRoot, { recursive: true }),
      mkdir(this.memoryRoot, { recursive: true }),
      mkdir(this.dailyRoot, { recursive: true }),
      mkdir(this.locksRoot, { recursive: true }),
      mkdir(this.stateRoot, { recursive: true })
    ]);
    await Promise.all([
      chmod(this.stateRoot, 0o700),
      chmod(this.locksRoot, 0o700)
    ]);
    if (!this.database) {
      this.database = new DatabaseSync(this.databasePath);
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS journal_documents (
          identity TEXT PRIMARY KEY,
          note_path TEXT NOT NULL,
          client TEXT NOT NULL,
          session_id TEXT NOT NULL,
          repository TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
          identity UNINDEXED,
          content,
          tokenize = 'porter unicode61'
        );
        CREATE TABLE IF NOT EXISTS memory_documents (
          identity TEXT PRIMARY KEY,
          note_path TEXT NOT NULL,
          scope TEXT NOT NULL,
          repository TEXT NOT NULL,
          title TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          identity UNINDEXED,
          content,
          tokenize = 'porter unicode61'
        );
        CREATE TABLE IF NOT EXISTS journal_topics (
          identity TEXT NOT NULL,
          topic TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (identity, topic)
        );
        CREATE INDEX IF NOT EXISTS journal_topics_topic
          ON journal_topics(topic, updated_at);
        CREATE TABLE IF NOT EXISTS memory_topics (
          identity TEXT NOT NULL,
          topic TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (identity, topic)
        );
        CREATE INDEX IF NOT EXISTS memory_topics_topic
          ON memory_topics(topic, updated_at);
      `);
      await Promise.all([
        chmodIfPresent(this.databasePath, 0o600),
        chmodIfPresent(`${this.databasePath}-wal`, 0o600),
        chmodIfPresent(`${this.databasePath}-shm`, 0o600)
      ]);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const journalColumns = new Set(
          this.database
            .prepare("PRAGMA table_info(journal_documents)")
            .all()
            .map((column) => column.name)
        );
        if (!journalColumns.has("drive_file_id")) {
          this.database.exec(
            "ALTER TABLE journal_documents ADD COLUMN drive_file_id TEXT"
          );
        }
        if (!journalColumns.has("drive_note_sha256")) {
          this.database.exec(
            "ALTER TABLE journal_documents ADD COLUMN drive_note_sha256 TEXT"
          );
        }
        if (!journalColumns.has("drive_folder_id")) {
          this.database.exec(
            "ALTER TABLE journal_documents ADD COLUMN drive_folder_id TEXT"
          );
        }
        if (!journalColumns.has("drive_file_name")) {
          this.database.exec(
            "ALTER TABLE journal_documents ADD COLUMN drive_file_name TEXT"
          );
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (!this.driveReceiptsSynced) {
      this.driveReceiptsSynced = true;
      const receiptsRoot = path.join(this.stateRoot, "retention-receipts");
      let entries = [];
      try {
        entries = await readdir(receiptsRoot, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const update = this.database.prepare(`
        UPDATE journal_documents
        SET drive_file_id = ?, drive_note_sha256 = ?,
            drive_folder_id = ?, drive_file_name = ?
        WHERE note_path = ?
      `);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const receipt = JSON.parse(
            await readFile(path.join(receiptsRoot, entry.name), "utf8")
          );
          if (
            receipt.driveFileId &&
            /^[a-f0-9]{64}$/.test(String(receipt.noteSha256)) &&
            isPathUnder(this.sessionsRoot, receipt.notePath)
          ) {
            const updated = update.run(
              String(receipt.driveFileId),
              String(receipt.noteSha256),
              String(receipt.driveFolderId ?? ""),
              String(receipt.driveFileName ?? ""),
              path.resolve(receipt.notePath)
            );
            if (updated.changes === 0 && receipt.search?.identity) {
              const search = receipt.search;
              const identity = String(search.identity);
              const topics = [...new Set(search.topics ?? [])]
                .map(safeFilename)
                .filter(Boolean)
                .slice(0, 4);
              const content = `${String(search.excerpt ?? "").slice(0, 1600)} Topics: ${topics.join(" ")}`.trim();
              const existing = this.lookup(identity);
              if (existing) {
                this.database
                  .prepare(`
                    UPDATE journal_documents
                    SET drive_file_id = ?, drive_note_sha256 = ?,
                        drive_folder_id = ?, drive_file_name = ?
                    WHERE identity = ?
                  `)
                  .run(
                    String(receipt.driveFileId),
                    String(receipt.noteSha256),
                    String(receipt.driveFolderId ?? ""),
                    String(receipt.driveFileName ?? ""),
                    identity
                  );
              } else if (content) {
                const timestamp = Number.isFinite(Date.parse(search.updatedAt))
                  ? new Date(search.updatedAt).toISOString()
                  : String(receipt.verifiedAt);
                this.database.exec("BEGIN IMMEDIATE");
                try {
                  this.database
                    .prepare(`
                      INSERT INTO journal_documents (
                        identity, note_path, client, session_id, repository, cwd,
                        title, updated_at, content, drive_file_id, drive_note_sha256,
                        drive_folder_id, drive_file_name
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `)
                    .run(
                      identity,
                      path.resolve(receipt.notePath),
                      String(search.client ?? ""),
                      String(search.sessionId ?? ""),
                      String(search.repository ?? ""),
                      String(search.cwd ?? ""),
                      String(search.title ?? "Archived session"),
                      timestamp,
                      content,
                      String(receipt.driveFileId),
                      String(receipt.noteSha256),
                      String(receipt.driveFolderId ?? ""),
                      String(receipt.driveFileName ?? "")
                    );
                  this.database
                    .prepare("INSERT INTO journal_fts(identity, content) VALUES (?, ?)")
                    .run(identity, content);
                  const insertTopic = this.database.prepare(
                    "INSERT INTO journal_topics(identity, topic, updated_at) VALUES (?, ?, ?)"
                  );
                  for (const topic of topics) {
                    insertTopic.run(identity, topic, timestamp);
                  }
                  this.database.exec("COMMIT");
                } catch (error) {
                  this.database.exec("ROLLBACK");
                  throw error;
                }
              }
            }
          }
        } catch {
          // A malformed receipt is ignored and can never authorize rehydration.
        }
      }
    }
  }

  notePath(value) {
    const parts = dateParts(value.startedAt);
    const filename = `${parts.year}-${parts.month}-${parts.day}-${safeFilename(value.client)}-${safeFilename(value.sessionId)}.md`;
    return path.join(this.sessionsRoot, parts.year, parts.month, filename);
  }

  async withLock(identity, operation) {
    await this.initialize();
    const lockPath = path.join(this.locksRoot, `${safeFilename(identity)}.lock`);
    let handle;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > 30_000) await rm(lockPath, { force: true });
        } catch {}
        await sleep(10);
      }
    }
    if (!handle) throw new Error(`timed out acquiring journal lock for ${identity}`);
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  lookup(identity) {
    return this.database
      .prepare("SELECT * FROM journal_documents WHERE identity = ?")
      .get(identity);
  }

  async atomicWrite(targetPath, text) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, targetPath);
  }

  async maintenanceState() {
    await this.initialize();
    try {
      const value = JSON.parse(await readFile(this.maintenancePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  async updateMaintenanceState(patch) {
    return this.withLock("maintenance-state", async () => {
      const current = await this.maintenanceState();
      const value = { ...current, ...patch };
      await this.atomicWrite(this.maintenancePath, `${JSON.stringify(value, null, 2)}\n`);
      return value;
    });
  }

  async claimDistillation(date, timestamp = new Date().toISOString()) {
    return this.withLock("maintenance-state", async () => {
      const current = await this.maintenanceState();
      if (
        String(current.completedThrough ?? "") >= date ||
        current.lastPromptedFor === date
      ) {
        return false;
      }
      const value = {
        ...current,
        lastPromptedFor: date,
        lastPromptedAt: timestamp
      };
      await this.atomicWrite(this.maintenancePath, `${JSON.stringify(value, null, 2)}\n`);
      return true;
    });
  }

  async markDistillationPrompted(date, timestamp = new Date().toISOString()) {
    return this.updateMaintenanceState({
      lastPromptedFor: date,
      lastPromptedAt: timestamp
    });
  }

  async markDistillationCompleted(
    date,
    promotedMemoryIds = [],
    timestamp = new Date().toISOString()
  ) {
    return this.updateMaintenanceState({
      completedThrough: date,
      lastDistillationCompletedAt: timestamp,
      lastDistillationPromotedMemoryIds: [...new Set(promotedMemoryIds)].slice(0, 64)
    });
  }

  index(value, notePath, text) {
    const topics = mergeTopics(value.summary.tags, topicsFromFrontmatter(text));
    const content = `${plainText(text)} Topics: ${topics.join(" ")}`.trim();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM journal_fts WHERE identity = ?").run(value.identity);
      this.database.prepare("DELETE FROM journal_topics WHERE identity = ?").run(value.identity);
      this.database
        .prepare(`
          INSERT INTO journal_documents (
            identity, note_path, client, session_id, repository, cwd, title, updated_at, content
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(identity) DO UPDATE SET
            note_path = excluded.note_path,
            client = excluded.client,
            session_id = excluded.session_id,
            repository = excluded.repository,
            cwd = excluded.cwd,
            title = excluded.title,
            updated_at = excluded.updated_at,
            content = excluded.content
        `)
        .run(
          value.identity,
          notePath,
          value.client,
          value.sessionId,
          value.repository,
          value.cwd,
          value.title,
          value.timestamp,
          content
        );
      this.database.prepare("INSERT INTO journal_fts(identity, content) VALUES (?, ?)").run(value.identity, content);
      const insertTopic = this.database.prepare(
        "INSERT INTO journal_topics(identity, topic, updated_at) VALUES (?, ?, ?)"
      );
      for (const topic of topics) insertTopic.run(value.identity, topic, value.timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async appendParentLink(childValue, childPath) {
    if (!childValue.parent) return;
    const parentIdentity = `${childValue.parent.client}:${childValue.parent.sessionId}`;
    await this.withLock(parentIdentity, async () => {
      let row = this.lookup(parentIdentity);
      if (!row) {
        const recovered = normalizeCheckpoint({
          schemaVersion: 1,
          client: childValue.parent.client,
          sessionId: childValue.parent.sessionId,
          checkpointId: `recovered-for-${childValue.sessionId}`,
          checkpointKind: "child-started",
          timestamp: childValue.timestamp,
          startedAt: childValue.startedAt,
          cwd: childValue.cwd,
          repository: childValue.repository,
          branch: childValue.branch,
          title: `Recovered parent ${childValue.parent.sessionId}`,
          summary: { goal: "Maintain linked child sessions.", tags: childValue.summary.tags }
        });
        const recoveredPath = this.notePath(recovered);
        await this.atomicWrite(recoveredPath, initialNote(recovered));
        this.index(recovered, recoveredPath, initialNote(recovered));
        row = this.lookup(parentIdentity);
      }
      let text = await readFile(row.note_path, "utf8");
      const marker = `<!-- agent-journal-child:${childValue.identity} -->`;
      if (text.includes(marker)) return;
      const relative = path.relative(path.dirname(row.note_path), childPath).replaceAll(path.sep, "/");
      text = `${text.trimEnd()}\n\n${marker}\n- Child session: [Linked child session](${relative})\n`;
      await this.atomicWrite(row.note_path, text);
      const parentValue = normalizeCheckpoint({
        schemaVersion: 1,
        client: row.client,
        sessionId: row.session_id,
        checkpointId: `child-link-${childValue.sessionId}`,
        checkpointKind: "child-completed",
        timestamp: childValue.timestamp,
        startedAt: childValue.startedAt,
        cwd: row.cwd,
        repository: row.repository,
        title: row.title,
        summary: { goal: "Maintain child session links.", tags: [] }
      });
      this.index(parentValue, row.note_path, text);
    });
  }

  async ingest(input) {
    const validation = validateCheckpoint(input);
    if (!validation.ok) {
      throw new TypeError(`invalid checkpoint: ${validation.errors.join("; ")}`);
    }
    const source = validation.value;
    await this.initialize();

    let targetIdentity = source.identity;
    let targetPath = this.notePath(source);
    let heading = "Checkpoint";
    if (source.childClass === "lightweight" && source.parent) {
      targetIdentity = `${source.parent.client}:${source.parent.sessionId}`;
      const parentRow = this.lookup(targetIdentity);
      if (parentRow) targetPath = parentRow.note_path;
      heading = "Lightweight child";
    }

    const result = await this.withLock(targetIdentity, async () => {
      let text;
      try {
        text = await readFile(targetPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const noteValue =
          targetIdentity === source.identity
            ? source
            : normalizeCheckpoint({
                ...source,
                client: source.parent.client,
                sessionId: source.parent.sessionId,
                parent: undefined,
                childClass: "none",
                title: `Recovered parent ${source.parent.sessionId}`
              });
        text = initialNote(noteValue);
      }

      const marker = `<!-- agent-journal:${source.idempotencyKey} -->`;
      if (text.includes(marker)) return { status: "duplicate", notePath: targetPath };
      const topics = mergeTopics(source.summary.tags, topicsFromFrontmatter(text));
      text = replaceUpdatedAt(text, source.timestamp);
      text = replaceTopics(text, topics);
      text = `${text.trimEnd()}\n\n${checkpointText(source, heading)}`;
      await this.atomicWrite(targetPath, text);

      const indexValue =
        targetIdentity === source.identity
          ? source
          : normalizeCheckpoint({
              ...source,
              client: source.parent.client,
              sessionId: source.parent.sessionId,
              parent: undefined,
              childClass: "none",
              title: this.lookup(targetIdentity)?.title ?? `Recovered parent ${source.parent.sessionId}`
            });
      indexValue.summary.tags = topics;
      this.index(indexValue, targetPath, text);
      return { status: "appended", notePath: targetPath };
    });

    if (result.status === "appended" && source.childClass === "substantial") {
      await this.appendParentLink(source, result.notePath);
    }
    return result;
  }

  async rebuildIndexFromDisk() {
    await this.initialize();
    let sessionDocuments = 0;
    for (const notePath of await markdownFilesUnder(this.sessionsRoot)) {
      const text = await readFile(notePath, "utf8");
      if (frontmatterValue(text, "representation") !== "compressed-summary-v1") {
        continue;
      }
      const identity = String(frontmatterValue(text, "journal_id") || "");
      const [identityClient = "", identitySessionId = ""] = identity.split(":", 2);
      const client = String(frontmatterValue(text, "client") || identityClient);
      const sessionId = String(
        frontmatterValue(text, "session_id") || identitySessionId
      );
      if (!client || !sessionId) continue;
      const timestamp = String(
        frontmatterValue(text, "updated_at") ||
          frontmatterValue(text, "started_at") ||
          new Date(0).toISOString()
      );
      const title = String(
        text.match(/^#\s+(.+)$/m)?.[1] || `${client} session ${sessionId}`
      );
      const value = normalizeCheckpoint({
        schemaVersion: 1,
        representation: "compressed-summary-v1",
        client,
        sessionId,
        checkpointId: "disk-rebuild",
        checkpointKind: "recovered",
        timestamp,
        startedAt:
          String(frontmatterValue(text, "started_at") || timestamp),
        cwd: String(frontmatterValue(text, "cwd") || ""),
        repository: String(frontmatterValue(text, "repository") || ""),
        branch: String(frontmatterValue(text, "branch") || ""),
        summary: {
          goal: title,
          outcomes: [],
          decisions: [],
          nextSteps: [],
          artifacts: [],
          tags: topicsFromFrontmatter(text)
        },
        sourcePath: String(frontmatterValue(text, "source_path") || "")
      });
      this.index(value, notePath, text);
      sessionDocuments += 1;
    }

    let memoryDocuments = 0;
    for (const notePath of await markdownFilesUnder(this.memoryRoot)) {
      const text = await readFile(notePath, "utf8");
      if (frontmatterValue(text, "representation") !== "compressed-summary-v1") {
        continue;
      }
      const identity = String(frontmatterValue(text, "memory_id") || "");
      if (!identity) continue;
      const title = String(text.match(/^#\s+(.+)$/m)?.[1] || "Compressed memory");
      const scope = frontmatterValue(text, "scope") === "project" ? "project" : "global";
      const repository =
        scope === "project" ? String(frontmatterValue(text, "repository") || "") : "";
      const updatedAt = String(
        frontmatterValue(text, "updated_at") || new Date(0).toISOString()
      );
      const topics = topicsFromFrontmatter(text);
      const content = `${plainText(text)} Topics: ${topics.join(" ")}`.trim();
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("DELETE FROM memory_fts WHERE identity = ?").run(identity);
        this.database.prepare("DELETE FROM memory_topics WHERE identity = ?").run(identity);
        this.database
          .prepare(`
            INSERT INTO memory_documents (
              identity, note_path, scope, repository, title, updated_at, content
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(identity) DO UPDATE SET
              note_path = excluded.note_path,
              scope = excluded.scope,
              repository = excluded.repository,
              title = excluded.title,
              updated_at = excluded.updated_at,
              content = excluded.content
          `)
          .run(identity, notePath, scope, repository, title, updatedAt, content);
        this.database
          .prepare("INSERT INTO memory_fts(identity, content) VALUES (?, ?)")
          .run(identity, content);
        const insert = this.database.prepare(
          "INSERT INTO memory_topics(identity, topic, updated_at) VALUES (?, ?, ?)"
        );
        for (const topic of topics) insert.run(identity, topic, updatedAt);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      memoryDocuments += 1;
    }
    return { sessionDocuments, memoryDocuments };
  }

  async recall(query, options = {}) {
    await this.initialize();
    const terms = queryTerms(query);
    if (terms.length === 0) return { items: [], estimatedTokens: 0 };
    const limit = Math.max(1, Math.min(Number(options.limit ?? 3), 10));
    const candidateLimit = Math.min(limit * 4, 40);
    const promotedClauses = [
      "memory_fts MATCH ?",
      "(m.scope = 'global' OR (m.scope = 'project' AND m.repository = ?))"
    ];
    const promotedRows = this.database
      .prepare(`
        SELECT m.*, bm25(memory_fts) AS rank
        FROM memory_fts
        JOIN memory_documents m ON m.identity = memory_fts.identity
        WHERE ${promotedClauses.join(" AND ")}
        ORDER BY rank, m.updated_at DESC
        LIMIT ?
      `)
      .all(ftsQuery(terms), options.repository ?? "", candidateLimit)
      .map((row) => ({ ...row, kind: "promoted", topics: this.topicsFor("promoted", row.identity) }));

    const clauses = ["journal_fts MATCH ?"];
    const parameters = [ftsQuery(terms)];
    if (options.repository) {
      clauses.push("d.repository = ?");
      parameters.push(options.repository);
    }
    if (options.cwd) {
      clauses.push("d.cwd = ?");
      parameters.push(options.cwd);
    }
    parameters.push(candidateLimit);

    const includeArchive = !options.automatic || Boolean(options.repository || options.cwd);
    const archiveRows = includeArchive
      ? this.database
          .prepare(`
            SELECT d.*, bm25(journal_fts) AS rank
            FROM journal_fts
            JOIN journal_documents d ON d.identity = journal_fts.identity
            WHERE ${clauses.join(" AND ")}
            ORDER BY rank, d.updated_at DESC
            LIMIT ?
          `)
          .all(...parameters)
          .map((row) => ({ ...row, kind: "archive", topics: this.topicsFor("archive", row.identity) }))
      : [];
    const topicTerms = exactTopicTerms(terms);
    const byTopicThenRank = (left, right) => {
      const leftMatch = left.topics.some((topic) => topicTerms.has(topic)) ? 0 : 1;
      const rightMatch = right.topics.some((topic) => topicTerms.has(topic)) ? 0 : 1;
      return leftMatch - rightMatch || left.rank - right.rank ||
        String(right.updated_at).localeCompare(String(left.updated_at));
    };
    promotedRows.sort(byTopicThenRank);
    archiveRows.sort(byTopicThenRank);
    const rows = [];
    const seenTitles = new Set();
    for (const row of [...promotedRows, ...archiveRows]) {
      const titleKey = String(row.title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (titleKey && seenTitles.has(titleKey)) continue;
      if (titleKey) seenTitles.add(titleKey);
      rows.push(row);
      if (rows.length >= limit) break;
    }

    const tokenBudget = Math.max(100, Number(options.tokenBudget ?? 1200));
    let remainingCharacters = tokenBudget * 4;
    const items = [];
    for (const row of rows) {
      if (remainingCharacters < 80) break;
      const excerpt = row.content.slice(0, Math.min(remainingCharacters, 1600)).trim();
      if (!excerpt) continue;
      remainingCharacters -= excerpt.length;
      const item = {
        identity: row.identity,
        kind: row.kind,
        title: row.title,
        repository: row.repository,
        cwd: row.cwd,
        updatedAt: row.updated_at,
        topics: row.topics,
        excerpt,
        provenance: `${row.note_path}#${row.identity}`
      };
      if (
        row.kind === "archive" &&
        row.drive_file_id &&
        /^[a-f0-9]{64}$/.test(String(row.drive_note_sha256)) &&
        !(await exists(row.note_path))
      ) {
        item.rehydration = {
          provider: "google-drive",
          driveFileId: row.drive_file_id,
          driveFolderId: row.drive_folder_id || undefined,
          driveFileName: row.drive_file_name || undefined,
          driveUrl: `https://drive.google.com/open?id=${encodeURIComponent(row.drive_file_id)}`,
          expectedSha256: row.drive_note_sha256
        };
      }
      items.push(item);
    }
    const usedCharacters = tokenBudget * 4 - remainingCharacters;
    return { items, estimatedTokens: Math.ceil(usedCharacters / 4) };
  }

  async recordDriveArchive({
    notePath,
    driveFileId,
    driveFolderId,
    driveFileName,
    noteSha256
  }) {
    await this.initialize();
    const resolvedNotePath = path.resolve(notePath);
    if (!isPathUnder(this.sessionsRoot, resolvedNotePath)) {
      throw new Error("Drive archive note is outside the journal session root");
    }
    if (!String(driveFileId ?? "").trim()) {
      throw new Error("Drive archive file ID is required");
    }
    if (!String(driveFolderId ?? "").trim()) {
      throw new Error("Drive archive folder ID is required");
    }
    if (!String(driveFileName ?? "").trim()) {
      throw new Error("Drive archive filename is required");
    }
    if (!/^[a-f0-9]{64}$/.test(String(noteSha256 ?? ""))) {
      throw new Error("Drive archive SHA-256 is invalid");
    }
    const result = this.database
      .prepare(`
        UPDATE journal_documents
        SET drive_file_id = ?, drive_note_sha256 = ?,
            drive_folder_id = ?, drive_file_name = ?
        WHERE note_path = ?
      `)
      .run(
        String(driveFileId),
        String(noteSha256),
        String(driveFolderId),
        String(driveFileName),
        resolvedNotePath
      );
    if (result.changes !== 1) {
      throw new Error("Drive archive has no matching indexed journal note");
    }
    return {
      notePath: resolvedNotePath,
      driveFileId: String(driveFileId),
      driveFolderId: String(driveFolderId),
      driveFileName: String(driveFileName),
      noteSha256: String(noteSha256)
    };
  }

  async rehydrateDriveArchive(driveFileId, remoteContent) {
    await this.initialize();
    const row = this.database
      .prepare(`
        SELECT note_path, drive_file_id, drive_note_sha256
        FROM journal_documents
        WHERE drive_file_id = ?
      `)
      .get(String(driveFileId ?? ""));
    if (!row || !isPathUnder(this.sessionsRoot, row.note_path)) {
      throw new Error("Drive archive is not registered for rehydration");
    }
    if (sha256(remoteContent) !== row.drive_note_sha256) {
      throw new Error("Drive content does not match the archived compressed summary");
    }
    if (!/^representation:\s*compressed-summary-v1\s*$/m.test(remoteContent)) {
      throw new Error("Drive archive is not a compressed-summary-v1 note");
    }
    await this.atomicWrite(row.note_path, remoteContent);
    return {
      notePath: row.note_path,
      driveFileId: row.drive_file_id,
      noteSha256: row.drive_note_sha256,
      restored: true
    };
  }

  topicsFor(kind, identity) {
    const table = kind === "promoted" ? "memory_topics" : "journal_topics";
    return this.database
      .prepare(`SELECT topic FROM ${table} WHERE identity = ? ORDER BY topic`)
      .all(identity)
      .map((row) => row.topic);
  }

  async distillationCandidates(date) {
    await this.initialize();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new TypeError("distillation date must be YYYY-MM-DD");
    }
    return this.database
      .prepare(`
        SELECT identity, note_path, repository, title, updated_at, content
        FROM journal_documents
        WHERE substr(updated_at, 1, 10) = ?
        ORDER BY repository, updated_at, identity
      `)
      .all(date)
      .map((row) => ({
        identity: row.identity,
        title: row.title,
        repository: row.repository,
        updatedAt: row.updated_at,
        topics: this.topicsFor("archive", row.identity),
        excerpt: row.content.slice(0, 1600),
        provenance: `${row.note_path}#${row.identity}`
      }));
  }

  async reindexTopics() {
    await this.initialize();
    const groups = [
      {
        documents: "journal_documents",
        fts: "journal_fts",
        topics: "journal_topics"
      },
      {
        documents: "memory_documents",
        fts: "memory_fts",
        topics: "memory_topics"
      }
    ];
    const counts = {};
    for (const group of groups) {
      let indexed = 0;
      const rows = this.database
        .prepare(`SELECT identity, note_path, updated_at FROM ${group.documents}`)
        .all();
      for (const row of rows) {
        let text;
        try {
          text = await readFile(row.note_path, "utf8");
        } catch {
          continue;
        }
        const topics = topicsFromFrontmatter(text);
        const content = `${plainText(text)} Topics: ${topics.join(" ")}`.trim();
        this.database.exec("BEGIN IMMEDIATE");
        try {
          this.database.prepare(`DELETE FROM ${group.fts} WHERE identity = ?`).run(row.identity);
          this.database.prepare(`DELETE FROM ${group.topics} WHERE identity = ?`).run(row.identity);
          this.database.prepare(`INSERT INTO ${group.fts}(identity, content) VALUES (?, ?)`)
            .run(row.identity, content);
          const insert = this.database.prepare(
            `INSERT INTO ${group.topics}(identity, topic, updated_at) VALUES (?, ?, ?)`
          );
          for (const topic of topics) insert.run(row.identity, topic, row.updated_at);
          this.database.prepare(`UPDATE ${group.documents} SET content = ? WHERE identity = ?`)
            .run(content, row.identity);
          this.database.exec("COMMIT");
          indexed += 1;
        } catch (error) {
          this.database.exec("ROLLBACK");
          throw error;
        }
      }
      counts[group.documents] = indexed;
    }
    return counts;
  }

  async promote(input) {
    await this.initialize();
    const validation = validateMemoryPromotion(input);
    if (!validation.ok) {
      throw new TypeError(validation.errors.join("; "));
    }
    const { title, content } = validation.value;
    const scope = input.scope === "project" ? "project" : "global";
    const repository = scope === "project" ? String(input.repository ?? "").trim() : "";
    if (scope === "project" && !repository) {
      throw new TypeError("project promotion requires repository");
    }
    const timestamp = input.timestamp ? new Date(input.timestamp).toISOString() : new Date().toISOString();
    const identity = `memory:${safeFilename(input.id ?? randomUUID())}`;
    const directory =
      scope === "global"
        ? path.join(this.memoryRoot, "global")
        : path.join(this.memoryRoot, "projects", safeFilename(repository));
    const notePath = path.join(directory, `${safeFilename(title)}-${identity.slice(-8)}.md`);
    const tags = [...new Set((input.tags ?? []).map(safeFilename).filter(Boolean))].slice(0, 4);
    const text = [
      "---",
      "schema_version: 1",
      "representation: compressed-summary-v1",
      `memory_id: ${quote(identity)}`,
      `scope: ${quote(scope)}`,
      `repository: ${quote(repository)}`,
      `source_identity: ${quote(input.sourceIdentity ?? "")}`,
      `updated_at: ${quote(timestamp)}`,
      `tags: ${yamlList(tags)}`,
      "---",
      "",
      `# ${title}`,
      "",
      content,
      ""
    ].join("\n");
    await this.atomicWrite(notePath, text);
    const searchable = `${plainText(text)} Topics: ${tags.join(" ")}`.trim();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM memory_fts WHERE identity = ?").run(identity);
      this.database.prepare("DELETE FROM memory_topics WHERE identity = ?").run(identity);
      this.database
        .prepare(`
          INSERT INTO memory_documents (
            identity, note_path, scope, repository, title, updated_at, content
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(identity) DO UPDATE SET
            note_path = excluded.note_path,
            scope = excluded.scope,
            repository = excluded.repository,
            title = excluded.title,
            updated_at = excluded.updated_at,
            content = excluded.content
        `)
        .run(identity, notePath, scope, repository, title, timestamp, searchable);
      this.database.prepare("INSERT INTO memory_fts(identity, content) VALUES (?, ?)").run(identity, searchable);
      const insertTopic = this.database.prepare(
        "INSERT INTO memory_topics(identity, topic, updated_at) VALUES (?, ?, ?)"
      );
      for (const topic of tags) insertTopic.run(identity, topic, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { identity, notePath };
  }

  async dailyRollup(date = new Date().toISOString().slice(0, 10)) {
    await this.initialize();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("rollup date must be YYYY-MM-DD");
    const rows = this.database
      .prepare(`
        SELECT identity, note_path, client, title, updated_at
        FROM journal_documents
        WHERE substr(updated_at, 1, 10) = ?
        ORDER BY updated_at, identity
      `)
      .all(date);
    const [year, month] = date.split("-");
    const notePath = path.join(this.dailyRoot, year, month, `${date}.md`);
    const links = rows.map((row) => {
      const relative = path.relative(path.dirname(notePath), row.note_path).replaceAll(path.sep, "/");
      return `- ${row.updated_at} · ${row.client} · [${row.title}](${relative})`;
    });
    const text = [
      "---",
      "schema_version: 1",
      `date: ${quote(date)}`,
      `session_count: ${rows.length}`,
      "---",
      "",
      `# Agent journal · ${date}`,
      "",
      `Session summaries: ${rows.length}`,
      "",
      ...links,
      ""
    ].join("\n");
    await this.atomicWrite(notePath, text);
    return { notePath, count: rows.length };
  }
}
