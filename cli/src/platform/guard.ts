import {
  checkNixosHost,
  defaultNixosHostProbe,
  isNixosOsRelease,
  type NixosHostProbe,
} from "@/platform/nixos";

/**
 * Invocations that must work on a mismatched host: help and version output, `debug`
 * (which reports the checks), and `self-update`, which installs the build matching this OS.
 */
function bypassesHostGuard(args: ReadonlyArray<string>): boolean {
  // Skip global flag values such as `--config <path>` to find the command name.
  const first = args.find(
    (arg, index) => !arg.startsWith("-") && !["--config", "--log-level"].includes(args[index - 1]!),
  );
  return (
    args.length === 0 ||
    args.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg)) ||
    first === "debug" ||
    first === "self-update" ||
    first === "upgrade"
  );
}

/**
 * Refuse to run a platform build on the wrong Linux host: the NixOS build needs NixOS
 * with nix-ld and its libraries; the Linux build must not drive a NixOS host.
 * Returns the failure message, or undefined when the command may run.
 */
export function hostGuardFailure(
  build: "linux" | "nixos",
  args: ReadonlyArray<string>,
  probe: NixosHostProbe = defaultNixosHostProbe,
): string | undefined {
  if (bypassesHostGuard(args)) {
    return undefined;
  }
  if (build === "linux") {
    return isNixosOsRelease(probe.readOsRelease())
      ? "This host runs NixOS; the linux build of outfitting-manager does not manage NixOS. Run `outfitting-manager self-update` to install the NixOS build."
      : undefined;
  }
  return checkNixosHost(probe).find((check) => !check.ok)?.detail;
}
