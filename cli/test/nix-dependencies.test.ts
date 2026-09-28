import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { discoverNixSourcePaths, missingSourcePathFromNixError } from "@/source/nix-dependencies";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "outfitting-nix-dependencies-"));
  temporaryRoots.push(root);
  return root;
}

async function write(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Nix source dependency discovery", () => {
  test("follows reachable Nix files and suggests out-of-flake paths only", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "system/oci-agents/home.nix",
      `let
  repoFromEnvironment = builtins.getEnv "OUTFITTING_REPO";
  outfittingRepo =
    if repoFromEnvironment != "" then
      repoFromEnvironment
    else
      "/repo";
in {
  imports = [ ./agents.nix ];
  programs.common = (builtins.toPath "\${outfittingRepo}/packages/common/programs.nix");
}
`,
    );
    await write(
      root,
      "system/oci-agents/agents.nix",
      `{
  source = "\${outfittingRepo}/system/common/zsh";
  shell = ../../dotfiles/shell.rc;
}
`,
    );
    await write(
      root,
      "packages/common/programs.nix",
      `{ imports = [ ../../system/common/zsh.nix ]; }
`,
    );
    await write(
      root,
      "system/common/zsh.nix",
      `let
  repoFromEnvironment = builtins.getEnv "OUTFITTING_REPO";
  outfittingRepo = if repoFromEnvironment != "" then repoFromEnvironment else "/repo";
in { source = "\${outfittingRepo}/system/common/zsh"; }
`,
    );
    await write(root, "system/common/zsh/oci.plugin.zsh", "# shell config\n");
    await write(root, "dotfiles/shell.rc", "# shell config\n");

    const paths = await discoverNixSourcePaths({
      root,
      flake: "system/oci-agents",
      declaredPaths: ["packages/common"],
    });

    expect(paths).toContain("system/common/zsh.nix");
    expect(paths).toContain("system/common/zsh");
    expect(paths).toContain("dotfiles/shell.rc");
    expect(paths).not.toContain("system/oci-agents/agents.nix");
    expect(paths).not.toContain("packages/common/programs.nix");
  });

  test("retains missing paths as remote-source suggestions", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "system/oci-agents/home.nix",
      `let
  outfittingRepo = builtins.getEnv "OUTFITTING_REPO";
in { file = "\${outfittingRepo}/packages/private/config.nix"; }
`,
    );

    await expect(discoverNixSourcePaths({ root, flake: "system/oci-agents" })).resolves.toContain(
      "packages/private/config.nix",
    );
  });
});

describe("missing Nix source path parsing", () => {
  test("maps only absolute missing paths contained by the sparse source root", async () => {
    const root = await temporaryRoot();
    const missing = join(root, "packages", "common", "programs.nix");
    const outside = join(root, "..", "store", "unrelated.nix");

    expect(
      missingSourcePathFromNixError(
        `path '${outside}' does not exist\npath '${missing}' does not exist`,
        root,
      ),
    ).toBe("packages/common/programs.nix");
    expect(missingSourcePathFromNixError("path 'relative/file.nix' does not exist", root)).toBe(
      undefined,
    );
  });
});
