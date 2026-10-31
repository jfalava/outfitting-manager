import { Console, Effect } from "effect";

import { toError } from "@/effect";
import { ui } from "@/ui";
import { installReleaseEffect } from "@/upgrade/install";
import { executablePath, releaseAssetFor } from "@/upgrade/platform";
import { latestCliReleaseEffect } from "@/upgrade/release";
import { isNewerVersion } from "@/upgrade/version";

export const upgrade = (currentVersion: string) =>
  Effect.gen(function* () {
    const targetPath = yield* Effect.try({ try: executablePath, catch: toError });
    const asset = yield* Effect.try({ try: releaseAssetFor, catch: toError });
    const release = yield* latestCliReleaseEffect(asset.archive, asset.executable);
    const newer = yield* Effect.try({
      try: () => isNewerVersion(release.version, currentVersion),
      catch: toError,
    });

    if (!newer) {
      yield* Console.log(ui.success(`outfitting-manager ${currentVersion} is already up to date.`));
      return;
    }

    yield* Console.log(`Updating outfitting-manager ${currentVersion} → ${release.version}…`);
    yield* installReleaseEffect(release, targetPath);
    const suffix = process.platform === "win32" ? " and will be active on the next run" : "";
    yield* Console.log(ui.success(`Installed outfitting-manager ${release.version}${suffix}.`));
  });
