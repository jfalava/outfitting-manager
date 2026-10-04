import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Schema } from "effect";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, test } from "vitest";

import { composeBackupProfile, composeTomlDocuments } from "@/backups";
import { Job } from "@/backups/model";
import { loadBackupSettings } from "@/backups/settings";
import { loadConfig } from "@/config/load";
import { buildWizardConfigDocument } from "@/config/wizard";
import { syncByorSparseSource } from "@/setup/source";
import { normalizeBackups, parseByorContract } from "@/source/contract";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "outfitting-backups-"));
  roots.push(root);
  return root;
}
const documents = {
  name: "documents",
  sources: ["${PROTON_DRIVE_PATH}/Documentos"],
  tags: ["documents"],
  "skip-if-unchanged": true,
};
const images = {
  name: "images",
  sources: ["${PROTON_IMAGES_DIR}"],
  tags: ["images"],
  "skip-if-unchanged": true,
};
const base = {
  repository: { repository: "opendal:s3" },
  forget: { "keep-daily": 7 },
  backup: { snapshots: [documents] },
};

test("composes tables recursively, overrides scalars, replaces arrays, and appends snapshots", () => {
  const result = composeTomlDocuments([
    {
      repository: { repository: "first", options: { region: "one" } },
      forget: { keepDaily: 7 },
      values: ["first"],
      backup: { snapshots: [{ name: "one", sources: ["a"] }] },
    },
    {
      repository: { options: { region: "two", bucket: "bucket" } },
      values: ["second"],
      backup: { snapshots: [{ name: "two", sources: ["b"] }] },
    },
  ]);

  expect(result.repository).toEqual({
    repository: "first",
    options: { region: "two", bucket: "bucket" },
  });
  expect(result.values).toEqual(["second"]);
  expect(result.backup).toEqual({
    snapshots: [
      { name: "one", sources: ["a"] },
      { name: "two", sources: ["b"] },
    ],
  });
});

test("rejects duplicate snapshot names and preserves ordered declaration hashing", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "one.toml"), stringify(base));
  await writeFile(join(root, "two.toml"), stringify({ backup: { snapshots: [documents] } }));
  await expect(
    composeBackupProfile({
      root,
      profile: "one",
      declaration: { platform: "macos", files: ["one.toml", "two.toml"] },
    }),
  ).rejects.toThrow("Duplicate");

  await writeFile(join(root, "two.toml"), stringify({ backup: { snapshots: [images] } }));
  const first = await composeBackupProfile({
    root,
    profile: "one",
    declaration: { platform: "macos", files: ["one.toml", "two.toml"] },
  });
  const second = await composeBackupProfile({
    root,
    profile: "one",
    declaration: { platform: "macos", files: ["two.toml", "one.toml"] },
  });
  expect(first.hash).not.toBe(second.hash);
  expect(first.document.backup).toEqual({
    snapshots: [documents, images],
  });
});

test.each([
  "/absolute.toml",
  "../escape.toml",
  "C:relative.toml",
  "a/../b.toml",
  "config.toml",
  "Config.toml",
  "con.toml",
  "unsafe./file.toml",
  ".git/config.toml",
  "a.txt",
  "a//b.toml",
])("rejects unsafe backup path %s", (file) => {
  expect(() =>
    normalizeBackups({
      defaultProfile: "mac",
      profiles: { mac: { platform: "macos", files: [file] } },
    }),
  ).toThrow();
});

test("rejects empty, duplicate, and unknown declarations", () => {
  for (const files of [[], ["a.toml", "a.toml"]]) {
    expect(() =>
      normalizeBackups({ defaultProfile: "mac", profiles: { mac: { platform: "macos", files } } }),
    ).toThrow();
  }
  const profiles = { desk: { windows: { winget: { manifest: "packages.txt" } } } };
  const backups = {
    defaultProfile: "mac",
    profiles: { mac: { platform: "macos" as const, files: ["a.toml"] } },
  };
  for (const schema of [1, 2] as const) {
    expect(() => parseByorContract({ schema, profiles, backups })).toThrow("schema 3");
  }
  expect(() =>
    parseByorContract({ schema: 3, profiles, backups: { ...backups, typo: true } } as never),
  ).toThrow();
  expect(() => normalizeBackups({ ...backups, defaultProfile: "absent" })).toThrow();
});

