import { describe, expect, test, vi } from "vitest";

import type { runCommand } from "@/process";
import { activateNixos, activateNixSystem, NIXOS_SWITCH_APPROVAL } from "@/update/nix/activate";

function commandResult(code: number) {
  return { code, stdout: "", stderr: "" };
}

test("alerts before interactive nix-darwin activation when sudo credentials are unavailable", async () => {
  const run = vi
    .fn<typeof runCommand>()
    .mockResolvedValueOnce(commandResult(1))
    .mockResolvedValue(commandResult(0));
  const alert = vi.fn();

  await activateNixSystem({
    systemConfig: "/nix/store/system",
    run,
    alert,
    user: "test-user",
  });

  expect(run).toHaveBeenNthCalledWith(1, "sudo", ["-n", "-v"], { inherit: false });
  expect(alert).toHaveBeenCalledExactlyOnceWith("password-required");
  expect(run).toHaveBeenNthCalledWith(
    2,
    "sudo",
    [
      "-H",
      "env",
      "HOME=/var/root",
      "NIX_PATH=",
      "nix-env",
      "-p",
      "/nix/var/nix/profiles/system",
      "--set",
      "/nix/store/system",
    ],
    expect.objectContaining({ inherit: true }),
  );
});

test("does not alert when sudo credentials are already available", async () => {
  const run = vi.fn<typeof runCommand>().mockResolvedValue(commandResult(0));
  const alert = vi.fn();
  const resume = vi.fn();

  await activateNixSystem({ systemConfig: "/nix/store/system", run, alert, resume });

  expect(alert).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

test("resumes only after the first privileged command succeeds, before activation", async () => {
  const events: string[] = [];
  const run = vi.fn<typeof runCommand>().mockImplementation(async (_command, args) => {
    events.push(args[0] === "-n" ? "check" : args.includes("nix-env") ? "set-profile" : "activate");
    return commandResult(args[0] === "-n" ? 1 : 0);
  });

  await activateNixSystem({
    systemConfig: "/nix/store/system",
    run,
    alert: () => events.push("blocked"),
    resume: () => events.push("resumed"),
  });

  expect(events).toEqual(["check", "blocked", "set-profile", "resumed", "activate"]);
});

test.each(["exit", "spawn"])(
  "failed authentication/profile setting (%s) does not resume or activate",
  async (failure) => {
    const run = vi.fn<typeof runCommand>().mockResolvedValueOnce(commandResult(1));
    if (failure === "spawn") {
      run.mockRejectedValueOnce(new Error("sudo could not start"));
    } else {
      run.mockResolvedValueOnce(commandResult(7));
    }
    const resume = vi.fn();

    await expect(
      activateNixSystem({ systemConfig: "/nix/store/system", run, alert: vi.fn(), resume }),
    ).rejects.toThrow(
      failure === "spawn" ? "sudo could not start" : "nix-env --set failed (exit 7)",
    );
    expect(resume).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
  },
);

describe("activateNixos", () => {
  const system = "/nix/store/abc-nixos-system-box";
  const exists = async () => true;

  test("approves the exact system, sets the profile, then switches in a transient unit", async () => {
    const calls: string[][] = [];
    const recorded: string[] = [];
    const run = vi.fn<typeof runCommand>().mockImplementation(async (command, args) => {
      calls.push([command, ...args]);
      return commandResult(0);
    });

    await activateNixos({
      systemConfig: system,
      run,
      exists,
      record: async (path) => {
        recorded.push(path);
      },
    });

    const approval = calls.findIndex((call) => call.includes("sh"));
    const profile = calls.findIndex((call) => call.includes("nix-env"));
    const switching = calls.findIndex((call) => call.includes("systemd-run"));
    expect(approval).toBeGreaterThan(-1);
    // The pre-switch check compares the approval with $1, so it must carry the incoming path.
    expect(calls[approval]).toContain(system);
    expect(calls[approval]!.join(" ")).toContain(NIXOS_SWITCH_APPROVAL);
    expect(approval).toBeLessThan(profile);
    expect(profile).toBeLessThan(switching);
    expect(calls[switching]).toEqual(
      expect.arrayContaining([
        "--wait",
        "--pipe",
        `${system}/bin/switch-to-configuration`,
        "switch",
      ]),
    );
    expect(recorded).toEqual([system]);
  });

  test("drops the approval and records nothing when the switch fails", async () => {
    const calls: string[][] = [];
    const recorded: string[] = [];
    const run = vi.fn<typeof runCommand>().mockImplementation(async (command, args) => {
      calls.push([command, ...args]);
      return commandResult(args.includes("systemd-run") ? 1 : 0);
    });

    await expect(
      activateNixos({
        systemConfig: system,
        run,
        exists,
        record: async (path) => {
          recorded.push(path);
        },
      }),
    ).rejects.toThrow("switch-to-configuration switch failed (exit 1)");
    expect(calls.at(-1)).toEqual(["sudo", "rm", "-f", NIXOS_SWITCH_APPROVAL]);
    expect(recorded).toEqual([]);
  });

  test("refuses a build that is not a NixOS system before any sudo", async () => {
    const run = vi.fn<typeof runCommand>().mockResolvedValue(commandResult(0));
    await expect(
      activateNixos({ systemConfig: "/nix/store/hm-activation", run, exists: async () => false }),
    ).rejects.toThrow("is not a NixOS system build");
    expect(run).not.toHaveBeenCalled();
  });
});
