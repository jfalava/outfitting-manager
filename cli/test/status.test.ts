import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { readStatus } from "@/commands/status";
import { loadConfig, sparseSourceRoot } from "@/config";
import { readWindowsLock, writeWindowsLock } from "@/update/windows-lock";

beforeEach(() => {
  for (const name of ["OUTFITTING_PROFILE", "OUTFITTING_REPO", "OUTFITTING_CONFIG"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => vi.unstubAllEnvs());

test("status reports defaults without creating any state", async () => {
  vi.stubEnv("OUTFITTING_REPO", "");
  const root = await mkdtemp(join(tmpdir(), "outfitting-status-"));
  try {
    const absent = join(root, "not-created");
    const config = await loadConfig({ stateRoot: absent });
    for (const platform of ["macos", "windows", "linux"] as const) {
      const output = await readStatus(platform, { config });
      expect(output).toContain(`Platform: ${platform}`);
      expect(output).toContain(`Config: ${join(absent, "config.toml")}`);
      expect(output).toContain("Profile: not selected");
      expect(output).toContain("Source checkout: not configured");
      expect(output).toContain("Source mode: not configured");
      expect(output).toContain(`Machine ID: ${config.machineId}`);
    }
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status preserves saved profiles and distinguishes sparse, missing and dirty sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "outfitting-status-source-"));
  try {
    await writeFile(
      join(root, "config.toml"),
      `schema = 2\n[source]\npath = ${JSON.stringify(root)}\n[linux]\nprofile = "linux-work"\n[profiles.work.windows.winget]\nmanifest = "packages/work.txt"\n[profiles.dev.windows.winget]\nmanifest = "packages/dev.txt"\n[profiles.linux-work.linux.apt]\nmanifest = "packages/linux.txt"\n`,
    );
    const config = await loadConfig({ stateRoot: root });
    const lock = await readWindowsLock(config);
    lock.profiles = ["work", "dev"];
    await writeWindowsLock(lock, { root });
    const before = await readFile(join(root, "windows.lock.json"), "utf8");
    expect(await readStatus("windows", { config, envRepo: root })).toContain("Profile: work,dev");
    const linuxStatus = await readStatus("linux", { config, envRepo: root });
    expect(linuxStatus).toContain("Profile: linux-work");
    expect(linuxStatus).toContain("local source (no Git metadata)");
    expect(await readStatus("linux", { config, envRepo: join(root, "missing") })).toContain(
      "Source checkout: missing",
    );
    await mkdir(join(root, ".git"));
    const run = vi.fn(async () => ({
      code: 0,
      stdout: "## feature...origin/feature [ahead 1]\n M foo\n",
      stderr: "",
    }));
    const output = await readStatus("linux", { config, envRepo: root, run });
    expect(output).toContain("Source checkout: dirty");
    expect(output).toContain("Git: feature...origin/feature [ahead 1]");
    expect(run.mock.calls).toHaveLength(1);
    expect(await readFile(join(root, "windows.lock.json"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["missing", "Unknown BYOR Linux profile `missing`. Choose: work, server."],
  [
    undefined,
    "The BYOR repository defines multiple Linux profiles. Pass --profile (work, server).",
  ],
])(
  "status reports profile selection errors without hiding other details: %s",
  async (profile, reason) => {
    const root = await mkdtemp(join(tmpdir(), "outfitting-status-profile-"));
    try {
      const configPath = join(root, "config.toml");
      await writeFile(
        configPath,
        [
          "schema = 2",
          ...(profile === undefined ? [] : ["[linux]", `profile = ${JSON.stringify(profile)}`]),
          "[profiles.work.linux.apt]",
          'manifest = "work.txt"',
          "[profiles.server.linux.apt]",
          'manifest = "server.txt"',
        ].join("\n"),
      );
      const config = await loadConfig({ stateRoot: root, configPath });
      const output = await readStatus("linux", { config });
      expect(output).toContain(`Profile: invalid (${reason})`);
      expect(output).toContain(`Config: ${configPath}`);
      expect(output).toContain("Source checkout: not configured");
      expect(await readdir(root)).toEqual(["config.toml"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("status labels remote snapshots and local overrides by their actual source", async () => {
  vi.stubEnv("OUTFITTING_REPO", "");
  const root = await mkdtemp(join(tmpdir(), "outfitting-status-remote-"));
  try {
    await mkdir(sparseSourceRoot(root));
    const config = {
      ...(await loadConfig({ stateRoot: root })),
      source: { kind: "remote" as const, repository: "owner/repo", ref: "main" },
    };
    const run = vi.fn(async () => ({ code: 0, stdout: "## main\n", stderr: "" }));

    const cached = await readStatus("linux", { config, run });
    expect(cached).toContain("Source checkout: cached snapshot (no Git metadata)");
    expect(run).not.toHaveBeenCalled();

    const checkout = join(root, "checkout");
    await mkdir(join(checkout, ".git"), { recursive: true });
    const local = await readStatus("linux", { config, envRepo: checkout, run });
    expect(local).toContain("Source checkout: clean");
    expect(local).not.toContain("cached snapshot");
    expect(run).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
