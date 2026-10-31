export type HostPlatform = "macos" | "windows" | "linux";

/** The platform this process runs on. */
export function hostPlatform(): HostPlatform {
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
    case "all":
      return "all platforms";
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}
