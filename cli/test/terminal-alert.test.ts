import { Effect, Terminal } from "effect";
import { expect, test, vi } from "vitest";

import {
  createTerminalSession,
  emitTerminalAlert,
  TerminalSession,
  withTerminalInput,
} from "@/terminal-alert";

function capture(isTTY: boolean | undefined = true, env: NodeJS.ProcessEnv = {}) {
  const chunks: string[] = [];
  const session = createTerminalSession({
    stream: { isTTY, write: (chunk) => chunks.push(chunk) },
    env,
  });
  return { session, chunks };
}

function reports(chunks: string[]) {
  return chunks
    .filter((chunk) => chunk.startsWith("\u001b]7501;"))
    .map((chunk) => {
      expect(chunk).toMatch(/^\u001b\]7501;[A-Za-z0-9_.,+/=:\-]+\u001b\\$/);
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(4096);
      const fields = Object.fromEntries(
        chunk
          .slice(7, -2)
          .split(":")
          .map((pair) => {
            const equals = pair.indexOf("=");
            return [pair.slice(0, equals), pair.slice(equals + 1)];
          }),
      );
      for (const key of ["title", "msg"]) {
        if (fields[key]) fields[key] = Buffer.from(fields[key], "base64").toString("utf8");
      }
      return fields;
    });
}

test("reports complete root records with matching window titles, real progress, and retained completion", () => {
  const { session, chunks } = capture();
  session.begin(["outfitting-manager", "nix", "switch"]);
  session.phase("Building");
  session.progress(1, 3);
  session.alert("password-required");
  session.resume();
  session.phase("Publishing lock");
  session.close();

  const records = reports(chunks);
  expect(records.map((record) => [record.state, record.title, record.progress])).toEqual([
    ["working", "Outfitting: Working", undefined],
    ["working", "Outfitting: Building", undefined],
    ["working", "Outfitting: Building 33%", "33"],
    ["blocked", "Outfitting: Password required 33%", "33"],
    ["working", "Outfitting: Building 33%", "33"],
    ["working", "Outfitting: Publishing lock", undefined],
    ["done", "Outfitting: Done", undefined],
  ]);
  expect(records[3]?.kind).toBe("auth");
  expect(records[4]?.kind).toBeUndefined();
  expect(
    records.every((record) => record.app === "outfitting-manager" && record.id === undefined),
  ).toBe(true);
  expect(records.at(-1)?.msg).toBe("nix switch: Done");
  expect(chunks.filter((chunk) => chunk.startsWith("\u001b]2;"))).toEqual(
    records.map((record) => `\u001b]2;${record.title}\u001b\\`),
  );
  expect(chunks.join("")).not.toContain("state=clear");
  expect(chunks.join("")).not.toContain("\u0007");
});

test.each(["done", "idle", "error"] as const)(
  "%s finalization seals all callbacks and drops progress",
  (outcome) => {
    const { session, chunks } = capture();
    session.begin(["outfitting-manager", "apply"]);
    session.progress(2, 3);
    session.close(outcome);
    const before = [...chunks];
    session.begin(["outfitting-manager", "other"]);
    session.phase("Too late");
    session.progress(3, 3);
    session.blocked("auth", "Too late");
    session.alert("error");
    session.resume();
    session.cancel();
    session.summary("Too late", true);
    session.close();
    expect(chunks).toEqual(before);
    expect(reports(chunks).at(-1)).toMatchObject({ state: outcome });
    expect(reports(chunks).at(-1)?.progress).toBeUndefined();
  },
);

test("partial failures survive a successful close without publishing the summary prematurely", () => {
  const { session, chunks } = capture();
  session.begin(["outfitting-manager", "apply"]);
  session.summary("One package failed", true);
  expect(reports(chunks).at(-1)?.msg).not.toContain("failed");
  session.close();
  expect(reports(chunks).at(-1)).toMatchObject({ state: "error", msg: "One package failed" });
});

test.each([false, undefined])("non-TTY output (%s) stays entirely clean", (isTTY) => {
  const chunks: string[] = [];
  const session = createTerminalSession({
    stream: { isTTY, write: (chunk) => chunks.push(chunk) },
    env: {},
  });
  session.begin(["outfitting-manager", "update"]);
  session.phase("Building");
  session.alert("password-required");
  session.alert("error");
  session.close();
  expect(chunks).toEqual([]);
});

