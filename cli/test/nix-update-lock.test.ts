import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import type { RunCommandOptions, RunCommandResult } from "@/process";
import { updateNixLock } from "@/update/nix/update-lock";

const repo = {
  root: "/repo",
  contract: { schema: 1 as const, profiles: {} },
  flakePath: "/repo/system/home",
  darwinNixPath: "",
  flakeKind: "home-manager" as const,
  systemAttr: "homeConfigurations.work.activationPackage",
  homeManagerName: "work",
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("updates all flake inputs from the selected lock into a separate candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "outfitting-nix-update-lock-"));
  temporaryRoots.push(root);
  const referenceLockPath = join(root, "remote.lock");
  const outputLockPath = join(root, "updated.lock");
  await writeFile(referenceLockPath, '{"version":7}\n');
  vi.stubEnv("NIX_PATH", "/must/not/be/inherited");

  let invocation:
    | {
        command: string;
        args: ReadonlyArray<string>;
        options: RunCommandOptions;
      }
    | undefined;
  const run = async (
    command: string,
    args: ReadonlyArray<string>,
    options?: RunCommandOptions,
  ): Promise<RunCommandResult> => {
    invocation = { command, args, options: options ?? {} };
    await writeFile(outputLockPath, '{"version":7,"inputs":{}}\n');
    return { code: 0, stdout: "", stderr: "" };
  };

  await updateNixLock({ repo, referenceLockPath, outputLockPath, run });

  expect(invocation).toMatchObject({
    command: "nix",
    args: [
      "flake",
      "update",
      "--impure",
      "--reference-lock-file",
      referenceLockPath,
      "--output-lock-file",
      outputLockPath,
    ],
    options: {
      cwd: repo.flakePath,
      env: { OUTFITTING_REPO: repo.root },
    },
  });
  expect(invocation?.options.env).not.toHaveProperty("NIX_PATH");
  expect(await readFile(outputLockPath, "utf8")).toContain('"inputs"');
});

test("bootstraps without an existing lock and rejects a successful command with no output file", async () => {
  const root = await mkdtemp(join(tmpdir(), "outfitting-nix-update-bootstrap-"));
  temporaryRoots.push(root);
  const outputLockPath = join(root, "updated.lock");
  let argsCaptured: ReadonlyArray<string> = [];
  const run = async (_command: string, args: ReadonlyArray<string>): Promise<RunCommandResult> => {
    argsCaptured = args;
    return { code: 0, stdout: "", stderr: "" };
  };

  await expect(updateNixLock({ repo, outputLockPath, run })).rejects.toThrow(
    /produced no candidate flake\.lock/,
  );
  expect(argsCaptured).not.toContain("--reference-lock-file");
});

test("reports a failed flake update without accepting a partial lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "outfitting-nix-update-failed-"));
  temporaryRoots.push(root);
  const outputLockPath = join(root, "updated.lock");
  const run = async (): Promise<RunCommandResult> => ({ code: 1, stdout: "", stderr: "failed" });

  await expect(updateNixLock({ repo, outputLockPath, run })).rejects.toThrow(
    /nix flake update failed \(exit 1\)/,
  );
});
