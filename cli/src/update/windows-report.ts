import { Effect } from "effect";

import { CliFailure } from "@/errors";
import { ui } from "@/ui";

/** Stop on a failed package operation under `--strict`; otherwise warn and collect it. */
export const reportPackageFailure = Effect.fn("reportWindowsPackageFailure")(function* (
  failure: string,
  strict: boolean,
  failures: string[],
  log: (message: string) => Effect.Effect<void>,
) {
  if (strict) {
    return yield* new CliFailure({ message: `${failure}.` });
  }
  failures.push(failure);
  yield* log(ui.warning(`${failure}; continuing.`));
});
