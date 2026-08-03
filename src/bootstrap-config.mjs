import { lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}
async function pathKind(filePath) {
  try {
    const entry = await lstat(filePath);
    return entry.isSymbolicLink() ? "symlink" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function unique(values) {
  return [...new Set(values)];
}

export function mergePiSettings(current, portable) {
  return {
    ...current,
    ...portable,
    packages: unique([...(current.packages ?? []), ...(portable.packages ?? [])]),
  };
}

function mergeProfiles(current, portable) {
  return {
    ...current,
    ...portable,
    profiles: { ...(current.profiles ?? {}), ...(portable.profiles ?? {}) },
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function installWorkbench({ homeDir, repoRoot, replaceExisting = false }) {
  const resolvedRepo = await realpath(repoRoot);
  const extensionPath = path.join(homeDir, ".agents/extensions/agent-journal");
  await mkdir(path.dirname(extensionPath), { recursive: true });

  let extensionBackup = null;
  const kind = await pathKind(extensionPath);
  if (kind === "symlink") {
    const currentTarget = await realpath(extensionPath);
    if (currentTarget !== resolvedRepo) {
      if (!replaceExisting) {
        throw new Error(`${extensionPath} points elsewhere; rerun with --replace-existing to back it up`);
      }
      extensionBackup = `${extensionPath}.backup-${Date.now()}`;
      await rename(extensionPath, extensionBackup);
      await symlink(resolvedRepo, extensionPath, "dir");
    }
  } else if (kind === "other") {
    if (!replaceExisting) {
      throw new Error(`${extensionPath} already exists; rerun with --replace-existing to back it up`);
    }
    extensionBackup = `${extensionPath}.backup-${Date.now()}`;
    await rename(extensionPath, extensionBackup);
    await symlink(resolvedRepo, extensionPath, "dir");
  } else {
    await symlink(resolvedRepo, extensionPath, "dir");
  }

  const configRoot = path.join(resolvedRepo, "config/pi");
  const piDir = path.join(homeDir, ".pi/agent");
  const settingsPath = path.join(piDir, "settings.json");
  const profilesPath = path.join(piDir, "project-profiles.json");
  const subagentPath = path.join(piDir, "extensions/subagent/config.json");

  const currentSettings = await readJson(settingsPath);
  const portableSettings = await readJson(path.join(configRoot, "settings.json"));
  await writeJson(settingsPath, mergePiSettings(currentSettings, portableSettings));

  const currentProfiles = await readJson(profilesPath);
  const portableProfiles = await readJson(path.join(configRoot, "project-profiles.json"));
  await writeJson(profilesPath, mergeProfiles(currentProfiles, portableProfiles));

  const currentSubagent = await readJson(subagentPath);
  const portableSubagent = await readJson(path.join(configRoot, "subagent-config.json"));
  await writeJson(subagentPath, { ...currentSubagent, ...portableSubagent });

  return { extensionPath, extensionBackup, settingsPath, profilesPath, subagentPath };
}
