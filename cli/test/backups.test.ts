import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parse, stringify } from "smol-toml";
import { afterEach, expect, test } from "vitest";

import { composeBackupProfile, composeTomlDocuments } from "@/backups";
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
  expect(() => parseByorContract({ schema: 1, profiles, backups })).toThrow("schema 2");
  expect(() =>
    parseByorContract({ schema: 2, profiles, backups: { ...backups, typo: true } } as never),
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
    schema: 2,
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