test.each([{ TERM: "dumb" }, { OUTFITTING_PROGRAM_STATUS: "0" }])(
  "disabled reporting retains only attention bells (%s)",
  (env) => {
    const { session, chunks } = capture(true, env);
    session.begin(["outfitting-manager", "update"]);
    session.alert("password-required");
    session.resume();
    session.alert("error");
    session.close();
    expect(chunks).toEqual(["\u0007", "\u0007\u0007"]);
  },
);

test("duplicate reports are suppressed, unknown totals omit progress, and percentages stay bounded", () => {
  const { session, chunks } = capture();
  session.begin(["outfitting-manager", "apply"]);
  session.progress(0, 3);
  const before = [...chunks];
  session.progress(0, 3);
  expect(chunks).toEqual(before);
  session.progress(2, 3);
  session.progress(1, 0);
  session.progress(10, 3);
  session.progress(-1, 3);
  expect(reports(chunks).map((record) => record.progress)).toEqual([
    undefined,
    "0",
    "66",
    undefined,
    "100",
    "0",
  ]);
});

test("titles and messages sanitize controls, respect separate byte limits, and preserve UTF-8", () => {
  const { session, chunks } = capture();
  session.begin(["outfitting-manager", "update"]);
  session.phase("A\u0007B\u001bC\u0085D\u202eE\nF");
  expect(reports(chunks).at(-1)?.title).toBe("Outfitting: A B C D E F");
  session.phase("界".repeat(100));
  session.progress(1, 3);
  session.summary("界".repeat(800));
  session.close();
  const records = reports(chunks);
  expect(records.at(-2)?.title).toBe("Outfitting: " + "界".repeat(58) + " 33%");
  expect(records.at(-1)?.msg).toBe("界".repeat(682));
});

test("terminal write failures never replace command results or escape through cleanup", () => {
  const write = vi.fn(() => {
    throw new Error("Terminal closed");
  });
  const session = createTerminalSession({ stream: { isTTY: true, write }, env: {} });
  expect(() => {
    session.begin(["outfitting-manager", "apply"]);
    session.phase("Building");
    session.alert("error");
    session.close();
  }).not.toThrow();
  expect(write).toHaveBeenCalledTimes(2);
});

test.each(["permission", "question", "auth"] as const)(
  "input reports %s only while waiting and resumes the previous percentage",
  async (kind) => {
    const { session, chunks } = capture();
    session.begin(["outfitting-manager", "apply"]);
    session.phase("Installing");
    session.progress(2, 3);
    const result = await Effect.runPromise(
      withTerminalInput(
        Effect.sync(() => {
          expect(reports(chunks).at(-1)).toMatchObject({ state: "blocked", kind, progress: "66" });
          return "secret-answer";
        }),
        kind,
        "Input needed",
      ).pipe(Effect.provideService(TerminalSession, session)),
    );
    expect(result).toBe("secret-answer");
    expect(reports(chunks).at(-1)).toMatchObject({
      state: "working",
      title: "Outfitting: Installing 66%",
    });
    expect(chunks.join("")).not.toContain("secret-answer");
  },
);

test("caught prompt cancellation still finishes as idle", async () => {
  const { session, chunks } = capture();
  session.begin(["outfitting-manager", "config", "wizard"]);
  await Effect.runPromise(
    withTerminalInput(Effect.fail(new Terminal.QuitError())).pipe(
      Effect.catchTag("QuitError", () => Effect.void),
      Effect.provideService(TerminalSession, session),
    ),
  );
  session.close();
  expect(reports(chunks).at(-1)?.state).toBe("idle");
});

test("standalone alerts retain one password bell, two error bells, and non-TTY silence", () => {
  const chunks: string[] = [];
  const output = { isTTY: true, write: (text: string) => chunks.push(text) };
  emitTerminalAlert("password-required", output);
  emitTerminalAlert("error", output);
  emitTerminalAlert("error", { ...output, isTTY: false });
  expect(chunks).toEqual(["\u0007", "\u0007\u0007"]);
});
