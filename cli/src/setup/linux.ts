import { runSetup, type SetupOptions } from "@/setup/run";

export interface LinuxInitOptions extends SetupOptions {
  profile?: string;
}

/** Prepare Linux state and validate its configured source. */
export const runLinuxInit = ({ profile, ...options }: LinuxInitOptions) =>
  runSetup({
    ...options,
    platform: "linux",
    repoProfile: profile,
    nextCommand:
      "Next: outfitting-manager apply --no-refresh --if-configured, then outfitting-manager nix switch --no-refresh --if-configured",
  });
