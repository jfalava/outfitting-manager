import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { inferOutputPath, isGitTrackedFile, resolveKindSelection } from "@/sync/files";
import { fetchLockfileKinds } from "@/sync/list";
import { resolveLockfileMachine } from "@/sync/machine";
import { requestEffect } from "@/sync/request";
import type { PullLockfileOptions } from "@/sync/types";
import { ui } from "@/ui";

const pullOne = (machine: string, kind: string, outPath: string) =>
  Effect.gen(function* () {
    if (yield* tryPromise(() => isGitTrackedFile(outPath))) {
      return yield* new CliFailure({
        message: `Refusing to overwrite Git-tracked file: ${outPath}; use an explicit out-path to write elsewhere.`,
      });
    }

    const destination = yield* tryPromise(() =>
      lstat(outPath).catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          return undefined;
        }
        throw cause;
      }),
    );
    if (destination?.isSymbolicLink()) {
      return yield* new CliFailure({
        message: `Refusing to replace symlink: ${outPath}; use its target path explicitly.`,
      });
    }

    const response = yield* requestEffect(["lockfiles", machine, kind]);
    yield* tryPromise(() => mkdir(dirname(outPath), { recursive: true }));
    const contents = yield* tryPromise(() => response.arrayBuffer());
    const size = yield* tryPromise(async () => {
      const staging = await mkdtemp(join(dirname(outPath), ".outfitting-pull-"));
      try {
        const snapshot = join(staging, "snapshot");
        await writeFile(snapshot, new Uint8Array(contents), { mode: 0o600, flag: "wx" });
        if (destination !== undefined) {
          await chmod(snapshot, destination.mode & 0o777);
        }
        await rename(snapshot, outPath);
        return contents.byteLength;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });

    yield* Console.log(
      ui.success(
        `Wrote ${ui.key(`${size} bytes`)} to ${ui.key(outPath)} ${ui.muted(`(${machine}/${kind})`)}`,
      ),
    );
    return undefined;
  });

export const pullLockfile = ({
  machine: requestedMachine,
  kind,
  outPath: requestedPath,
}: PullLockfileOptions) =>
  Effect.gen(function* () {
    const machine = yield* resolveLockfileMachine(requestedMachine);

    const selection = resolveKindSelection(kind);
    if (selection.mode === "one") {
      const outPath = requestedPath ?? inferOutputPath(selection.kind);
      if (!outPath) {
        return yield* new CliFailure({
          message: `Cannot infer a filename for kind "${selection.kind}"; provide out-path explicitly.`,
        });
      }
      yield* pullOne(machine, selection.kind, outPath);
      return undefined;
    }

    if (requestedPath !== undefined) {
      return yield* new CliFailure({
        message: "out-path cannot be combined with kind all; each kind writes to its default path.",
      });
    }

    const kinds = yield* fetchLockfileKinds(machine);
    if (kinds.length === 0) {
      yield* Console.log(ui.muted(`No lockfiles tracked for ${machine}.`));
      return undefined;
    }

    for (const selectedKind of kinds) {
      const outPath = inferOutputPath(selectedKind) ?? join(".", `${selectedKind}.lock`);
      yield* pullOne(machine, selectedKind, outPath);
    }
    return undefined;
  });
