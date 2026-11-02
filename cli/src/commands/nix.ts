import { Option } from "effect";
import { Command, Flag } from "effect/cli";

import { type HostPlatform, NIX_ACTIONS, type NixAction } from "@/platform";
import { updateNix } from "@/update/nix/run";

const noPushFlag = Flag.Boolean("no-push").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Skip publishing the Nix lock after a successful action."),
);

const noRefreshFlag = Flag.Boolean("no-refresh").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Use the local source without fetching remote changes."),
);

const profileFlag = Flag.String("profile").pipe(
  Flag.optional,
  Flag.withDescription("Override the platform profile selected in config.toml."),
);

const ifConfiguredFlag = Flag.Boolean("if-configured").pipe(
  Flag.withDefault(false),
  Flag.withDescription("On Linux, skip when the selected profile declares no Nix flake."),
);

const macosUpdateFlags = { noRefresh: noRefreshFlag, profile: profileFlag };
const linuxUpdateFlags = { ...macosUpdateFlags, ifConfigured: ifConfiguredFlag };

interface NixFlagValues {
  readonly noRefresh: boolean;
  readonly profile: Option.Option<string>;
  readonly ifConfigured?: boolean;
  readonly noPush?: boolean;
}

const runNix = (action: NixAction, values: NixFlagValues) =>
  updateNix({
    action,
    noPush: values.noPush,
    noRefresh: values.noRefresh,
    profile: Option.getOrUndefined(values.profile),
    ifConfigured: values.ifConfigured,
  });

const actionDescriptions = {
  build: {
    macos: "Build the nix-darwin system without activating.",
    linux: "Build the Home Manager activation package without activating.",
    nixos: "Build this host's NixOS system without activating.",
  },
  switch: {
    macos: "Build and activate the nix-darwin system.",
    linux: "Build and activate the selected Home Manager profile.",
    nixos: "Build and switch this host to its NixOS system.",
  },
  test: {
    macos: "Test-build the nix-darwin system without activating.",
    linux: "Test-build the Home Manager activation package without activating.",
    // Not switch-to-configuration test: nothing is activated.
    nixos: "Test-build this host's NixOS system without activating anything.",
  },
  "dry-run": {
    macos: "Dry-run the nix-darwin build without activating.",
    linux: "Dry-run the Home Manager build without activating.",
    nixos: "Dry-run this host's NixOS build without activating.",
  },
  update: {
    macos: "Update flake inputs, build, and activate the nix-darwin system.",
    linux: "Update flake inputs, build, and activate the Home Manager profile.",
    nixos: "Update flake inputs, build, and switch this host's NixOS system.",
  },
} as const satisfies Record<NixAction, Record<"macos" | "linux" | "nixos", string>>;

const nixDescriptions = {
  macos: "Build, test, dry-run, update, or activate the nix-darwin profile.",
  linux: "Build, test, dry-run, update, or activate the Home Manager profile.",
  nixos: "Build, test, dry-run, update, or switch this host's NixOS system.",
} as const;

/** Build, test, dry-run, update, or activate the configured Nix profile. */
export function makeNixCommand(platform: Extract<HostPlatform, "macos" | "linux" | "nixos">) {
  const updateFlags = platform === "linux" ? linuxUpdateFlags : macosUpdateFlags;
  const actionFlags = { ...updateFlags, noPush: noPushFlag };
  const actions = NIX_ACTIONS.filter(
    (action): action is Exclude<NixAction, "update"> => action !== "update",
  ).map((action) =>
    Command.make(action, actionFlags, (values) => runNix(action, values)).pipe(
      Command.withDescription(actionDescriptions[action][platform]),
    ),
  );
  const updateCommand = Command.make("update", updateFlags, (values) =>
    runNix("update", values),
  ).pipe(Command.withDescription(actionDescriptions.update[platform]));

  return Command.make("nix").pipe(
    Command.withDescription(nixDescriptions[platform]),
    Command.withSubcommands([...actions, updateCommand]),
  );
}
