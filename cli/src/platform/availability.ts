export type HostPlatform = "macos" | "windows" | "linux" | "nixos";

let compiledPlatform: HostPlatform | undefined;

/** Called once by a platform entrypoint whose platform the kernel cannot tell apart (NixOS). */
export function declareHostPlatform(platform: HostPlatform | undefined): void {
  compiledPlatform = platform;
}

/** The platform this binary was built for; defaults to the kernel's platform. */
export function hostPlatform(): HostPlatform {
  if (compiledPlatform !== undefined) {
    return compiledPlatform;
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  return process.platform === "win32" ? "windows" : "linux";
}

export const NIX_ACTIONS = ["build", "switch", "test", "dry-run", "update"] as const;
export type NixAction = (typeof NIX_ACTIONS)[number];

export function platformLabel(platform: HostPlatform | "all"): string {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    case "nixos":
      return "NixOS";
    case "all":
      return "all platforms";
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}
