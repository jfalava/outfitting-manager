import type { JsonValue } from "@outfitting/contract";
import { Console, DateTime, Effect, Schema } from "effect";
import { stringify } from "smol-toml";

import { formatLaunchAgent } from "@/backups/launchd";
import { JobState, SnapshotGroups, secretNames } from "@/backups/model";
import type { SettingsData } from "@/backups/settings";
import { formatScheduledTask } from "@/backups/windows";
import { printBackupJson } from "@/commands/backups";
import { printDiff } from "@/commands/diff";
import { printProvisioned } from "@/commands/provision";
import { formatStatusConfiguration } from "@/commands/status";
import type { ManagerConfig } from "@/config/types";
import { printFaceTable, printInventoryFaces } from "@/fonts/display";
import { inventoryFromFaces } from "@/fonts/inventory";
import type { PlannedFace } from "@/fonts/plan";
import { printRepopulateResult } from "@/fonts/repopulate";
import type { HostPlatform } from "@/platform";
import { parseByorContract } from "@/source/contract";
import {
  printLockfileHistory,
  printLockfileKinds,
  printLockfilePull,
  printLockfilePush,
  printNoLocalLockfiles,
} from "@/sync/display";
import { ui } from "@/ui";
import { logCommandOutput, withActivity, withProgress } from "@/ui/progress";

export interface OutputPreview {
  readonly path: string;
  readonly empty?: boolean;
  readonly input?: "permission" | "question" | "auth";
  readonly render: (empty: boolean, delay: number) => Effect.Effect<void, unknown>;
}

const HASH = "a31d8f924ae78011cfa6a64dc5df22871c6f1f2c67de637654b2b66366c50192";
const TIME = "2026-10-26T10:00:00Z";
const API = "https://outfitting.example.test/api";
const architectures = { macos: "arm64", linux: "arm64", windows: "x64" };
const faces: PlannedFace[] = [
  {
    family: "Example Sans",
    style: "Regular",
    postscriptName: "ExampleSans-Regular",
    path: "fonts/example-sans/example-sans-regular.otf",
    change: "added",
  },
  {
    family: "Example Sans",
    style: "Bold Italic",
    postscriptName: "ExampleSans-BoldItalic",
    path: "fonts/example-sans/example-sans-bold-italic.otf",
    change: "replaced",
  },
  {
    family: "Example Mono",
    style: "Medium",
    postscriptName: "ExampleMono-Medium",
    path: "fonts/example-mono/example-mono-medium.ttf",
    change: "removed",
  },
];

const lines = (...values: string[]) => Console.log(values.join("\n"));
const json = (value: JsonValue) => Console.log(JSON.stringify(value, null, 2));
const activity = (label: string, delay: number) => withActivity(label, Effect.sleep(delay));
const sample = (
  path: string,
  render: OutputPreview["render"],
  extra: Pick<OutputPreview, "empty" | "input"> = {},
): OutputPreview => ({ path, render, ...extra });

function previewPaths(platform: HostPlatform) {
  const home =
    platform === "windows"
      ? "C:/Users/preview"
      : platform === "macos"
        ? "/Users/preview"
        : "/home/preview";
  return { home, source: `${home}/Developer/outfitting`, state: `${home}/.outfitting` };
}

function backupSettings(platform: HostPlatform) {
  const { home, source, state } = previewPaths(platform);
  return {
    repoRoot: source,
    configPath: `${state}/config.toml`,
    backupProfile: "personal",
    home,
    account: "preview",
    hostname: "preview-workstation",
    rustic: `${home}/bin/rustic`,
    stateDirectory: `${state}/backups`,
    logDirectory: `${state}/logs`,
    logFile: `${state}/logs/rustic.log`,
    credentials: {
      "access-key": "preview-access",
      "secret-key": "preview-secret",
      "repository-password": "preview-repository",
      "alert-token": "preview-alert",
    },
    scheduleLabel: "dev.example.outfitting.backups",
    alert: { protocol: "disabled" },
    repository: "s3:https://backup.example.test/personal",
    profile: {
      repository: { repository: "s3:https://backup.example.test/personal" },
      forget: { "keep-daily": 7 },
      backup: {
        snapshots: [
          {
            name: "documents",
            sources: [`${home}/Documents`],
            tags: ["documents"],
            "skip-if-unchanged": true,
          },
        ],
      },
    },
    jobs: ["documents"],
    dailyHour: platform === "windows" ? 9 : 10,
    jobPolicies: {},
    sources: { documents: [`${home}/Documents`] },
    environment: { USERDOMAIN: "PREVIEW", SystemRoot: "C:/Windows" },
  } satisfies SettingsData;
}

