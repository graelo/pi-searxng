import { loadConfig as loadConfigFile, type ConfigLocationOptions } from "@graelo/pi-ext-config";

export interface Config {
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
  cacheFreshnessMs: number;
  cacheTtlMs: number;
  cacheMaxSize: number;
  safesearch: "off" | "moderate" | "strict";
}

const DEFAULTS: Config = {
  searxngUrl: process.env.SEARXNG_URL || "http://localhost:8080",
  timeoutMs: 30000,
  maxResults: 10,
  cacheFreshnessMs: 15 * 60 * 1000, // 15 minutes
  cacheTtlMs: 24 * 60 * 60 * 1000,  // 24 hours
  cacheMaxSize: 200,
  safesearch: "off"
};

export interface LoadedConfig {
  config: Config;
  /**
   * Config problems worth surfacing to the user: a file that existed but couldn't be
   * used, or values that failed validation. Reporting is the caller's call — only it
   * knows whether that means `console.warn` or a UI notification.
   */
  diagnostics: string[];
  /**
   * Ordinary facts about where config came from. Running with no config file at all is
   * the normal case for this extension, so it belongs here rather than in
   * {@link diagnostics} — warning about it on every start would be noise.
   */
  notices: string[];
}

function validate(config: Config): void {
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
}

/**
 * Load `config.json` from the project tier, or else the global one.
 *
 * `first-match` because this config is flat and its keys travel together: a project
 * file is a deliberate, complete statement, and there's never any doubt which file
 * is in effect.
 */
export function loadConfig(options?: ConfigLocationOptions): LoadedConfig {
  const { config, sources, candidates, diagnostics } = loadConfigFile<Config>(
    "pi-searxng",
    DEFAULTS,
    { ...options, strategy: "first-match" }
  );

  const notices: string[] = [];

  if (sources.length === 0) {
    notices.push(
      `No config file found (checked ${candidates.join(", ")}). Using default settings.`
    );
  }

  try {
    validate(config);
    return { config, diagnostics, notices };
  } catch (err) {
    diagnostics.push(
      `Invalid config values, using defaults: ${err instanceof Error ? err.message : String(err)}`
    );
    // A fresh copy: `DEFAULTS` is module-level, and handing it out by reference would let
    // one caller's mutation leak into every later load.
    return { config: { ...DEFAULTS }, diagnostics, notices };
  }
}
