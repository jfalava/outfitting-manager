import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { parseOsRelease } from "@/platform/linux";

/** Libraries Bun.secrets dlopens on first keyring use; nix-ld must provide them. */
const NIX_LD_LIBRARIES = ["libsecret-1.so.0", "libglib-2.0.so.0"] as const;
/** nix-ld's built-in library directory when NIX_LD_LIBRARY_PATH is unset (systemd units). */
const NIX_LD_DEFAULT_LIBRARY_DIR = "/run/current-system/sw/share/nix-ld/lib";

export interface NixosHostProbe {
  readOsRelease: () => string | undefined;
  /** Fully resolved target of the generic glibc loader path, or undefined when absent. */
  resolveLoader: () => string | undefined;
  libraryDirs: () => string[];
  fileExists: (path: string) => boolean;
}

export interface NixosHostCheck {
  name: "os" | "nix-ld" | "libraries";
  ok: boolean;
  detail: string;
}

function loaderPath(arch = process.arch): string {
  return arch === "arm64" ? "/lib/ld-linux-aarch64.so.1" : "/lib64/ld-linux-x86-64.so.2";
}

export const defaultNixosHostProbe: NixosHostProbe = {
  readOsRelease: () => {
    try {
      return readFileSync("/etc/os-release", "utf8");
    } catch {
      return undefined;
    }
  },
  resolveLoader: () => {
    try {
      return realpathSync(loaderPath());
    } catch {
      return undefined;
    }
  },
  libraryDirs: () => {
    const configured = process.env["NIX_LD_LIBRARY_PATH"]?.split(":").filter(Boolean) ?? [];
    return configured.length > 0 ? configured : [NIX_LD_DEFAULT_LIBRARY_DIR];
  },
  fileExists: existsSync,
};

/** Whether /etc/os-release identifies NixOS. */
export function isNixosOsRelease(content: string | undefined): boolean {
  return content !== undefined && parseOsRelease(content)["ID"]?.toLowerCase() === "nixos";
}

/** Whether this Linux host runs NixOS; always false on other kernels. */
export function isNixosHost(probe: NixosHostProbe = defaultNixosHostProbe): boolean {
  return process.platform === "linux" && isNixosOsRelease(probe.readOsRelease());
}

/** Check that the NixOS build runs on NixOS through a nix-ld that supplies its libraries. */
export function checkNixosHost(probe: NixosHostProbe = defaultNixosHostProbe): NixosHostCheck[] {
  const os = isNixosOsRelease(probe.readOsRelease());
  const loader = probe.resolveLoader();
  const nixLd = loader !== undefined && /^\/nix\/store\/[^/]+-nix-ld-[^/]+\//.test(loader);
  const dirs = probe.libraryDirs();
  const missing = NIX_LD_LIBRARIES.filter(
    (library) => !dirs.some((dir) => probe.fileExists(join(dir, library))),
  );
  return [
    {
      name: "os",
      ok: os,
      detail: os
        ? "/etc/os-release identifies NixOS"
        : "This is the NixOS build of outfitting-manager, but /etc/os-release does not identify NixOS. Install the linux build.",
    },
    {
      name: "nix-ld",
      ok: nixLd,
      detail: nixLd
        ? `${loaderPath()} resolves to ${loader}`
        : `${loaderPath()} does not resolve to nix-ld${loader === undefined ? "" : ` (${loader})`}. Enable programs.nix-ld.`,
    },
    {
      name: "libraries",
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `nix-ld provides ${NIX_LD_LIBRARIES.join(", ")} from ${dirs.join(":")}`
          : `nix-ld does not provide ${missing.join(", ")} in ${dirs.join(":")}. Add glib and libsecret to programs.nix-ld.libraries.`,
    },
  ];
}
