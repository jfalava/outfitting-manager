import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "@/config/load";

/** Validate and atomically publish a new config or replace the reviewed existing version. */
export async function publishValidatedConfig(
  stateRoot: string,
  target: string,
  serialized: string,
  options?: { expectedExistingContents?: string },
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.outfitting-config-${randomUUID()}.toml`);
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const verified = await loadConfig({ stateRoot, configPath: temporary });
    if (verified.declarations === undefined || verified.source === undefined) {
      throw new Error("Generated config.toml failed validation before publication.");
    }

    if (options?.expectedExistingContents === undefined) {
      await link(temporary, target);
      return;
    }

    const targetStat = await lstat(target);
    if (!targetStat.isFile()) {
      throw new Error(`Refusing to replace non-regular config file ${target}.`);
    }
    const existingContents = await readFile(target, "utf8");
    if (existingContents !== options.expectedExistingContents) {
      throw new Error(
        `Config changed while the wizard was open. Run the wizard again to reload it.`,
      );
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
