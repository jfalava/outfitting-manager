import { Console, Effect, Schema } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";

import { outputPreviews, type OutputPreview } from "@/debug/output";
import { CliFailure } from "@/errors";
import type { HostPlatform } from "@/platform";
import { TerminalSession, withTerminalInput } from "@/terminal-alert";
import { ui } from "@/ui";

type PreviewState = "success" | "empty" | "error" | "blocked" | "cancelled";

const waitForSampleInput = Effect.fn(function* (preview: OutputPreview) {
  if (!preview.input) {
    return yield* new CliFailure({ message: `${preview.path} has no input-waiting preview.` });
  }
  if (!process.stdin.isTTY) {
    return yield* new CliFailure({
      message:
        "Blocked previews require an interactive terminal. Use dummy input only; answers are discarded.",
    });
  }
  const label = {
    auth: "Sample credential required",
    permission: "Approve sample plan",
    question: "Sample answer required",
  }[preview.input];
  const prompt =
    preview.input === "auth"
      ? Prompt.Password({ message: "Sample credential (dummy input only; never saved)" }).pipe(
          Effect.as(true),
        )
      : preview.input === "permission"
        ? Prompt.Confirm({
            message: "Approve this sample plan? Nothing will be changed.",
            initial: false,
          })
        : Prompt.String({ message: "Sample answer (discarded)", default: "workstation" }).pipe(
            Effect.as(true),
          );
  const approved = yield* withTerminalInput(prompt, preview.input, label);
  if (!approved) {
    const session = yield* TerminalSession;
    session.cancel();
  }
  yield* Console.log(ui.muted("Sample input discarded. No operation was run."));
});

const renderPreview = Effect.fn(function* (
  preview: OutputPreview,
  platform: HostPlatform,
  state: PreviewState,
  delay: number,
) {
  yield* Console.error(ui.heading(`\nPreview: ${preview.path} · ${platform} · ${state}`));
  yield* Console.error(
    ui.muted("Fixed sample data. No packages, files, credentials, or services are changed."),
  );
  const session = yield* TerminalSession;
  session.phase(`Preview ${preview.path}`);
  if (state === "error") {
    yield* Effect.sleep(delay);
    return yield* new CliFailure({
      message: `Simulated ${preview.path} failure.\nSample diagnostic: the requested operation could not finish.\nNo real operation was attempted.`,
    });
  }
  if (state === "cancelled") {
    session.cancel();
    return yield* Console.log(ui.muted("Preview cancelled. No operation was run."));
  }
  if (state === "blocked") {
    return yield* waitForSampleInput(preview);
  }
  yield* Effect.sleep(delay);
  yield* preview.render(state === "empty", delay);
});

const listPreviews = Effect.fn(function* (platform: HostPlatform, previews: OutputPreview[]) {
  yield* Console.log(ui.heading(`Output previews (${platform})`));
  for (const preview of previews) {
    yield* Console.log(
      `  ${preview.path.padEnd(36)} success${preview.empty ? ", empty" : ""}, error${preview.input ? ", blocked" : ""}, cancelled`,
    );
  }
  yield* Console.log(
    "\nUse debug output <command path> or debug output all.\nBlocked previews ask for disposable input; nothing is saved.",
  );
});

/** All effects below render fixed data or wait for disposable input. No real handlers run. */
export const makeDebugCommand = (hostPlatform: HostPlatform) =>
  Command.make("debug").pipe(
    Command.withDescription(
      "Preview CLI output and terminal status without running real operations.",
    ),
    Command.withSubcommands([
      Command.make(
        "output",
        {
          command: Argument.String("command").pipe(Argument.variadic()),
          platform: Flag.Literals("platform", ["macos", "linux", "windows"]).pipe(
            Flag.withDefault(hostPlatform),
            Flag.withDescription("Choose sample data for any platform, without changing the host."),
          ),
          state: Flag.Literals("state", ["success", "empty", "error", "blocked", "cancelled"]).pipe(
            Flag.withDefault("success"),
            Flag.withDescription(
              "Output/status state to preview; use --list for supported states.",
            ),
          ),
          delay: Flag.Int("delay-ms").pipe(
            Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))),
            Flag.withDefault(500),
            Flag.withDescription(
              "Pause per sample operation (0–60000 ms); zero for automated checks.",
            ),
          ),
          list: Flag.Boolean("list").pipe(
            Flag.withDefault(false),
            Flag.withDescription("List available command previews and states."),
          ),
        },
        ({ command, platform, state, delay, list }) =>
          Effect.gen(function* () {
            const selector = command.join(" ").trim().replace(/\s+/g, " ");
            const path = selector === "upgrade" ? "self-update" : selector;
            const previews = outputPreviews(platform).filter(
              (preview) =>
                !path ||
                path === "all" ||
                preview.path === path ||
                preview.path.startsWith(`${path} `),
            );
            if (previews.length === 0) {
              return yield* new CliFailure({
                message: `No ${platform} output preview for \`${selector}\`. Run debug output --list.`,
              });
            }
            if (list || !selector) {
              return yield* listPreviews(platform, previews);
            }
            if (state !== "success" && state !== "empty" && previews.length !== 1) {
              return yield* new CliFailure({
                message: `Select one command to preview --state ${state}.`,
              });
            }
            if (state === "empty" && previews.some((preview) => !preview.empty)) {
              return yield* new CliFailure({
                message: `No empty preview for: ${previews
                  .filter((preview) => !preview.empty)
                  .map((preview) => preview.path)
                  .join(", ")}. Run debug output --list.`,
              });
            }
            for (const preview of previews) {
              yield* renderPreview(preview, platform, state, delay);
            }
          }),
      ).pipe(
        Command.withDescription(
          "Render one command, a family, or all commands from safe fixtures; omit the path to list them.",
        ),
      ),
    ]),
  );
