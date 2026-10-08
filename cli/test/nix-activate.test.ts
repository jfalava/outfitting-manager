import { expect, test, vi } from "vitest";

import type { runCommand } from "@/process";
import { activateNixSystem } from "@/update/nix/activate";

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
  expect(alert.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[1]!);
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
