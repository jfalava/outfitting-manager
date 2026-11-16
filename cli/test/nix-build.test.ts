import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { RunCommandOptions, RunCommandResult } from "@/process";
import { buildNixSystem, flakeRef } from "@/update/nix/build";
import { createNixBuildProgress } from "@/update/nix/progress";

function captureStream() {
  const chunks: string[] = [];
  const stream = {
    isTTY: false,
    write: (chunk: string) => chunks.push(chunk),
  } as unknown as NodeJS.WriteStream;
  // oxlint-disable-next-line no-control-regex -- strip picocolors styling from captured output.
  return { stream, output: () => chunks.join("").replace(/\u001b\[[0-9;]*m/g, "") };
}

const nixEvent = (event: Record<string, unknown>) => `@nix ${JSON.stringify(event)}`;
const drv = (name: string) => `/nix/store/${"a".repeat(32)}-${name}.drv`;

const fakeRepo = {
  root: "/repo",
  contract: { schema: 3 as const, profiles: {} },
  flakePath: "/repo/system/macos",
  darwinNixPath: "/repo/system/macos/darwin.nix",
  flakeKind: "macos" as const,
  systemAttr: "darwinConfigurations.macos.system",
};

const fakeHomeManagerRepo = {
  root: "/repo",
  contract: { schema: 3 as const, profiles: {} },
  flakePath: "/repo/system/custom-linux",
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
      stream: captureStream().stream,
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

  test("fails with Nix's own error from its event stream", async () => {
    const run = async (
      _command: string,
      args: ReadonlyArray<string>,
      options?: RunCommandOptions,
    ): Promise<RunCommandResult> => {
      expect(args).toContain("internal-json");
      options?.onStderrLine?.(
        nixEvent({ action: "msg", level: 0, msg: "error: Cannot build 'zed.drv'." }),
      );
      return { code: 1, stdout: "", stderr: "" };
    };
    const { stream } = captureStream();
    await expect(buildNixSystem({ repo: fakeRepo, mode: "build", run, stream })).rejects.toThrow(
      "nix build failed (exit 1): error: Cannot build 'zed.drv'.",
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
      stream: captureStream().stream,
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
          stream: captureStream().stream,
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
          stream: captureStream().stream,
        }),
      ).rejects.toThrow(/refusing to activate or publish the update/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("nix build progress", () => {
  test("logs slow builds and counts Nix's planned derivations, not its goal counter", () => {
    let now = 0;
    const { stream, output } = captureStream();
    const reported: Array<[number, number]> = [];
    const session = {
      phase: () => undefined,
      progress: (done: number, total: number) => reported.push([done, total]),
    };
    const progress = createNixBuildProgress({ stream, session, now: () => now });
    for (const event of [
      { action: "msg", level: 3, msg: "these 2 derivations will be built:" },
      { action: "msg", level: 3, msg: `  ${drv("etc")}` },
      { action: "start", id: 1, type: 104, level: 0, text: "" },
      { action: "start", id: 10, type: 105, level: 3, fields: [drv("etc"), "", 1, 1] },
      {
        action: "start",
        id: 11,
        type: 105,
        level: 3,
        fields: [drv("zed-editor-0.212.4"), "", 1, 1],
      },
    ]) {
      progress.feed(nixEvent(event));
    }
    now = 1_000;
    progress.feed(nixEvent({ action: "result", id: 1, type: 105, fields: [1, 3, 1, 0] }));
    progress.feed(nixEvent({ action: "stop", id: 10 }));
    now = 14_000;
    progress.feed(nixEvent({ action: "result", id: 1, type: 105, fields: [2, 3, 0, 0] }));
    progress.feed(nixEvent({ action: "stop", id: 11 }));
    progress.finish(true);

    expect(output().split("\n")).toEqual([
      "these 2 derivations will be built",
      "  ✓ Built zed-editor-0.212.4 · 14s",
      "✓ Built 2 derivations in 14s",
      "",
    ]);
    expect(reported.at(-1)).toEqual([2, 2]);
  });

  test("marks the failed build and stays silent about builds Nix cancels", () => {
    let now = 0;
    const { stream, output } = captureStream();
    const progress = createNixBuildProgress({ stream, now: () => now });
    for (const event of [
      { action: "start", id: 1, type: 104, level: 0, text: "" },
      {
        action: "start",
        id: 10,
        type: 105,
        level: 3,
        fields: [drv("zed-editor-0.212.4"), "", 1, 1],
      },
      { action: "start", id: 11, type: 105, level: 3, fields: [drv("gpui"), "", 1, 1] },
      { action: "result", id: 11, type: 104, fields: ["buildPhase"] },
    ]) {
      progress.feed(nixEvent(event));
    }
    now = 5_000;
    progress.feed(nixEvent({ action: "result", id: 1, type: 105, fields: [0, 3, 1, 1] }));
    progress.feed(nixEvent({ action: "stop", id: 11 }));
    progress.feed(nixEvent({ action: "stop", id: 10 }));
    progress.feed(nixEvent({ action: "msg", level: 0, msg: "error: Cannot build 'gpui.drv'." }));
    progress.finish(false);

    expect(output()).toBe("  ✗ gpui failed after 5s (buildPhase)\n");
    expect(progress.failureDetail()).toBe("error: Cannot build 'gpui.drv'.");
  });
  test("names input fetches, cache lookups and lock waits instead of calling it all evaluation", () => {
    let now = 0;
    const { stream, output } = captureStream();
    const phases: string[] = [];
    const session = { phase: (label: string) => phases.push(label), progress: () => undefined };
    const progress = createNixBuildProgress({ stream, session, now: () => now });
    const rev = "b134951a4c9f3c995fd7be05f3243f8ecd65d798";
    for (const event of [
      {
        action: "start",
        id: 1,
        type: 101,
        level: 4,
        text: `downloading 'https://github.com/NixOS/nixpkgs/archive/${rev}.tar.gz'`,
      },
      {
        action: "start",
        id: 2,
        type: 0,
        level: 3,
        text: `unpacking 'github:NixOS/nixpkgs/${rev}' into the Git cache`,
      },
      { action: "stop", id: 1 },
      { action: "stop", id: 2 },
      {
        action: "start",
        id: 3,
        type: 109,
        level: 4,
        text: "querying info about '/nix/store/x-zed' on 'https://cache.nixos.org'",
      },
      {
        action: "start",
        id: 4,
        type: 101,
        level: 4,
        text: "downloading 'https://cache.nixos.org/x.narinfo'",
      },
      { action: "stop", id: 4 },
      { action: "stop", id: 3 },
      {
        action: "start",
        id: 5,
        type: 111,
        level: 1,
        text: `waiting for lock on \u001b[35;1m'${drv("zed-editor-0.212.4").replace(/\.drv$/, "")}'\u001b[0m`,
      },
    ]) {
      progress.feed(nixEvent(event));
    }
    now = 12_000;
    progress.feed(nixEvent({ action: "stop", id: 5 }));
    progress.finish(true);

    expect(phases).toEqual([
      "Fetching flake inputs",
      "Evaluating",
      "Checking binary cache",
      "Evaluating",
      "Waiting for another Nix process",
      "Evaluating",
    ]);
    expect(output()).toBe("✓ Already built by another Nix process (waited 12s)\n");
  });
});

describe("NixOS flake reference", () => {
  const nixosRepo = {
    root: "/repo",
    contract: { schema: 3 as const, profiles: {} },
    flakePath: "/repo/system/oci-box",
    flakeKind: "nixos" as const,
    systemAttr: "nixosConfigurations.box.config.system.build.toplevel",
    nixosName: "box",
  };

  // System flakes import siblings such as ../../packages; a path: ref to the flake
  // directory alone would copy only that directory and break those imports.
  test("addresses the flake inside its git checkout or sparse source root", () => {
    expect(flakeRef(nixosRepo, (path) => path === "/repo/.git")).toBe(
      "git+file:/repo?dir=system/oci-box#nixosConfigurations.box.config.system.build.toplevel",
    );
    expect(flakeRef(nixosRepo, () => false)).toBe(
      "path:/repo?dir=system/oci-box#nixosConfigurations.box.config.system.build.toplevel",
    );
    expect(flakeRef(fakeHomeManagerRepo, () => true)).toBe(
      "path:/repo/system/custom-linux#homeConfigurations.workstation.activationPackage",
    );
  });
});
