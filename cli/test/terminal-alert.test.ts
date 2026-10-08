import * as childProcess from "node:child_process";

import { afterEach, expect, test, vi } from "vitest";

import { createTerminalSession, emitTerminalAlert, supportsProgramStatus } from "@/terminal-alert";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

afterEach(() => vi.clearAllMocks());

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

function capture(isTTY: boolean | undefined, status = true, titles = true) {
  const chunks: string[] = [];
  const supportsStatus = vi.fn(() => status);
  const session = createTerminalSession({
    stream: { isTTY, write: (chunk) => chunks.push(chunk) },
    env: { OUTFITTING_TITLE_PROTOCOL: titles ? "xterm-window-stack" : undefined },
    supportsStatus,
  });
  return { session, chunks, supportsStatus };
}

function reports(chunks: string[]) {
  return chunks
    .filter((chunk) => chunk.startsWith("\u001b]7501;"))
    .map((chunk) => {
      expect(chunk).toMatch(/^\u001b\]7501;[^\u001b\u0007]+\u001b\\$/);
      const fields = Object.fromEntries(
        chunk
          .slice(7, -2)
          .split(":")
          .map((pair) => {
            const equals = pair.indexOf("=");
            return [pair.slice(0, equals), pair.slice(equals + 1)];
          }),
      );
      return {
        ...fields,
        state: fields.state as string,
        msg: fields.msg ? Buffer.from(fields.msg, "base64").toString("utf8") : undefined,
      };
    });
}

test("status-capable terminals report auth and error without bell bytes, independent of identity", () => {
  const { session, chunks, supportsStatus } = capture(true);
  session.begin(["outfitting-manager", "nix", "switch"]);
  session.phase("Activating");
  session.alert("password-required");
  session.resume();
  session.alert("error");
  session.close();

  expect(reports(chunks)).toEqual([
    {
      state: "working",
      id: "outfitting-manager",
      app: "outfitting-manager",
      msg: "nix switch: Working",
    },
    {
      state: "working",
      id: "outfitting-manager",
      app: "outfitting-manager",
      msg: "nix switch: Activating",
    },
    {
      state: "blocked",
      kind: "auth",
      id: "outfitting-manager",
      app: "outfitting-manager",
      msg: "nix switch: Password required",
    },
    {
      state: "working",
      id: "outfitting-manager",
      app: "outfitting-manager",
      msg: "nix switch: Activating",
    },
    {
      state: "error",
      id: "outfitting-manager",
      app: "outfitting-manager",
      msg: "nix switch: Failed",
    },
  ]);
  expect(chunks.join("")).not.toContain("\u0007");
  expect(supportsStatus).toHaveBeenCalledTimes(1);
  expect(chunks.at(-1)).toBe("\u001b[23;2t");
});

test.each([true, false])("status and title capabilities are independent (status %s)", (status) => {
  const { session, chunks } = capture(true, status, false);
  session.begin(["outfitting-manager", "update"]);
  session.alert("password-required");
  session.alert("error");
  session.close();

  expect(chunks.join("")).not.toContain("\u001b]2;");
  expect(chunks.join("")).not.toContain("\u001b[22;2t");
  if (status) {
    expect(reports(chunks).map((report) => report.state)).toEqual(["working", "blocked", "error"]);
  } else {
    expect(chunks).toEqual(["\u0007", "\u0007\u0007"]);
  }
});

test("title-only sessions keep bell alerts and save/restore exactly once", () => {
  const { session, chunks } = capture(true, false, true);
  session.begin(["outfitting-manager", "nix", "switch"]);
  session.begin(["outfitting-manager", "other"]);
  session.phase("Building");
  session.alert("password-required");
  session.resume();
  session.close();
  const beforeLateCallbacks = [...chunks];
  session.close();
  session.phase("Too late");
  session.alert("error");
  session.resume();

  expect(chunks).toEqual(beforeLateCallbacks);
  expect(chunks).toEqual([
    "\u001b[22;2t",
    "\u001b]2;Outfitting · nix switch · Working\u001b\\",
    "\u001b]2;Outfitting · nix switch · Building\u001b\\",
    "\u001b]2;Outfitting · nix switch · Password required\u001b\\",
    "\u0007",
    "\u001b]2;Outfitting · nix switch · Building\u001b\\",
    "\u001b[23;2t",
  ]);
});

test.each([false, undefined])(
  "non-TTY streams (%s) never inspect capabilities or emit controls",
  (isTTY) => {
    const { session, chunks, supportsStatus } = capture(isTTY);
    session.begin(["outfitting-manager", "update"]);
    session.phase("Building");
    session.alert("password-required");
    session.alert("error");
    session.close(true);

    expect(chunks).toEqual([]);
    expect(supportsStatus).not.toHaveBeenCalled();
  },
);

test.each([
  [false, "clear"],
  [true, "idle"],
] as const)(
  "successful/cancelled work closes only its own status record (%s)",
  (interrupted, state) => {
    const { session, chunks } = capture(true);
    session.begin(["outfitting-manager", "apply"]);
    session.alert("password-required");
    session.close(interrupted);

    expect(reports(chunks).at(-1)).toEqual({
      state,
      id: "outfitting-manager",
      app: "outfitting-manager",
      msg: undefined,
    });
    expect(chunks.at(-1)).toBe("\u001b[23;2t");
    expect(chunks.join("")).not.toContain("state=done");
  },
);

test("title and message text strip controls and truncate at a UTF-8 boundary", () => {
  const { session, chunks } = capture(true);
  session.begin(["outfitting-manager", "update"]);
  session.phase("A\u0007B\u001bC\u0085D\u202eE\nF");
  expect(chunks).toContain("\u001b]2;Outfitting · update · A B C D E F\u001b\\");
  expect(reports(chunks).at(-1)?.msg).toBe("update: A B C D E F");

  session.phase("界".repeat(100));
  const title = chunks
    .filter((chunk) => chunk.startsWith("\u001b]2;"))
    .at(-1)!
    .slice(4, -2);
  expect(title).toBe("Outfitting · update · " + "界".repeat(56));
  expect(Buffer.byteLength(title)).toBe(192);
  expect(reports(chunks).at(-1)?.msg).toBe("update: " + "界".repeat(61));
});

test.each([
  [0, "\tPst=\\E]7501;%p1%s\\E\\\\,\n", true],
  [0, "\tPst@,\n", false],
  [0, "\tPst=,\n", false],
  [0, "\tOtherPst=value,\n", false],
  [1, "\tPst=value,\n", false],
  [null, "", false],
] as const)("Pst advertisement detection: exit %s, output %s", (status, stdout, supported) => {
  const inspect = vi.mocked(childProcess.spawnSync).mockReturnValue({
    status,
    stdout,
    stderr: "",
    pid: 0,
    signal: null,
    output: [],
  });
  expect(supportsProgramStatus({ TERM: "test-terminal", TERM_PROGRAM: "not-ghostty" })).toBe(
    supported,
  );
  expect(inspect).toHaveBeenCalledWith(
    "infocmp",
    ["-x", "-1", "test-terminal"],
    expect.objectContaining({
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }),
  );
});

test.each([undefined, "", "dumb"])("missing/dumb TERM (%s) does not spawn a lookup", (TERM) => {
  const inspect = vi.mocked(childProcess.spawnSync);
  expect(supportsProgramStatus({ TERM, TERM_PROGRAM: "ghostty" })).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
});
