import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { loadConfig } from "@/config/load";

/**
 * Stage `serialized` beside `target`, validate the staged file, then publish it atomically.
 * Without `expectedExistingContents` the target must not exist yet; with it, the target is
 * replaced only while it still holds exactly the reviewed contents.
 */
export async function publishFileAtomically(options: {
  target: string;
  serialized: string;
  mode: number;
  expectedExistingContents: string | undefined;
  validate: (staged: string) => Promise<void>;
}): Promise<void> {
  const { target, expectedExistingContents } = options;
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, options.serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: options.mode,
    });
    await options.validate(temporary);

    if (expectedExistingContents === undefined) {
      await link(temporary, target);
      return;
    }
    if (!(await lstat(target)).isFile()) {
      throw new Error(`Refusing to replace non-regular file ${target}.`);
    }
    if ((await readFile(target, "utf8")) !== expectedExistingContents) {
      throw new Error(`${target} changed while it was under review. Run the command again.`);
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Validate and atomically publish a new config or replace the reviewed existing version. */
export function publishValidatedConfig(
  stateRoot: string,
  target: string,
  serialized: string,
  options?: { expectedExistingContents?: string },
): Promise<void> {
  return publishFileAtomically({
    target,
    serialized,
    mode: 0o600,
    expectedExistingContents: options?.expectedExistingContents,
    validate: async (staged) => {
      const verified = await loadConfig({ stateRoot, configPath: staged });
      if (verified.declarations === undefined || verified.source === undefined) {
        throw new Error("Generated config.toml failed validation before publication.");
      }
    },
  });
}