test("rejects external symlinks, unsupported substitutions, and unknown Rustic keys before execution", async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  await writeFile(join(outside, "external.toml"), stringify(base));
  await symlink(outside, join(root, "external"), process.platform === "win32" ? "junction" : "dir");
  await expect(
    composeBackupProfile({
      root,
      profile: "mac",
      declaration: { platform: "macos", files: ["external/external.toml"] },
    }),
  ).rejects.toThrow("outside");
  const compose = () =>
    composeBackupProfile({
      root,
      profile: "mac",
      declaration: { platform: "macos", files: ["profile.toml"] },
    });
  await writeFile(
    join(root, "profile.toml"),
    stringify({ ...base, typo: true, backup: { snapshots: [documents, images] } }),
  );
  await expect(compose()).rejects.toThrow();
  await writeFile(
    join(root, "profile.toml"),
    stringify({
      ...base,
      backup: { snapshots: [documents, { ...images, sources: ["${UNKNOWN}/photos"] }] },
    }),
  );
  await expect(compose()).rejects.toThrow("Unsupported backup substitution");
});

test("manifest re-import replaces current-platform backups, preserves other platforms and ordered runtime files", async () => {
  const root = await tempRoot();
  const contract = parseByorContract({
    schema: 3,
    profiles: { desk: { windows: { winget: { manifest: "packages.txt" } } } },
    backups: {
      defaultProfile: "gaming",
      profiles: { gaming: { platform: "windows", files: ["common.toml", "gaming.toml"] } },
    },
  });
  const document = buildWizardConfigDocument(
    contract,
    { path: root },
    {
      platform: "windows",
      profiles: ["desk"],
      manifest: contract,
      existing: {
        backups: {
          profile: "old",
          profiles: {
            old: { platform: "windows", files: ["stale.toml"] },
            mac: { platform: "macos", files: ["mac.toml"] },
          },
        },
      },
    },
  );
  expect(document.backups).toEqual({
    profile: "gaming",
    profiles: {
      mac: { platform: "macos", files: ["mac.toml"] },
      gaming: { platform: "windows", files: ["common.toml", "gaming.toml"] },
    },
  });
  await writeFile(join(root, "config.toml"), stringify(document));
  const config = await loadConfig({ stateRoot: root });
  expect(config.backups).toEqual(document.backups);
  expect(
    buildWizardConfigDocument(
      contract,
      { path: root },
      { platform: "windows", profiles: ["desk"], existing: document },
    ).backups,
  ).toEqual(document.backups);
  const withoutBackups = parseByorContract({ schema: 1, profiles: contract.profiles });
  expect(
    buildWizardConfigDocument(
      withoutBackups,
      { path: root },
      { platform: "windows", profiles: ["desk"], manifest: withoutBackups, existing: document },
    ).backups,
  ).toEqual({ profile: "mac", profiles: { mac: { platform: "macos", files: ["mac.toml"] } } });
  await expect(loadBackupSettings(config, "gaming", "darwin")).rejects.toThrow("not this host");
  await expect(loadBackupSettings(config, "missing", "win32")).rejects.toThrow("Select a declared");
  await expect(loadBackupSettings(config, "mac", "linux")).rejects.toThrow(
    "macOS and Windows only",
  );
  await writeFile(
    join(root, "config.toml"),
    stringify({ ...document, backups: { ...document.backups, typo: true } }),
  );
  await expect(loadConfig({ stateRoot: root })).rejects.toThrow();
});

test("sparse refresh includes backup fragments, hashes order, and leaves the last valid source on composition failure", async () => {
  const repo = await tempRoot();
  const stateRoot = await tempRoot();
  const sourceRoot = join(stateRoot, "source");
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: repo });
  const files = {
    "nix/flake.nix": "{ outputs = inputs: { darwinConfigurations = {}; }; }",
    "nix/darwin.nix": "{}",
    "common.toml": stringify({ forget: { "keep-daily": 7 } }),
    "mac.toml": stringify({ ...base, backup: { snapshots: [documents, images] } }),
  };
  await mkdir(join(repo, "nix"));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(repo, name), text);
  }
  await git(["init", "--quiet"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  const config = await loadConfig({ stateRoot });
  config.source = { kind: "remote", repository: repo, ref: "HEAD" };
  config.declarations = parseByorContract({
    schema: 1,
    profiles: { desk: { macos: { nix: { flake: "nix", attribute: "desk" } } } },
  });
  config.macos = { profile: "desk" };
  config.backups = {
    profile: "mac",
    profiles: { mac: { platform: "macos", files: ["common.toml", "mac.toml"] } },
  };
  const options = { config, platform: "macos" as const, sourceRoot };
  await syncByorSparseSource(options);
  // Git may convert checkout newlines on Windows; validate the TOML content.
  expect(parse(await readFile(join(sourceRoot, "common.toml"), "utf8"))).toEqual(
    parse(files["common.toml"]),
  );
  const cachedMac = await readFile(join(sourceRoot, "mac.toml"), "utf8");
  expect(parse(cachedMac)).toEqual(parse(files["mac.toml"]));
  await expect(syncByorSparseSource({ ...options, offline: true })).resolves.toMatchObject({
    root: sourceRoot,
  });
  config.backups.profiles.mac!.files.reverse();
  await expect(syncByorSparseSource({ ...options, offline: true })).rejects.toThrow(
    "does not match",
  );
  config.backups.profiles.mac!.files.reverse();
  config.backups.profiles.mac!.jobs = { documents: { retention: { "keep-monthly": 2 } } };
  await expect(syncByorSparseSource({ ...options, offline: true })).rejects.toThrow(
    "does not match",
  );
  delete config.backups.profiles.mac!.jobs;
  await writeFile(
    join(repo, "mac.toml"),
    stringify({ ...base, backup: { snapshots: [documents, documents] } }),
  );
  await git(["add", "mac.toml"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "invalid composition",
  ]);
  await expect(syncByorSparseSource(options)).rejects.toThrow("Duplicate");
  expect(await readFile(join(sourceRoot, "mac.toml"), "utf8")).toBe(cachedMac);
});

