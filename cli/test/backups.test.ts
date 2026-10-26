import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Schema } from "effect";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";

import { composeBackupProfile, composeTomlDocuments } from "@/backups";
import { Job } from "@/backups/model";
import { loadBackupSettings } from "@/backups/settings";
import { loadConfig } from "@/config/load";
import { buildWizardConfigDocument } from "@/config/wizard";
import { syncByorSparseSource } from "@/setup/source";
import { normalizeBackups, parseByorContract, parseByorContractJson } from "@/source/contract";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(os.homedir).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempRoot() {
  const root = await mkdtemp(join(os.tmpdir(), "outfitting-backups-"));
  roots.push(root);
  return root;
}
const documents = {
  name: "documents",
  sources: ["${HOME}/Documents"],
  tags: ["documents"],
  "skip-if-unchanged": true,
};
const images = {
  name: "images",
  sources: ["${HOME}/Pictures"],
  tags: ["images"],
  "skip-if-unchanged": true,
};
const base = {
  repository: { repository: "opendal:s3" },
  forget: { "keep-daily": 7 },
  backup: { snapshots: [documents] },
};
const alertConfig = {
  alertUrl: "https://alerts.invalid/v1/alerts/archive-laptop",
  alertSender: "laptop@alerts.example.net",
  alertRecipient: ["backups@example.net"],
};
const credentials = {
  "access-key": "team storage access",
  "secret-key": "team storage secret",
  "repository-password": "archive passphrase",
  "alert-token": "notification token",
};

test("missing backup identities remain editable but fail before source access", async () => {
  const root = await tempRoot();
  const contract = parseByorContract({
    schema: 3,
    profiles: { desk: { macos: { nix: { flake: "missing", attribute: "desk" } } } },
    backups: {
      defaultProfile: "archive",
      profiles: { archive: { platform: "macos", files: ["missing.toml"] } },
    },
  });
  const document = buildWizardConfigDocument(
    contract,
    { path: root },
    { platform: "macos", profiles: ["desk"], manifest: contract },
  );
  expect(document.backups?.alertsDisabled).toBeUndefined();
  await writeFile(join(root, "config.toml"), stringify(document));
  const config = await loadConfig({ stateRoot: root });
  await expect(loadBackupSettings(config, undefined, "darwin")).rejects.toThrow(
    "backups.credentials",
  );
  config.backups!.credentials = credentials;
  await expect(loadBackupSettings(config, undefined, "darwin")).rejects.toThrow(
    "backups.alertsDisabled",
  );
});

test.each([
  { ...credentials, "access-key": "Access", "secret-key": "access" },
  { ...credentials, "repository-password": "Archive Password", "alert-token": "ARCHIVE PASSWORD" },
])("Windows rejects case-only credential collisions before source access: %j", async (mapping) => {
  const root = await tempRoot();
  await writeFile(
    join(root, "config.toml"),
    stringify({
      schema: 2,
      backups: {
        profile: "archive",
        credentials: mapping,
        alertsDisabled: true,
        profiles: { archive: { platform: "windows", files: ["missing.toml"] } },
      },
    }),
  );
  const config = await loadConfig({ stateRoot: root });
  await expect(loadBackupSettings(config, undefined, "win32")).rejects.toThrow(
    "case-insensitively distinct",
  );
});

test.each([
  { credentials: {} },
  { credentials: { ...credentials, "alert-token": undefined } },
  { credentials: { ...credentials, typo: "unknown" } },
  { credentials: { ...credentials, "access-key": "   " } },
  { credentials: { ...credentials, "secret-key": "bad\nname" } },
  { credentials: { ...credentials, "repository-password": "bad\0name" } },
  { credentials: { ...credentials, "alert-token": credentials["secret-key"] } },
  ...["", "../agent", "label with space", "label\n", "a".repeat(256)].map((scheduleLabel) => ({
    scheduleLabel,
  })),
])("rejects invalid native identities or schedule labels: %j", async (identities) => {
  const root = await tempRoot();
  await writeFile(
    join(root, "config.toml"),
    stringify({
      schema: 2,
      backups: {
        profile: "archive",
        profiles: { archive: { platform: "macos", files: ["missing.toml"] } },
        ...identities,
      },
    }),
  );
  await expect(loadConfig({ stateRoot: root })).rejects.toThrow();
  if ("credentials" in identities) {
    expect(() =>
      parseByorContractJson(
        JSON.stringify({
          schema: 3,
          profiles: { desk: { macos: { nix: { flake: "nix", attribute: "desk" } } } },
          backups: {
            defaultProfile: "archive",
            profiles: { archive: { platform: "macos", files: ["jobs.toml"] } },
            ...identities,
          },
        }),
      ),
    ).toThrow();
  }
});

