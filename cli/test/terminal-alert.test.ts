import { expect, test, vi } from "vitest";

import { emitTerminalAlert } from "@/terminal-alert";

function stream(isTTY: boolean) {
  const write = vi.fn<(chunk: string) => unknown>();
  return { isTTY, write };
}

test("emits one terminal bell for a password-required alert", () => {
  const output = stream(true);

  emitTerminalAlert("password-required", output);

  expect(output.write).toHaveBeenCalledWith("\u0007");
});

test("emits two terminal bells for an error alert", () => {
  const output = stream(true);

  emitTerminalAlert("error", output);

  expect(output.write).toHaveBeenCalledWith("\u0007\u0007");
});

test("does not write bell characters when output is not a TTY", () => {
  const output = stream(false);

  emitTerminalAlert("error", output);

  expect(output.write).not.toHaveBeenCalled();
});
