import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Console, Data, Effect } from "effect";

import { loadConfig, type ManagerConfig } from "@/config";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { runCommand } from "@/process";
import { pushLockfile } from "@/sync";
import { isGitTrackedFile } from "@/sync/files";
import { ui } from "@/ui";

export const HOMEBREW_INVENTORY_KIND = "homebrew-inventory";
export const HOMEBREW_INVENTORY_HEADER = "outfitting-homebrew-inventory-v1";

class HomebrewInventoryError extends Data.TaggedError("HomebrewInventoryError")<{
  readonly message: string;
}> {}

function sortLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .toSorted((a, b) => a.localeCompare(b, "en"))
    .join("\n");
}

export const captureHomebrewInventory = Effect.fn("captureHomebrewInventory")(function* (
  run: typeof runCommand = runCommand,
) {
  const [taps, formulae, casks] = yield* Effect.all(
    [
      tryPromise(() => run("brew", ["tap"], { inherit: false })),
      tryPromise(() => run("brew", ["list", "--formula", "--versions"], { inherit: false })),
      tryPromise(() => run("brew", ["list", "--cask", "--versions"], { inherit: false })),
    ],
    { concurrency: "unbounded" },
  );

  for (const result of [taps, formulae, casks]) {
    if (result.code !== 0) {
      return yield* new HomebrewInventoryError({
        message:
          `Failed to capture Homebrew inventory (exit ${result.code}): ${result.stderr || result.stdout}`.trim(),
      });
    }
  }

  return [
    HOMEBREW_INVENTORY_HEADER,
    "",
    "[taps]",
    sortLines(taps.stdout),
    "",
    "[formulae]",
    sortLines(formulae.stdout),
    "",
    "[casks]",
    sortLines(casks.stdout),
    "",
  ].join("\n");
});

export interface PushHomebrewInventoryOptions {
  config?: ManagerConfig;
  run?: typeof runCommand;
  noPush?: boolean;
}

/** Always persist observed inventory locally; optionally upload the same file. */
export const pushHomebrewInventory = (options: PushHomebrewInventoryOptions = {}) =>
  Effect.gen(function* () {
    const run = options.run ?? runCommand;
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));

    yield* Console.log(ui.heading("Capturing Homebrew inventory…"));
    const body = yield* captureHomebrewInventory(run);

    const inventoryPath = join(config.stateRoot, "homebrew-inventory.txt");
    if (!options.noPush && (yield* tryPromise(() => isGitTrackedFile(inventoryPath)))) {
      return yield* new CliFailure({
        message: `Refusing to upload Git-tracked inventory: ${inventoryPath}.`,
      });
    }
    const staging = yield* tryPromise(async () => {
      await mkdir(config.stateRoot, { recursive: true });
      return mkdtemp(join(config.stateRoot, ".outfitting-homebrew-"));
    });
    try {
      const snapshot = join(staging, "upload.txt");
      yield* tryPromise(async () => {
        await writeFile(snapshot, body, { encoding: "utf8", mode: 0o600 });
        await writeFile(join(staging, "local.txt"), body, { encoding: "utf8", mode: 0o600 });
        await rename(join(staging, "local.txt"), inventoryPath);
      });
      if (!options.noPush) {
        yield* Console.log(ui.muted(`Pushing ${config.machineId}/${HOMEBREW_INVENTORY_KIND}…`));
        yield* pushLockfile({
          machine: config.machineId,
          kind: HOMEBREW_INVENTORY_KIND,
          path: snapshot,
        });
      }
    } finally {
      yield* tryPromise(() => rm(staging, { recursive: true, force: true }));
    }
    yield* Console.log(ui.success("Homebrew inventory stored."));
  });