test.each(["macos", "windows"] as const)(
  "%s manifest credentials import exactly and round-trip through local config",
  async (platform) => {
    const root = await tempRoot();
    const mapping = {
      "access-key": " Archive’s Access ",
      "secret-key": "Team's storage secret",
      "repository-password": "Repository password 42",
      "alert-token": "Notification token 19",
    };
    const contract = parseByorContract({
      schema: 3,
      profiles: {
        desk: {
          [platform]:
            platform === "macos"
              ? { nix: { flake: "nix", attribute: "desk" } }
              : { winget: { manifest: "packages.txt" } },
        },
      },
      backups: {
        defaultProfile: "archive",
        credentials: mapping,
        profiles: { archive: { platform, files: ["jobs.toml"] } },
      },
    });
    expect(contract.backups?.credentials).toEqual(mapping);
    const document = buildWizardConfigDocument(
      contract,
      { path: root },
      { platform, profiles: ["desk"], manifest: contract },
    );
    expect(document.backups?.credentials).toEqual(mapping);
    await writeFile(join(root, "config.toml"), stringify(document));
    expect((await loadConfig({ stateRoot: root })).backups?.credentials).toEqual(mapping);
  },
);

test.each(["macos", "windows"] as const)(
  "%s resolves explicit paths without changing spelling or repository identity",
  async (platform) => {
    const root = await tempRoot();
    const home = platform === "windows" ? "C:/Users/fixture" : "/Users/fixture";
    vi.mocked(os.homedir).mockReturnValue(home);
    vi.stubEnv("LOCALAPPDATA", "C:/Users/fixture/AppData/Local");
    vi.stubEnv("APPDATA", "C:/Users/fixture/AppData/Roaming");
    vi.stubEnv("USERPROFILE", "C:/Users/fixture");
    vi.stubEnv("PROTON_DRIVE_PATH", "ignored ambient value");
    const photos =
      platform === "windows" ? "\\\\server\\share\\Photos Space" : "/Volumes/Photos Space";
    const paths = {
      PHOTOS: photos,
      DOCUMENTS: "${HOME}/Images/../Imágenes",
      DECOMPOSED: "${HOME}/Imágenes",
    };
    const sources = ["${PHOTOS}", "${DOCUMENTS}", "${DECOMPOSED}", "${HOME}/Documents"];
    if (platform === "windows") {
      sources.push("${APPDATA}/Editor", "${USERPROFILE}/Desktop", "${LOCALAPPDATA}/App");
    }
    await writeFile(
      join(root, "jobs.toml"),
      stringify({
        ...base,
        backup: { snapshots: [{ ...documents, sources, globs: ["!*.tmp", "${PHOTOS}/**"] }] },
      }),
    );
    const local = {
      schema: 2,
      source: { path: root },
      backups: {
        profile: "personal",
        credentials,
        alertsDisabled: true,
        logDirectory:
          platform === "windows" ? "${LOCALAPPDATA}/Backup Logs" : "${HOME}/Backup Logs",
        profiles: { personal: { platform, files: ["jobs.toml"], paths } },
      },
    };
    await writeFile(join(root, "config.toml"), stringify(local));
    const config = await loadConfig({ stateRoot: root });
    const settings = await loadBackupSettings(
      config,
      undefined,
      platform === "windows" ? "win32" : "darwin",
    );
    expect(settings.sources.documents).toEqual([
      photos,
      `${home}/Images/../Imágenes`,
      `${home}/Imágenes`,
      `${home}/Documents`,
      ...(platform === "windows"
        ? [
            "C:/Users/fixture/AppData/Roaming/Editor",
            "C:/Users/fixture/Desktop",
            "C:/Users/fixture/AppData/Local/App",
          ]
        : []),
    ]);
    expect(settings.profile.backup.snapshots[0]?.globs).toEqual(["!*.tmp", `${photos}/**`]);
    expect(settings.logFile).toBe(
      platform === "windows"
        ? "C:\\Users\\fixture\\AppData\\Local\\Backup Logs\\rustic.log"
        : "/Users/fixture/Backup Logs/rustic.log",
    );
    expect(settings.repository).toBe(
      createHash("sha256").update('{"repository":"opendal:s3"}').digest("hex"),
    );
    expect(settings.stateDirectory).toBe(
      platform === "windows"
        ? join("C:/Users/fixture/AppData/Local", "rustic-backup")
        : join(home, "Library/Application Support/rustic-backup"),
    );
    const composed = await composeBackupProfile({
      root,
      profile: "personal",
      declaration: config.backups!.profiles.personal!,
    });
    config.backups!.profiles.personal!.paths = { ...paths, PHOTOS: `${home}/Different Photos` };
    const changed = await loadBackupSettings(
      config,
      undefined,
      platform === "windows" ? "win32" : "darwin",
    );
    expect(changed.repository).toBe(settings.repository);
    expect(changed.stateDirectory).toBe(settings.stateDirectory);
    expect(
      (
        await composeBackupProfile({
          root,
          profile: "personal",
          declaration: config.backups!.profiles.personal!,
        })
      ).hash,
    ).not.toBe(composed.hash);
  },
);

