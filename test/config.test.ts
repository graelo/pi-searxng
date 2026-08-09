import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loadConfigForSession } from "../src/config.js";

const extensionId = "pi-searxng";

async function writeConfig(path: string, maxResults: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ maxResults }));
}

async function createConfigFixture(): Promise<{
  root: string;
  cwd: string;
  agentDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-searxng-config-"));
  const cwd = join(root, "nested", "directory");
  const agentDir = join(root, "agent");

  await Promise.all([
    mkdir(join(root, ".git")),
    mkdir(cwd, { recursive: true }),
    writeConfig(
      join(root, ".pi", "extensions", extensionId, "config.json"),
      3,
    ),
    writeConfig(
      join(agentDir, "extensions", extensionId, "config.json"),
      20,
    ),
  ]);

  return { root, cwd, agentDir };
}

test("a trusted project session uses the project configuration", async () => {
  const fixture = await createConfigFixture();
  try {
    const loaded = loadConfigForSession(
      { cwd: fixture.cwd, isProjectTrusted: () => true },
      { agentDir: fixture.agentDir },
    );

    assert.equal(loaded.config.maxResults, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test(
  "an untrusted project session ignores project configuration but uses global configuration",
  async () => {
    const fixture = await createConfigFixture();
    try {
      const loaded = loadConfigForSession(
        { cwd: fixture.cwd, isProjectTrusted: () => false },
        { agentDir: fixture.agentDir },
      );

      assert.equal(loaded.config.maxResults, 20);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test("config without a trust decision does not consider the project tier", async () => {
  const fixture = await createConfigFixture();
  try {
    const loaded = loadConfig({ cwd: fixture.cwd, agentDir: fixture.agentDir });

    assert.equal(loaded.config.maxResults, 20);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
