import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EXTENSION_NAME = "pi-searxng";
const CONFIG_FILENAME = "config.json";

/**
 * Resolves the pi coding agent directory in a robust way.
 * Prioritizes PI_CODING_AGENT_DIR (if it points to an agent directory),
 * then HOME, and finally homedir() as a last resort.
 */
function resolveAgentDir(): string {
  // PI_CODING_AGENT_DIR is the full agent directory
  const piDir = process.env.PI_CODING_AGENT_DIR;
  if (piDir) {
    // Expand ~ to actual home directory (handles both ~/ and ~\)
    if (piDir.startsWith("~/") || piDir.startsWith("~\\")) {
      return join(homedir(), piDir.slice(2));
    }
    return piDir;
  }
  // Fallback: HOME env var or homedir()
  const hd = homedir();
  if (process.env.HOME) {
    return join(process.env.HOME, ".pi", "agent");
  }
  if (hd) {
    return join(hd, ".pi", "agent");
  }
  return join("/", ".pi", "agent");
}

/**
 * Find the root of the current git repository, if any.
 *
 * `.git` is a directory in a normal clone, but a file in worktrees and
 * submodules, so mere existence is what marks the root.
 */
function findGitRoot(startPath: string): string | null {
  let current = resolve(startPath);
  const root = resolve("/");

  while (current !== root) {
    const gitDir = join(current, ".git");
    if (existsSync(gitDir)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Global config path: `<agent-dir>/extensions/pi-searxng/config.json`. */
function resolveAgentConfigPath(): string {
  return join(resolveAgentDir(), "extensions", EXTENSION_NAME, CONFIG_FILENAME);
}

/** Project-local config path: `<repo-root>/.pi/extensions/pi-searxng/config.json`, if inside a repo. */
function resolveRepoConfigPath(): string | null {
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) return null;
  return join(gitRoot, ".pi", "extensions", EXTENSION_NAME, CONFIG_FILENAME);
}

export interface Config {
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
  cacheFreshnessMs: number;
  cacheTtlMs: number;
  cacheMaxSize: number;
  safesearch: "off" | "moderate" | "strict";
}

export function loadConfig(): Config {
  const defaults: Config = {
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8080",
    timeoutMs: 30000,
    maxResults: 10,
    cacheFreshnessMs: 15 * 60 * 1000, // 15 minutes
    cacheTtlMs: 24 * 60 * 60 * 1000,  // 24 hours
    cacheMaxSize: 200,
    safesearch: "off"
  };

  // Highest priority first: the repo-root (project-local) config, then the
  // agent-dir (global) one. The first file found is the only one read — a
  // project config replaces the global one rather than layering over it.
  const configPaths = [resolveRepoConfigPath(), resolveAgentConfigPath()].filter(
    (path): path is string => path !== null
  );

  let merged: Record<string, unknown> | null = null;

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      merged = { ...defaults, ...(raw as Record<string, unknown>) };
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to parse config file (${configPath}): ${msg}\n` +
        `Skipping this config file.`
      );
    }
  }

  if (!merged) {
    console.info(
      `No config file found (checked ${configPaths.join(", ")}). Using default settings.`
    );
    return defaults;
  }

  const config = merged as unknown as Config;

  try {
    if (typeof config.searxngUrl !== "string") {
      throw new Error("'searxngUrl' must be a string");
    }
    if (typeof config.timeoutMs !== "number" || config.timeoutMs <= 0) {
      throw new Error("'timeoutMs' must be a positive number");
    }
    if (typeof config.maxResults !== "number" || config.maxResults <= 0) {
      throw new Error("'maxResults' must be a positive number");
    }
    if (typeof config.cacheFreshnessMs !== "number" || config.cacheFreshnessMs <= 0) {
      throw new Error("'cacheFreshnessMs' must be a positive number");
    }
    const validSafesearchValues = ["off", "moderate", "strict"];
    if (!validSafesearchValues.includes(config.safesearch)) {
      throw new Error("'safesearch' must be one of: 'off', 'moderate', 'strict'");
    }
    if (typeof config.cacheTtlMs !== "number" || config.cacheTtlMs <= 0) {
      throw new Error("'cacheTtlMs' must be a positive number");
    }
    if (typeof config.cacheMaxSize !== "number" || config.cacheMaxSize <= 0) {
      throw new Error("'cacheMaxSize' must be a positive number");
    }

    return config;
  } catch (err) {
    console.warn(
      `Invalid config values, using defaults: ${err instanceof Error ? err.message : String(err)}`
    );
    return defaults;
  }
}