test.each<Readonly<Record<string, string>>>([
  { HOME: "/override" },
  { APPDATA: "/override" },
  { photos: "/photos" },
  { PHOTOS: "" },
  { PHOTOS: "   " },
  { PHOTOS: "/photos\0" },
  { PHOTOS: "${PHOTOS}" },
  { PHOTOS: "${OTHER}", OTHER: "/photos" },
  { PHOTOS: "${APPDATA}/photos" },
  { PHOTOS: "${HOME:-/tmp}/photos" },
  { PHOTOS: "${HOME/photos" },
])("rejects invalid or recursive path bindings %j", (paths) => {
  expect(() =>
    normalizeBackups({
      defaultProfile: "mac",
      profiles: {
        mac: { platform: "macos", files: ["jobs.toml"], paths },
      },
    }),
  ).toThrow();
});

test.each([
  ["macos", "${PROTON_DRIVE_PATH}/photos"],
  ["macos", "${}"],
  ["macos", "${HOME"],
  ["macos", "relative/photos"],
  ["windows", "C:photos"],
  ["windows", "C:"],
  ["windows", "\\photos"],
  ["windows", "/photos"],
  ["windows", "\\\\server"],
  ["windows", "\\\\?\\C:\\photos"],
] as const)("%s rejects unresolved or non-qualified sources %s", async (platform, source) => {
  const root = await tempRoot();
  vi.stubEnv("PROTON_DRIVE_PATH", "/must-not-be-used");
  await writeFile(
    join(root, "jobs.toml"),
    stringify({ ...base, backup: { snapshots: [{ ...documents, sources: [source] }] } }),
  );
  const config = await loadConfig({ stateRoot: root });
  config.source = { kind: "local", path: root };
  config.backups = {
    profile: "one",
    credentials,
    alertsDisabled: true,
    profiles: { one: { platform, files: ["jobs.toml"] } },
  };
  await expect(
    loadBackupSettings(config, undefined, platform === "windows" ? "win32" : "darwin"),
  ).rejects.toThrow(/backup (substitution|path)/i);
});

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
  const staleCredentials = {
    "access-key": "old access",
    "secret-key": "old secret",
    "repository-password": "old password",
    "alert-token": "old notification",
  };
  const contract = parseByorContract({
    schema: 3,
    profiles: { desk: { windows: { winget: { manifest: "packages.txt" } } } },
    backups: {
      defaultProfile: "gaming",
      credentials,
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
          credentials: staleCredentials,
          ...alertConfig,
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
    credentials,
    ...alertConfig,
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
  ).toEqual({
    profile: "mac",
    credentials,
    ...alertConfig,
    profiles: { mac: { platform: "macos", files: ["mac.toml"] } },
  });
  const foreignManifest = parseByorContract({
    schema: 3,
    profiles: contract.profiles,
    backups: {
      defaultProfile: "other-mac",
      credentials: staleCredentials,
      profiles: { "other-mac": { platform: "macos", files: ["other.toml"] } },
    },
  });
  expect(
    buildWizardConfigDocument(
      contract,
      { path: root },
      { platform: "windows", profiles: ["desk"], manifest: foreignManifest, existing: document },
    ).backups?.credentials,
  ).toEqual(credentials);
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

test.each([
  "https://alerts.invalid/",
  "https://alerts.invalid/v1/alerts",
  "https://alerts.invalid/v1/alerts/Uppercase",
  "https://alerts.invalid/v1/alerts/a--b",
  "https://alerts.invalid/v1/alerts/-leading",
  "https://alerts.invalid/v1/alerts/trailing-",
  "https://alerts.invalid/v1/alerts/extra/path",
  "http://alerts.invalid/v1/alerts/backups-jfa-mac-mini",
  "https://token@alerts.invalid/v1/alerts/backups-jfa-mac-mini",
  "https://alerts.invalid/v1/alerts/backups-jfa-mac-mini?token=secret",
  "https://alerts.invalid/v1/alerts/backups-jfa-mac-mini?",
  "https://alerts.invalid/v1/alerts/backups-jfa-mac-mini#fragment",
  "https://alerts.invalid/v1/alerts/backups-jfa-mac-mini#",
  "https://alerts.invalid/v1/alerts/backups-jfa-mac-mini/",
  "https://alerts.invalid/v1/alerts/%62ackups-jfa-mac-mini",
  "https://alerts.invalid/v1/alerts/other/../backups-jfa-mac-mini",
  "not a URL",
])("rejects an unsafe or noncanonical alert URL: %s", async (alertUrl) => {
  const root = await tempRoot();
  await writeFile(
    join(root, "config.toml"),
    stringify({
      schema: 2,
      backups: {
        profile: "mac",
        ...alertConfig,
        alertUrl,
        profiles: { mac: { platform: "macos", files: ["mac.toml"] } },
      },
    }),
  );
  await expect(loadConfig({ stateRoot: root })).rejects.toThrow();
});

test.each([
  { alertsDisabled: true, ...alertConfig },
  { alertsDisabled: true, alertSender: alertConfig.alertSender },
  { alertsDisabled: false },
  { alertUrl: alertConfig.alertUrl },
  { alertSender: alertConfig.alertSender },
  { alertRecipient: alertConfig.alertRecipient },
  { alertUrl: alertConfig.alertUrl, alertSender: alertConfig.alertSender },
  { alertUrl: alertConfig.alertUrl, alertRecipient: alertConfig.alertRecipient },
  { alertSender: alertConfig.alertSender, alertRecipient: alertConfig.alertRecipient },
  { ...alertConfig, alertRecipient: [] },
  { ...alertConfig, alertRecipient: Array.from({ length: 51 }, (_, i) => `r${i}@example.net`) },
  { ...alertConfig, alertRecipient: ["User@example.net", "User@EXAMPLE.NET"] },
  { ...alertConfig, alertRecipient: ["valid@example.net", "Invalid <other@example.net>"] },
  { ...alertConfig, token: "never-store-tokens-in-toml" },
  ...[
    "",
    " user@example.com",
    "user@example.com\n",
    "User <user@example.com>",
    '"user"@example.com',
    "user@example.com,other@example.com",
    "user@[127.0.0.1]",
    "josé@example.com",
    "user@exámple.com",
    "a..b@example.com",
    "a".repeat(65) + "@example.com",
    "user@" + "d".repeat(64) + ".com",
    "a".repeat(64) + "@" + ["d".repeat(63), "e".repeat(63), "f".repeat(62)].join("."),
  ].flatMap((address) => [
    { ...alertConfig, alertSender: address },
    { ...alertConfig, alertRecipient: [address] },
  ]),
])("rejects incomplete or invalid backup alert addressing: %j", async (alerts) => {
  const root = await tempRoot();
  await writeFile(
    join(root, "config.toml"),
    stringify({
      schema: 2,
      backups: {
        profile: "mac",
        profiles: { mac: { platform: "macos", files: ["mac.toml"] } },
        ...alerts,
      },
    }),
  );
  await expect(loadConfig({ stateRoot: root })).rejects.toThrow();
});

test.each([1, 50])("accepts %i distinct recipients and preserves mailbox case", async (count) => {
  const root = await tempRoot();
  // Local parts are case-sensitive; domain-case-only duplicates are rejected above.
  const recipient = [
    "User@EXAMPLE.net",
    "user@example.net",
    ...Array.from({ length: 48 }, (_, i) => `r${i}@example.net`),
  ].slice(0, count);
  await writeFile(
    join(root, "config.toml"),
    stringify({
      schema: 2,
      backups: {
        profile: "mac",
        profiles: { mac: { platform: "macos", files: ["mac.toml"] } },
        ...alertConfig,
        alertRecipient: recipient,
      },
    }),
  );
  const config = await loadConfig({ stateRoot: root });
  expect(config.backups?.alertSender).toBe("laptop@alerts.example.net");
  expect(config.backups?.alertRecipient).toEqual(recipient);
});

test("rejects per-job alert maps rather than silently disabling alerts", async () => {
  const root = await tempRoot();
  await writeFile(
    join(root, "config.toml"),
    stringify({
      schema: 2,
      backups: {
        profile: "mac",
        profiles: { mac: { platform: "macos", files: ["mac.toml"] } },
        alerts: { documents: { url: alertConfig.alertUrl } },
      },
    }),
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
  config.backups.logDirectory = "/different/logs";
  config.backups.credentials = credentials;
  config.backups.scheduleLabel = "org.example.backup";
  config.backups.alertsDisabled = true;
  await expect(syncByorSparseSource({ ...options, offline: true })).resolves.toMatchObject({
    root: sourceRoot,
  });
  config.declarations = parseByorContract({
    ...config.declarations,
    schema: 3,
    backups: {
      defaultProfile: "manifest-only",
      credentials: { ...credentials, "access-key": "different manifest service" },
      profiles: { "manifest-only": { platform: "macos", files: ["not-fetched.toml"] } },
    },
  });
  await expect(syncByorSparseSource({ ...options, offline: true })).resolves.toMatchObject({
    root: sourceRoot,
  });
  vi.mocked(os.homedir).mockReturnValue("/Users/fixture");
  expect((await loadBackupSettings(config, undefined, "darwin")).credentials).toEqual(credentials);
  config.backups.profiles.mac!.paths = { PHOTOS: "${HOME}/Pictures" };
  await expect(syncByorSparseSource({ ...options, offline: true })).rejects.toThrow(
    "does not match",
  );
  delete config.backups.profiles.mac!.paths;
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
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\fixture\\AppData\\Local");
    vi.mocked(os.homedir).mockReturnValue(
      platform === "windows" ? "C:\\Users\\fixture" : "/Users/fixture",
    );
    const snapshots = ["photos", "constructor", "project-data"].map((name) => ({
      ...documents,
      name,
      sources: [platform === "windows" ? `D:/Backup Sources/${name}` : `/Volumes/Data/${name}`],
      tags: [name, "personal"],
    }));
    await writeFile(join(root, "jobs.toml"), stringify({ ...base, backup: { snapshots } }));
    const policies = { photos: { retention: { "keep-monthly": 3 } } };
    const local = {
      schema: 2,
      source: { path: root },
      backups: {
        profile: "personal",
        credentials,
        alertsDisabled: true,
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
    expect(first.sources.photos).toEqual([
      platform === "windows" ? "D:/Backup Sources/photos" : "/Volumes/Data/photos",
    ]);
    expect(first.alert).toEqual({ protocol: "disabled" });
    expect(first.credentials).toEqual(credentials);
    expect(first.scheduleLabel).toBe("dev.outfitting.backups.personal");
    const hash = first.repository;
    config.backups!.profiles.personal!.jobs = { photos: { retention: { "keep-monthly": 9 } } };
    const machineAlert =
      platform === "windows"
        ? {
            ...alertConfig,
            alertUrl: "https://alerts.invalid/v1/alerts/storage-desktop",
            alertSender: "desktop@alerts.example.net",
          }
        : alertConfig;
    const { alertsDisabled: _alertsDisabled, ...enabledBackups } = config.backups!;
    await writeFile(
      join(root, "config.toml"),
      stringify({
        ...local,
        backups: { ...enabledBackups, scheduleLabel: "org.example.archive", ...machineAlert },
      }),
    );
    const second = await loadBackupSettings(
      await loadConfig({ stateRoot: root }),
      undefined,
      platform === "windows" ? "win32" : "darwin",
    );
    expect(second.repository).toBe(hash);
    expect(second.jobPolicies.photos?.retention).toEqual({ "keep-monthly": 9 });
    expect(second.alert).toEqual({
      protocol: "v1",
      url: machineAlert.alertUrl,
      sender: machineAlert.alertSender,
      recipient: ["backups@example.net"],
    });
    expect(second.scheduleLabel).toBe("org.example.archive");
    const differentRoute = {
      ...config,
      backups: {
        ...enabledBackups,
        ...machineAlert,
        alertUrl: "https://alerts.invalid/v1/alerts/unrelated-device-42",
      },
    };
    await expect(
      loadBackupSettings(differentRoute, undefined, platform === "macos" ? "darwin" : "win32"),
    ).resolves.toMatchObject({
      alert: { url: "https://alerts.invalid/v1/alerts/unrelated-device-42" },
    });
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

test("paths and policies round-trip through import and local config; re-import replaces stale declarations", async () => {
  const root = await tempRoot();
  const paths = { PHOTOS: "${USERPROFILE}/Pictures" };
  const jobs = {
    photos: { retention: { "keep-daily": 0, "keep-monthly": -1 } },
    "project-data": { skipIfProcessesRunning: ["Editor", "Editor_Helper"] },
  };
  const contract = parseByorContract({
    schema: 3,
    profiles: { desk: { windows: { winget: { manifest: "packages.txt" } } } },
    backups: {
      defaultProfile: "desk",
      profiles: { desk: { platform: "windows", files: ["jobs.toml"], paths, jobs } },
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
          logDirectory: "${LOCALAPPDATA}/Backup Logs",
          credentials,
          alertsDisabled: true,
          scheduleLabel: "org.example.existing",
          profiles: {
            desk: {
              platform: "windows",
              files: ["old.toml"],
              paths: { OBSOLETE: "C:/old" },
              jobs: { obsolete: { retention: { "keep-monthly": 1 } } },
            },
          },
        },
      },
    },
  );
  expect(document.schema).toBe(2);
  expect(document.backups?.profiles.desk?.jobs).toEqual(jobs);
  expect(document.backups?.profiles.desk?.paths).toEqual(paths);
  expect(document.backups?.logDirectory).toBe("${LOCALAPPDATA}/Backup Logs");
  expect(document.backups?.credentials).toEqual(credentials);
  expect(document.backups?.alertsDisabled).toBe(true);
  expect(document.backups?.scheduleLabel).toBe("org.example.existing");
  await writeFile(join(root, "config.toml"), stringify(document));
  expect((await loadConfig({ stateRoot: root })).backups).toEqual(document.backups);
  const edited = buildWizardConfigDocument(
    contract,
    { path: root },
    { platform: "windows", profiles: ["desk"], existing: document },
  );
  expect(edited.backups?.profiles.desk?.jobs).toEqual(jobs);
  expect(edited.backups?.profiles.desk?.paths).toEqual(paths);
  expect(edited.backups?.logDirectory).toBe(document.backups?.logDirectory);
  expect(edited.backups?.credentials).toEqual(credentials);
  expect(edited.backups?.alertsDisabled).toBe(true);
  expect(edited.backups?.scheduleLabel).toBe("org.example.existing");
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
