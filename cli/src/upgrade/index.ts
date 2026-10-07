import { Console, Effect } from "effect";

import { toError } from "@/effect";
import { ui } from "@/ui";
import { installReleaseEffect } from "@/upgrade/install";
import { assetNameFor, executableNameFor, executablePath } from "@/upgrade/platform";
import { latestCliReleaseEffect } from "@/upgrade/release";
import { isNewerVersion } from "@/upgrade/version";

export { checksumFromFile } from "@/upgrade/install";
export { downloadBytes } from "@/upgrade/install";
export { downloadBytesEffect, installReleaseEffect } from "@/upgrade/install";
export { assetNameFor, executableNameFor, executablePath } from "@/upgrade/platform";
export { extractZipBinary } from "@/upgrade/archive";
export { latestCliRelease } from "@/upgrade/release";
export { latestCliReleaseEffect } from "@/upgrade/release";
export { isNewerVersion, parseCliVersion } from "@/upgrade/version";

export const upgrade = (currentVersion: string) =>
  Effect.gen(function* () {
    const targetPath = yield* Effect.try({
      try: executablePath,
      catch: toError,
    });
    const assetName = yield* Effect.try({ try: assetNameFor, catch: toError });
    const executableName = yield* Effect.try({ try: executableNameFor, catch: toError });
    const release = yield* latestCliReleaseEffect(assetName, executableName);

    if (!isNewerVersion(release.version, currentVersion)) {
      yield* Console.log(ui.success(`outfitting-manager ${currentVersion} is already up to date.`));
      return;
    }

    yield* Console.log(`Updating outfitting-manager ${currentVersion} → ${release.version}…`);
    yield* installReleaseEffect(release, targetPath);
    const suffix = process.platform === "win32" ? " and will be active on the next run" : "";
    yield* Console.log(ui.success(`Installed outfitting-manager ${release.version}${suffix}.`));
  });