test.each(["macos", "windows"] as const)(
  "%s jobs come only from ordered Rustic snapshots, with local policies",
  async (platform) => {
    const root = await tempRoot();
    const snapshots = ["photos", "constructor", "project-data"].map((name) => ({
      ...documents,
      name,
      sources: [join(root, name)],
      tags: [name, "personal"],
    }));
    await writeFile(join(root, "jobs.toml"), stringify({ ...base, backup: { snapshots } }));
    const policies = { photos: { retention: { "keep-monthly": 3 } } };
    const local = {
      schema: 2,
      source: { path: root },
      backups: {
        profile: "personal",
        profiles: { personal: { platform, files: ["jobs.toml"], jobs: policies } },
      },
    };
    await writeFile(join(root, "config.toml"), stringify(local));
    // Runtime must not read this conflicting manifest.
    await writeFile(join(root, "outfitting.json"), "invalid manifest");
    const config = await loadConfig({ stateRoot: root });
    const first = await loadBackupSettings(
      config,
      undefined,
      platform === "windows" ? "win32" : "darwin",
    );
    expect(first.jobs).toEqual(["photos", "constructor", "project-data"]);
    expect(first.jobPolicies).toEqual(policies);
    expect(first.sources.photos).toEqual([join(root, "photos")]);
    const hash = first.repository;
    config.backups!.profiles.personal!.jobs = { photos: { retention: { "keep-monthly": 9 } } };
    const second = await loadBackupSettings(
      config,
      undefined,
      platform === "windows" ? "win32" : "darwin",
    );
    expect(second.repository).toBe(hash);
    expect(second.jobPolicies.photos?.retention).toEqual({ "keep-monthly": 9 });
    await writeFile(
      join(root, "jobs.toml"),
      stringify({ ...base, backup: { snapshots: [snapshots[1]!] } }),
    );
    delete config.backups!.profiles.personal!.jobs;
    expect(
      (await loadBackupSettings(config, undefined, platform === "windows" ? "win32" : "darwin"))
        .jobs,
    ).toEqual(["constructor"]);
  },
);

test.each([
  "",
  "../escape",
  "photos.json",
  "Photos",
  "check",
  "con",
  "lpt9",
  "a,b",
  "a".repeat(65),
])("rejects unsafe job ID %j", (name) => {
  expect(Schema.is(Job)(name)).toBe(false);
});

test("policies round-trip through import and local config; re-import replaces stale policies", async () => {
  const root = await tempRoot();
  const jobs = {
    photos: { retention: { "keep-daily": 0, "keep-monthly": -1 } },
    "project-data": { skipIfProcessesRunning: ["Editor", "Editor_Helper"] },
  };
  const contract = parseByorContract({
    schema: 3,
    profiles: { desk: { windows: { winget: { manifest: "packages.txt" } } } },
    backups: {
      defaultProfile: "desk",
      profiles: { desk: { platform: "windows", files: ["jobs.toml"], jobs } },
    },
  });
  const document = buildWizardConfigDocument(
    contract,
    { path: root },
    {
      platform: "windows",
      profiles: ["desk"],
      manifest: contract,
      existing: {
        backups: {
          profile: "desk",
          profiles: {
            desk: {
              platform: "windows",
              files: ["old.toml"],
              jobs: { obsolete: { retention: { "keep-monthly": 1 } } },
            },
          },
        },
      },
    },
  );
  expect(document.schema).toBe(2);
  expect(document.backups?.profiles.desk?.jobs).toEqual(jobs);
  await writeFile(join(root, "config.toml"), stringify(document));
  expect((await loadConfig({ stateRoot: root })).backups?.profiles.desk?.jobs).toEqual(jobs);
  const edited = buildWizardConfigDocument(
    contract,
    { path: root },
    { platform: "windows", profiles: ["desk"], existing: document },
  );
  expect(edited.backups?.profiles.desk?.jobs).toEqual(jobs);
  await writeFile(join(root, "config.toml"), stringify({ ...document, schema: 1 }));
  await expect(loadConfig({ stateRoot: root })).rejects.toThrow(
    "Migrate retention overrides and process guards",
  );
});

