import { Console, Effect } from "effect";

import { loadConfig, type ManagerConfig } from "@/config";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { runCommand, which } from "@/process";
import { ui } from "@/ui";
import { runScoopCommand } from "@/update/scoop-command";
import { parseScoopExport, type ScoopExportState } from "@/update/scoop-export";
import {
  publishWindowsLock,
  recordWindowsOperation,
  scoopPackageName,
} from "@/update/windows-lock";

export interface ScoopBucket {
  name: string;
  url: string;
}

export interface ScoopManifest {
  buckets: ScoopBucket[];
  packages: string[];
}

/** Compare bucket sources without trailing slashes or a `.git` suffix. */
export function normalizeBucketUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

function bucketNameFromUrl(value: string): string | undefined {
  const segments = normalizeBucketUrl(value)
    .split("/")
    .filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const name = last.replace(/^scoop-/i, "");
  return name.length > 0 ? name : undefined;
}

/** Parse the repository-owned Scoop desired-state manifest. */
export function parseScoopManifest(content: string): ScoopManifest {
  const buckets: ScoopBucket[] = [];
  const packages: string[] = [];
  const bucketNames = new Set<string>();
  const packageNames = new Set<string>();
  const invalid: string[] = [];

  content.split(/\r?\n/).forEach((raw, index) => {
    const entry = raw.trim();
    if (entry.length === 0 || entry.startsWith("#")) {
      return;
    }

    const bucket = /^bucket\s+"([^"\r\n]*\S[^"\r\n]*)"$/i.exec(entry);
    if (bucket?.[1] !== undefined) {
      const url = bucket[1].trim();
      const name = bucketNameFromUrl(url);
      if (name === undefined || bucketNames.has(name.toLowerCase())) {
        invalid.push(`line ${index + 1}: invalid or duplicate bucket '${url}'`);
        return;
      }
      bucketNames.add(name.toLowerCase());
      buckets.push({ name, url });
      return;
    }

    const packageMatch = /^package\s+"([^"\r\n]*\S[^"\r\n]*)"$/i.exec(entry);
    if (packageMatch?.[1] !== undefined) {
      const packageSpec = packageMatch[1].trim();
      const name = scoopPackageName(packageSpec);
      if (packageNames.has(name.toLowerCase())) {
        invalid.push(`line ${index + 1}: invalid or duplicate package '${packageSpec}'`);
        return;
      }
      packageNames.add(name.toLowerCase());
      packages.push(packageSpec);
      return;
    }

    invalid.push(`line ${index + 1}: ${entry}`);
  });

  if (invalid.length > 0) {
    throw new Error(`Invalid Scoop manifest entries: ${invalid.join("; ")}`);
  }
  return { buckets, packages };
}

/** Read installed Scoop apps and buckets from `scoop export`. */
export async function scoopExport(
  run: typeof runCommand,
  scoopPath: string,
): Promise<ScoopExportState> {
  const result = await runScoopCommand(run, scoopPath, ["export"], { inherit: false });
  if (result.code !== 0) {
    throw new CliFailure({
      message:
        `scoop export failed (exit ${result.code}): ${result.stderr || result.stdout}`.trim(),
    });
  }
  return parseScoopExport(result.stdout);
}

const requireScoopCommand = Effect.fn("requireScoopCommand")(function* (
  run: typeof runCommand,
  scoopPath: string,
  args: ReadonlyArray<string>,
  label: string,
) {
  const result = yield* tryPromise(() => runScoopCommand(run, scoopPath, args, { inherit: true }));
  if (result.code !== 0) {
    return yield* new CliFailure({
      message: `${label} failed (exit ${result.code}): ${result.stderr || result.stdout}`.trim(),
    });
  }
  return result;
});

const updateAndCleanScoop = Effect.fn("updateAndCleanScoop")(function* (
  run: typeof runCommand,
  scoopPath: string,
) {
  yield* requireScoopCommand(run, scoopPath, ["update"], "scoop update");
  yield* requireScoopCommand(run, scoopPath, ["update", "*"], "scoop update *");
  yield* requireScoopCommand(run, scoopPath, ["cleanup", "*"], "scoop cleanup *");
});

export interface UpdateScoopOptions {
  config?: ManagerConfig;
  noPush?: boolean;
  scoopPath?: string;
  run?: typeof runCommand;
  which?: typeof which;
}

/** Upgrade only packages already installed through Scoop. */
export const updateScoop = (options: UpdateScoopOptions = {}) =>
  Effect.gen(function* () {
    const run = options.run ?? runCommand;
    const whichFn = options.which ?? which;
    const scoopPath = options.scoopPath ?? (yield* tryPromise(() => whichFn("scoop")));
    if (scoopPath === undefined) {
      return yield* new CliFailure({ message: "Scoop is not installed or not in PATH." });
    }

    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    yield* Console.log(ui.heading("Updating installed Scoop packages…"));
    yield* updateAndCleanScoop(run, scoopPath);
    yield* tryPromise(() =>
      recordWindowsOperation({
        config,
        manager: "scoop",
        action: "upgrade",
        name: "*",
        args: ["update", "*"],
        status: "success",
        exitCode: 0,
      }),
    );
    yield* publishWindowsLock(config, options.noPush);
    yield* Console.log(ui.success("Installed Scoop packages updated."));
  });
