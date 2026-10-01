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
});

test("does not alert when sudo credentials are already available", async () => {
  const run = vi.fn<typeof runCommand>().mockResolvedValue(commandResult(0));
  const alert = vi.fn();

  await activateNixSystem({ systemConfig: "/nix/store/system", run, alert });

  expect(alert).not.toHaveBeenCalled();
});