test.each([
  { photos: { typo: true } },
  { photos: { retention: { "keep-id": ["anchor"] } } },
  { photos: { retention: { "keep-monthly": -2 } } },
  { photos: { retention: { "keep-monthly": 2_147_483_648 } } },
  { photos: { skipIfProcessesRunning: ["Editor", "editor"] } },
  { photos: { skipIfProcessesRunning: ["Editor.exe"] } },
  { photos: { skipIfProcessesRunning: ["Editor;exit"] } },
  { photos: { skipIfProcessesRunning: ["Edit*"] } },
  { "../escape": {} },
])("rejects invalid job policy %j", (jobs) => {
  expect(() =>
    parseByorContract({
      schema: 3,
      profiles: { desk: { windows: { winget: { manifest: "packages.txt" } } } },
      backups: {
        defaultProfile: "desk",
        profiles: { desk: { platform: "windows", files: ["jobs.toml"], jobs } },
      },
    } as never),
  ).toThrow();
});

test("composition rejects dangling policies, overlapping tags, empty jobs and disabled retention", async () => {
  const root = await tempRoot();
  const photos = { ...documents, name: "photos", sources: ["/photos"], tags: ["photos"] };
  const projects = { ...photos, name: "projects", tags: ["projects"] };
  const declaration = { platform: "windows" as const, files: ["jobs.toml"] };
  const compose = (jobs = {}) =>
    composeBackupProfile({ root, profile: "desk", declaration: { ...declaration, jobs } });
  await writeFile(
    join(root, "jobs.toml"),
    stringify({ ...base, backup: { snapshots: [photos, projects] } }),
  );
  await expect(compose({ absent: {} })).rejects.toThrow("does not match");
  const first = await compose();
  const policy = await compose({ photos: { retention: { "keep-monthly": 3 } } });
  expect(policy.hash).not.toBe(first.hash);
  for (const tags of [
    ["photos", "projects"],
    ["photos", "annotation,projects"],
    ["photos", " "],
    ["photos", " projects "],
    ["photos", "annotation\u0000"],
  ]) {
    await writeFile(
      join(root, "jobs.toml"),
      stringify({ ...base, backup: { snapshots: [{ ...photos, tags }, projects] } }),
    );
    await expect(compose()).rejects.toThrow("identity tag");
  }
  await writeFile(join(root, "jobs.toml"), stringify({ ...base, backup: { snapshots: [] } }));
  await expect(compose()).rejects.toThrow();
  await writeFile(join(root, "jobs.toml"), stringify({ ...base, backup: { snapshots: [photos] } }));
  await expect(compose({ photos: { retention: { "keep-daily": 0 } } })).rejects.toThrow(
    "enabled retention",
  );
  await expect(compose({ photos: { retention: { "keep-daily": -1 } } })).resolves.toBeDefined();
});

test("process guards are explicitly Windows-only and enforce the process-count boundary", () => {
  const processes = Array.from({ length: 32 }, (_, index) => `Process_${index}`);
  const declaration = (platform: "macos" | "windows", names: string[]) => ({
    defaultProfile: "desk",
    profiles: {
      desk: { platform, files: ["jobs.toml"], jobs: { photos: { skipIfProcessesRunning: names } } },
    },
  });
  expect(() => normalizeBackups(declaration("macos", ["Editor"]))).toThrow("Windows only");
  expect(normalizeBackups(declaration("macos", []))?.profiles.desk?.jobs?.photos).toEqual({
    skipIfProcessesRunning: [],
  });
  expect(
    normalizeBackups(declaration("windows", processes))?.profiles.desk?.jobs?.photos
      ?.skipIfProcessesRunning,
  ).toHaveLength(32);
  expect(() => normalizeBackups(declaration("windows", [...processes, "OneTooMany"]))).toThrow();
});