/** Fixed report data only. Never enter real command handlers, even with --dry-run. */
export function outputPreviews(platform: HostPlatform): OutputPreview[] {
  const { source, state } = previewPaths(platform);
  const machine = `preview:${architectures[platform]}-${platform}`;
  const kind =
    platform === "macos" ? "homebrew-inventory" : platform === "windows" ? "windows" : "nix";
  const manager = platform === "macos" ? "brew" : platform === "windows" ? "winget" : "apt";
  const config: ManagerConfig = {
    configPath: `${state}/config.toml`,
    stateRoot: state,
    machineId: machine,
    machineIdOverridden: false,
    source: { kind: "local", path: source },
  };
  const inventory = inventoryFromFaces(faces, HASH, 24680);
  const sampleConfig = stringify({
    schema: 2,
    source: { kind: "local", path: source },
    [platform]:
      platform === "windows" ? { profiles: ["workstation", "shared"] } : { profile: "workstation" },
  });
  const manifest = parseByorContract({
    schema: 3,
    profiles: {
      workstation: {
        linux: { apt: { manifest: "linux/packages.txt" } },
        macos: {
          nix: { flake: "nix", attribute: "darwinConfigurations.workstation.system" },
          paths: [],
        },
        windows: { winget: { manifest: "windows/workstation.json" } },
      },
    },
  });

  const previews: OutputPreview[] = [
    sample("init", (_empty, delay) =>
      Effect.gen(function* () {
        yield* lines(
          ui.success(`State root ready: ${state}`),
          ui.muted(`machine id: ${machine}`),
          ui.muted(`config: ${config.configPath}`),
        );
        yield* activity("Validating cached source", delay);
        yield* lines(
          ui.success(`Source path: ${source}`),
          "",
          ui.muted(
            platform === "macos"
              ? "Next: outfitting-manager nix switch, then outfitting-manager apply"
              : "Next: outfitting-manager apply",
          ),
        );
      }),
    ),
    sample(
      "config wizard",
      () => lines("", ui.heading("Review the new config.toml:"), sampleConfig),
      { input: "question" },
    ),
    sample(
      "config manifest",
      () =>
        lines(
          "",
          ui.heading("Review outfitting.json:"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          ui.success(`Repo manifest written: ${source}/outfitting.json`),
        ),
      { input: "permission" },
    ),
    sample("source path", () => Console.log(source)),
    sample(
      "status",
      (empty) =>
        lines(
          ...formatStatusConfiguration(
            platform,
            { ...config, source: empty ? undefined : config.source },
            {
              architecture: architectures[platform],
              profile: empty ? "not selected" : "workstation",
              inferredMachineId: machine,
            },
          ),
          ...(empty
            ? ["Source checkout: not configured"]
            : [`Source: ${source}`, "Source checkout: dirty", "Git: main...origin/main"]),
        ),
      { empty: true },
    ),
    sample("validate", () =>
      lines(
        ui.success(`BYOR contract valid: ${source}`),
        `platform: ${platform}`,
        platform === "windows" ? "profiles: workstation, shared" : "profile: workstation",
        platform === "linux"
          ? "backends: apt, nix"
          : platform === "macos"
            ? "flake: nix\nattribute: darwinConfigurations.workstation.system"
            : "winget: workstation=windows/workstation.json, shared=windows/shared.json",
      ),
    ),
    sample(
      "diff",
      (empty) =>
        printDiff({
          platform,
          source,
          sections: [
            {
              manager,
              status: empty ? "same" : "different",
              missing: empty ? [] : ["ripgrep", "fd"],
              extra: empty ? [] : ["legacy-tool"],
              changed: empty ? [] : ["git: 2.48 → 2.49"],
            },
          ],
          differences: !empty,
          unavailable: false,
        }),
      { empty: true },
    ),
    sample(
      "apply",
      (empty, delay) =>
        Effect.gen(function* () {
          if (empty) {
            yield* lines(ui.muted("No package changes."));
            return;
          }
          yield* lines(
            ui.heading(
              platform === "windows"
                ? "Windows apply plan:"
                : platform === "macos"
                  ? "Reading selected Homebrew Brewfile…"
                  : "Packages to be installed:",
            ),
            `  install ${manager}: ripgrep`,
            `  install ${manager}: fd`,
          );
          yield* withProgress(
            `${platform === "macos" ? "Homebrew" : platform === "windows" ? "Windows" : "Linux"} apply`,
            3,
            (progress) =>
              Effect.gen(function* () {
                yield* progress.track("Refreshing package metadata", Effect.sleep(delay));
                yield* progress.track("Installing ripgrep", Effect.sleep(delay));
                yield* Effect.sync(() =>
                  logCommandOutput(progress, {
                    code: 0,
                    stdout: "Installed ripgrep 14.1.1\n",
                    stderr: "Sample package-manager note.\n",
                  }),
                );
                yield* progress.track("Installing fd", Effect.sleep(delay));
              }),
          );
          yield* lines(
            ui.success(
              platform === "macos"
                ? "Homebrew apply complete."
                : platform === "windows"
                  ? "Windows declarations applied locally."
                  : "Linux apt profile applied (workstation).",
            ),
          );
        }),
      { empty: true, input: platform === "macos" ? undefined : "permission" },
    ),
    sample("update", (_empty, delay) =>
      Effect.gen(function* () {
        const stages =
          platform === "macos"
            ? ["brew update", "brew upgrade", "brew upgrade --cask"]
            : platform === "windows"
              ? ["Updating WinGet packages"]
              : ["Updating installed Linux packages with apt"];
        for (const stage of stages) {
          yield* lines(ui.heading(`${stage}…`));
          yield* activity(stage, delay);
        }
        yield* lines(
          ui.success(
            platform === "macos"
              ? "Homebrew update complete."
              : platform === "linux"
                ? "Linux apt update complete."
                : "WinGet update complete.",
          ),
        );
      }),
    ),
    sample("sync configure worker", () => lines(ui.success(`Stored Worker URL: ${ui.key(API)}`)), {
      input: "question",
    }),
    sample(
      "sync configure token",
      () => lines(ui.success("Stored API token in your OS keychain.")),
      { input: "auth" },
    ),
    sample(
      "sync list",
      (empty) => printLockfileKinds(machine, empty ? [] : [kind, "private-fonts"]),
      { empty: true },
    ),
    sample(
      "sync history",
      (empty) =>
        printLockfileHistory(
          machine,
          kind,
          empty
            ? []
            : [
                { hash: HASH, size: 1274, created_at: TIME },
                { hash: "d".repeat(64), size: 968, created_at: "2026-10-25T10:00:00Z" },
              ],
        ),
      { empty: true },
    ),
    sample(
      "sync push",
      (empty) =>
        empty
          ? printNoLocalLockfiles(machine, [kind])
          : printLockfilePush(machine, kind, { hash: HASH, size: 1274 }),
      { empty: true },
    ),
    sample(
      "sync pull",
      (empty) =>
        empty
          ? printLockfileKinds(machine, [])
          : printLockfilePull(machine, kind, `${state}/${kind}.lock`, 1274),
      { empty: true },
    ),
    sample(
      "fonts configure-endpoint",
      () =>
        lines(
          ui.success(`Stored R2 endpoint: ${ui.key("https://preview.r2.cloudflarestorage.com")}`),
        ),
      { input: "question" },
    ),
    sample(
      "fonts configure-credentials",
      () => lines(ui.success("Stored R2 credentials in your OS keychain.")),
      { input: "auth" },
    ),
    sample(
      "fonts list",
      (empty) =>
        empty
          ? lines(ui.muted("No private-fonts inventory is stored yet."))
          : Effect.gen(function* () {
              yield* lines(
                ui.muted(`${inventory.archive.key}  ${HASH}  (${inventory.archive.size} bytes)`),
              );
              yield* printInventoryFaces(faces);
            }),
      { empty: true },
    ),
    sample(
      "fonts repopulate",
      (empty) => printRepopulateResult({ inventory, wrote: !empty }, false),
      { empty: true },
    ),
    ...["publish", "remove"].map((action) =>
      sample(
        `fonts ${action}`,
        (empty) =>
          Effect.gen(function* () {
            yield* printFaceTable(
              empty
                ? []
                : faces.map((face) => ({
                    ...face,
                    change: action === "remove" ? "removed" : face.change,
                  })),
            );
            yield* lines(ui.muted("Dry run: skipped R2 upload and lockfile inventory."));
          }),
        { empty: true, input: "permission" },
      ),
    ),
    sample("provision", () =>
      Effect.sync(() =>
        printProvisioned(API, {
          stackName: "OutfittingPreview",
          workers: { api: "preview-api", router: "preview-router" },
          domain: "outfitting.example.test",
          configPath: `${source}/outfitting.deploy.json`,
          kvTitle: "preview-lockfiles",
          databaseName: "preview-lockfiles",
          privateFontsBucket: "preview-fonts",
        }),
      ),
    ),
    sample(
      "self-update",
      (empty, delay) =>
        empty
          ? lines(ui.success("outfitting-manager 0.8.0 is already up to date."))
          : Effect.gen(function* () {
              yield* lines("Updating outfitting-manager 0.7.0 → 0.8.0…");
              yield* activity("Downloading release", delay);
              yield* lines(
                ui.success(
                  `Installed outfitting-manager 0.8.0${platform === "windows" ? " and will be active on the next run" : ""}.`,
                ),
              );
            }),
      { empty: true },
    ),
  ];

  return [...previews, ...platformPreviews(platform), ...backupPreviews(platform)].toSorted(
    (a, b) => a.path.localeCompare(b.path),
  );
}

function platformPreviews(platform: HostPlatform): OutputPreview[] {
  const machine = `preview:${architectures[platform]}-${platform}`;
  const previews: OutputPreview[] = [];
  if (platform !== "windows") {
    const label = platform === "linux" ? "Home Manager" : "nix-darwin";
    for (const action of ["build", "test", "dry-run", "switch", "update"]) {
      previews.push(
        sample(
          `nix ${action}`,
          (_empty, delay) =>
            Effect.gen(function* () {
              yield* lines(
                ui.heading(
                  `${action === "test" ? "Testing" : action === "dry-run" ? "Dry-run" : "Building"} ${label}…`,
                ),
              );
              yield* activity(action === "update" ? "Updating flake inputs" : "Building", delay);
              if (action === "switch" || action === "update") {
                yield* lines(ui.heading(`Activating ${label}…`));
                yield* activity("Activating", delay);
              }
              yield* lines(
                ui.success(
                  action === "build"
                    ? "Built /nix/store/7z6x-preview-system"
                    : action === "test"
                      ? "Build successful — ready to switch."
                      : action === "dry-run"
                        ? "Dry-run complete."
                        : action === "update"
                          ? `Updated and switched ${label}.`
                          : `${label} switch complete.`,
                ),
              );
            }),
          platform === "macos" && (action === "switch" || action === "update")
            ? { input: "auth" }
            : {},
        ),
      );
    }
    previews.push(
      sample(
        "recover nix",
        (_empty, delay) =>
          Effect.gen(function* () {
            yield* lines(ui.heading(`Activating the recovered ${label} profile…`));
            yield* activity("Activating recovered profile", delay);
            yield* lines(
              ui.heading("Publishing the recovered Nix lock…"),
              ui.success("Nix recovery completed successfully."),
            );
          }),
        platform === "macos" ? { input: "auth" } : {},
      ),
    );
  }
  if (platform === "macos") {
    previews.push(
      sample("homebrew inventory", (_empty, delay) =>
        Effect.gen(function* () {
          yield* lines(ui.heading("Capturing Homebrew inventory…"));
          yield* activity("Publishing Homebrew inventory", delay);
          yield* printLockfilePush(machine, "homebrew-inventory", { hash: HASH, size: 1274 });
          yield* lines(ui.success("Homebrew inventory stored."));
        }),
      ),
    );
  }
  if (platform === "windows") {
    for (const backend of ["winget", "scoop"]) {
      for (const action of ["install", "uninstall"]) {
        previews.push(
          sample(`${backend} ${action}`, (_empty, delay) =>
            Effect.gen(function* () {
              yield* activity(
                `${backend} ${action} ${backend === "winget" ? "BurntSushi.ripgrep.MSVC" : "ripgrep"}`,
                delay,
              );
              yield* printLockfilePush(machine, "windows", { hash: HASH, size: 1274 });
            }),
          ),
        );
      }
    }
  }
  return previews;
}

function backupPreviews(platform: HostPlatform): OutputPreview[] {
  const { home } = previewPaths(platform);
  const previews: OutputPreview[] = [];
  if (platform !== "linux") {
    const settings = backupSettings(platform);
    const receipt: JobState = {
      version: 1,
      repository: settings.repository,
      hostname: settings.hostname,
      job: "documents",
      startedAt: DateTime.makeUnsafe(TIME),
      finishedAt: DateTime.makeUnsafe("2026-10-26T10:00:42Z"),
      outcome: "accepted-changed",
      acceptedAt: DateTime.makeUnsafe("2026-10-26T10:00:42Z"),
      current: { id: HASH, tree: "b".repeat(64), files: 2431, bytes: 187654321 },
      knownIds: [HASH],
    };
    for (const action of ["status", "run", "run-due", "accept"]) {
      previews.push(
        sample(
          `backups ${action}`,
          (empty) =>
            action === "accept"
              ? printBackupJson(JobState, receipt)
              : printBackupJson(Schema.Array(JobState), empty ? [] : [receipt]),
          action === "accept" ? {} : { empty: true },
        ),
      );
    }
    previews.push(
      sample("backups doctor", () =>
        json({
          platform: platform === "macos" ? "darwin" : "win32",
          bun: "1.4.4",
          hostname: settings.hostname,
          repository: settings.profile.repository,
          jobs: settings.jobs,
          jobPolicies: settings.jobPolicies,
          retentionDefaults: settings.profile.forget,
          sources: settings.sources,
          stateDirectory: settings.stateDirectory,
          logDirectory: settings.logDirectory,
          logFile: settings.logFile,
          credentials: settings.credentials,
          scheduleLabel: settings.scheduleLabel,
          alert: settings.alert,
          checkedAt: TIME,
          accessVerified: false,
          note: "Only Rustic traverses sources. Verify native credentials and source access through the real scheduled executable before cutover.",
        }),
      ),
      sample(
        "backups snapshots",
        (empty) =>
          printBackupJson(SnapshotGroups, [
            {
              snapshots: empty
                ? []
                : [
                    {
                      id: HASH,
                      tree: "b".repeat(64),
                      hostname: settings.hostname,
                      paths: [`${home}/Documents`],
                      tags: ["documents"],
                      time: DateTime.makeUnsafe(TIME),
                      summary: { total_files_processed: 2431, total_bytes_processed: 187654321 },
                    },
                  ],
            },
          ]),
        { empty: true },
      ),
      sample("backups check", (_empty, delay) =>
        Effect.gen(function* () {
          yield* lines("Checking repository metadata; this may take a while...");
          yield* activity("Checking repository metadata", delay);
          yield* lines(
            "Repository metadata check passed (42s). Use --read-data to verify file packs.",
          );
        }),
      ),
      sample("backups restore", () =>
        lines(
          `Restored ${HASH} to ${home}/Recovered Documents. Compare the recovered files before relying on this backup.`,
        ),
      ),
      sample(
        "backups maintenance",
        (empty) => json({ applied: false, removedSnapshots: empty ? [] : ["d".repeat(64)] }),
        { empty: true },
      ),
      sample(
        "backups secrets set",
        () => lines("Stored repository-password in the native credential store."),
        { input: "auth" },
      ),
      sample("backups secrets check", () =>
        lines(
          ...secretNames
            .filter((name) => name !== "alert-token")
            .map((name) => `${name}: available`),
        ),
      ),
      sample("backups schedule", () =>
        Console.log(
          platform === "windows"
            ? formatScheduledTask(
                `${home}/bin/outfitting-manager.exe`,
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                settings,
              )
            : formatLaunchAgent(`${home}/bin/outfitting-manager`, settings),
        ),
      ),
    );
  }
  return previews;
}
