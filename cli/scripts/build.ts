// Host build: runs the build:<target> script for the release asset `upgrade` would install
// on this host, so the per-target entrypoints live only in package.json.
import { releaseAssetFor } from "@/upgrade/platform";

const target = releaseAssetFor()
  .archive.replace(/^outfitting-manager-/, "")
  .replace(/\.zip$/, "");
const build = Bun.spawnSync([process.execPath, "run", `build:${target}`], {
  cwd: import.meta.dir,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(build.exitCode);
