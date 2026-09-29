import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { RunCommandResult } from "@/process";
import { buildNixSystem } from "@/update/nix/build";

const fakeRepo = {
  root: "/repo",
  contract: { schema: 1 as const, profiles: {} },
  flakePath: "/repo/system/macos",
  darwinNixPath: "/repo/system/macos/darwin.nix",
  flakeKind: "macos" as const,
  systemAttr: "darwinConfigurations.macos.system",
};

const fakeHomeManagerRepo = {
  root: "/repo",
  contract: { schema: 1 as const, profiles: {} },
  flakePath: "/repo/system/custom-linux",
  darwinNixPath: "",
  flakeKind: "home-manager" as const,
  systemAttr: "homeConfigurations.workstation.activationPackage",
  homeManagerName: "workstation",
};

describe("buildNixSystem", () => {
  test("passes remote lock flags and returns store path", async () => {
    const run = async (command: string, args: ReadonlyArray<string>): Promise<RunCommandResult> => {
      expect(command).toBe("nix");
      expect(args).toContain("build");
      expect(args).toContain("--impure");
      expect(args).toContain("--reference-lock-file");
      expect(args).toContain("/tmp/flake.lock");
      expect(args).toContain("--no-write-lock-file");
      expect(args.at(-1)).toBe("path:/repo/system/macos#darwinConfigurations.macos.system");
      return { code: 0, stdout: "/nix/store/abc-darwin-system\n", stderr: "" };
    };

    const path = await buildNixSystem({
      repo: fakeRepo,
      lockPath: "/tmp/flake.lock",
      mode: "build",
      run,
    });
    expect(path).toBe("/nix/store/abc-darwin-system");
  });

  test("dry-run omits print-out-paths and uses --dry-run", async () => {
    const run = async (
      _command: string,
      args: ReadonlyArray<string>,
    ): Promise<RunCommandResult> => {
      expect(args).toContain("--dry-run");
      expect(args).toContain("--no-write-lock-file");
      expect(args).not.toContain("--print-out-paths");
      expect(args).not.toContain("--reference-lock-file");
      return { code: 0, stdout: "", stderr: "" };
    };

    const path = await buildNixSystem({
      repo: fakeRepo,
      mode: "dry",
      run,
    });
    expect(path).toBe("");
  });

  test("fails when nix exits nonzero", async () => {
    const run = async (): Promise<RunCommandResult> => ({
      code: 1,
      stdout: "",
      stderr: "boom",
    });
    await expect(buildNixSystem({ repo: fakeRepo, mode: "build", run })).rejects.toThrow(
      /nix build failed/,
    );
  });

  test("builds the activation attribute declared by an arbitrary BYOR profile", async () => {
    const run = async (command: string, args: ReadonlyArray<string>): Promise<RunCommandResult> => {
      expect(command).toBe("nix");
      expect(args.at(-1)).toBe(
        "path:/repo/system/custom-linux#homeConfigurations.workstation.activationPackage",
      );
      return { code: 0, stdout: "/nix/store/hm-activation\n", stderr: "" };
    };

    const path = await buildNixSystem({
      repo: fakeHomeManagerRepo,
      mode: "build",
      run,
    });
    expect(path).toBe("/nix/store/hm-activation");
  });

  test("writes and verifies a separate lock for an update build", async () => {
    const root = await mkdtemp(join(tmpdir(), "outfitting-nix-build-lock-"));
    const referenceLockPath = join(root, "candidate.lock");
    const outputLockPath = join(root, "build.lock");
    const candidate = Buffer.from('{"version":7,"inputs":{}}\n');
    try {
      await writeFile(referenceLockPath, candidate);
      const run = async (
        command: string,
        args: ReadonlyArray<string>,
      ): Promise<RunCommandResult> => {
        expect(command).toBe("nix");
        expect(args).toContain("--reference-lock-file");
        expect(args).toContain(referenceLockPath);
        expect(args).toContain("--output-lock-file");
        expect(args).toContain(outputLockPath);
        expect(args).not.toContain("--no-write-lock-file");
        await writeFile(outputLockPath, candidate);
        return { code: 0, stdout: "/nix/store/updated-profile\n", stderr: "" };
      };

      await expect(
        buildNixSystem({
          repo: fakeHomeManagerRepo,
          lockPath: referenceLockPath,
          outputLockPath,
          mode: "build",
          run,
        }),
      ).resolves.toBe("/nix/store/updated-profile");
      expect(await readFile(outputLockPath)).toEqual(candidate);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses to return a build whose evaluated lock differs from its reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "outfitting-nix-build-lock-mismatch-"));
    const referenceLockPath = join(root, "candidate.lock");
    const outputLockPath = join(root, "build.lock");
    try {
      await writeFile(referenceLockPath, '{"version":7,"inputs":{}}\n');
      const run = async (): Promise<RunCommandResult> => {
        await writeFile(outputLockPath, '{"version":7,"inputs":{"nixpkgs":{}}}\n');
        return { code: 0, stdout: "/nix/store/updated-profile\n", stderr: "" };
      };

      await expect(
        buildNixSystem({
          repo: fakeHomeManagerRepo,
          lockPath: referenceLockPath,
          outputLockPath,
          mode: "build",
          run,
        }),
      ).rejects.toThrow(/refusing to activate or publish the update/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
