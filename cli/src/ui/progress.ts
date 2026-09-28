import * as cliProgress from "cli-progress";
import { Effect } from "effect";

const STEP_ICON = "󰄭";
const ACTIVITY_ICON = "󰔛";

export interface ProgressOptions {
  stream?: NodeJS.WriteStream;
  announceNonTTY?: boolean;
}

export interface ProgressRenderer {
  track<A, E, R>(label: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  finish(): void;
}

function displayLabel(label: string, maxLength: number): string {
  const cleaned = Array.from(label, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f ? " " : character;
  }).join("");
  return cleaned.replace(/\s+/g, " ").slice(0, maxLength);
}

export function createProgress(
  title: string,
  total: number | undefined,
  options: ProgressOptions = {},
): ProgressRenderer {
  const stream = options.stream ?? process.stderr;
  const isTTY = stream.isTTY === true;
  const isActivity = total === undefined;
  const operationCount = total ?? 1;
  let attempted = 0;
  let started = false;
  let finished = false;
  let activeStep = title;
  const disabled = total === 0;
  const columns = stream.columns ?? 80;
  const maxLabelLength = Math.min(48, Math.max(8, columns - (isActivity ? 12 : 33 + title.length)));

  const bar =
    isTTY && (total === undefined || total > 0)
      ? new cliProgress.SingleBar({
          format: isActivity
            ? `${ACTIVITY_ICON} {step} · {duration_formatted}`
            : `${STEP_ICON} ${title} [{bar}] {value}/${total} tried · {step} · {duration_formatted}`,
          stream,
          barsize: 6,
          barCompleteChar: "━",
          barIncompleteChar: "─",
          forceRedraw: true,
          fps: 5,
          gracefulExit: true,
          hideCursor: true,
          linewrap: true,
        })
      : undefined;

  const announceNonTTY = () => {
    if (options.announceNonTTY === false) {
      return;
    }
    const prefix = isActivity ? ACTIVITY_ICON : STEP_ICON;
    const description = isActivity
      ? activeStep
      : `${title} (${total} operation${total === 1 ? "" : "s"})`;
    stream.write(`${prefix} ${description}\n`);
  };

  const start = (label: string) => {
    activeStep = displayLabel(label, maxLabelLength);
    if (disabled || finished) {
      return;
    }
    if (started) {
      bar?.update(attempted, { step: activeStep });
      return;
    }
    started = true;
    if (bar !== undefined) {
      bar.start(operationCount, attempted, { step: activeStep });
    } else {
      announceNonTTY();
    }
  };

  return {
    track: (label, effect) =>
      Effect.sync(() => start(label)).pipe(
        Effect.flatMap(() => effect),
        Effect.ensuring(
          Effect.sync(() => {
            if (!isActivity) {
              attempted += 1;
            }
            if (bar !== undefined && started && !finished) {
              bar.update(attempted, { step: activeStep });
            }
          }),
        ),
      ),
    finish: () => {
      if (finished) {
        return;
      }
      finished = true;
      bar?.stop();
    },
  };
}

export function withProgress<A, E, R>(
  title: string,
  total: number,
  use: (progress: ProgressRenderer) => Effect.Effect<A, E, R>,
  options?: ProgressOptions,
): Effect.Effect<A, E, R> {
  const progress = createProgress(title, total, options);
  return Effect.suspend(() => use(progress)).pipe(Effect.ensuring(Effect.sync(progress.finish)));
}

export function withActivity<A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  options?: ProgressOptions,
): Effect.Effect<A, E, R> {
  const progress = createProgress(label, undefined, options);
  return progress.track(label, effect).pipe(Effect.ensuring(Effect.sync(progress.finish)));
}
