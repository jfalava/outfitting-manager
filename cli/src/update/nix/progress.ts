import { stripVTControlCharacters } from "node:util";

import * as cliProgress from "cli-progress";
import { Option, Schema } from "effect";
import pc from "picocolors";

import type { TerminalSessionControls } from "@/terminal-alert";
import { ui } from "@/ui";

// Activity and result types of `nix --log-format internal-json` (libutil/logging.hh).
const ACT_COPY_PATH = 100;
const ACT_FILE_TRANSFER = 101;
const ACT_COPY_PATHS = 103;
const ACT_BUILDS = 104;
const ACT_BUILD = 105;
const ACT_SUBSTITUTE = 108;
const ACT_QUERY_PATH_INFO = 109;
const ACT_BUILD_WAITING = 111;
const RES_BUILD_LOG_LINE = 101;
const RES_SET_PHASE = 104;
const RES_PROGRESS = 105;
const RES_SET_EXPECTED = 106;
const LVL_ERROR = 0;
const LVL_WARN = 1;
const LVL_INFO = 3;

const ACTIVITY_ICON = "󰔛";
const BAR_SIZE = 8;
const RAW_TAIL_LINES = 20;
/** Shorter builds only count toward the summary; a system closure has many tiny ones. */
const NOTABLE_BUILD_MS = 5_000;
/** Without a live row, redirected output still shows that a long build is alive. */
const HEARTBEAT_MS = 60_000;

export type NixBuildSession = Pick<TerminalSessionControls, "phase" | "progress">;

export interface NixBuildProgressOptions {
  stream?: NodeJS.WriteStream;
  session?: NixBuildSession;
  now?: () => number;
}

export interface NixBuildProgress {
  /** One stderr line of `nix build --log-format internal-json`. */
  feed: (line: string) => void;
  finish: (success: boolean) => void;
  /** Nix's own error messages, or its last raw output lines when it printed none. */
  failureDetail: () => string;
}

const NixEventSchema = Schema.Struct({
  action: Schema.String,
  id: Schema.optionalKey(Schema.Finite),
  type: Schema.optionalKey(Schema.Finite),
  level: Schema.optionalKey(Schema.Finite),
  text: Schema.optionalKey(Schema.String),
  msg: Schema.optionalKey(Schema.String),
  // Activity fields mix store paths, URIs and counters; null appears in error positions.
  fields: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

type NixEvent = Schema.Schema.Type<typeof NixEventSchema>;

const decodeNixEvent = Schema.decodeUnknownOption(NixEventSchema);
const isFinite = Schema.is(Schema.Finite);
const isString = Schema.is(Schema.String);

interface Activity {
  id: number;
  type: number;
  level: number;
  text: string;
  name: string;
  started: number;
  machine?: string;
  phase?: string;
  lastLine?: string;
}

interface Counter {
  type: number;
  done: number;
  expected: number;
  running: number;
  failed: number;
}

interface Tally {
  done: number;
  expected: number;
  total: number;
  running: number;
  failed: number;
}

/** What the wait is for right now; the rows and the terminal title all follow it. */
type Phase =
  | { kind: "building"; build: Activity; others: number }
  | { kind: "fetching" }
  | { kind: "waiting"; activity: Activity }
  | { kind: "realising" }
  | { kind: "inputs"; activities: Activity[] }
  | { kind: "cache" }
  | { kind: "evaluating" };

/** A status row whose middle part shrinks first when the terminal is narrow. */
interface Row {
  head: string;
  middle: string;
  tail: string;
}

function numberField(fields: ReadonlyArray<unknown> | undefined, index: number): number {
  const value = fields?.[index];
  return isFinite(value) ? value : 0;
}

function stringField(fields: ReadonlyArray<unknown> | undefined, index: number): string {
  const value = fields?.[index];
  return isString(value) ? value : "";
}

function storeName(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/^[0-9a-z]{32}-/, "").replace(/\.drv$/, "");
}

/** Keep only what a single terminal row can show: the last carriage-return state, no controls. */
function cleanLine(line: string): string {
  return (
    stripVTControlCharacters(line.split("\r").at(-1) ?? "")
      // oxlint-disable-next-line no-control-regex -- builder output may carry any control byte.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
  );
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function bar(tally: Tally): string {
  const ratio = tally.total > 0 ? Math.min(tally.done, tally.total) / tally.total : 0;
  const filled = Math.round(ratio * BAR_SIZE);
  return `[${"━".repeat(filled)}${"─".repeat(BAR_SIZE - filled)}] ${tally.done}/${tally.total}`;
}

function truncate(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }
  return budget <= 1 ? "" : `${text.slice(0, budget - 1)}…`;
}

const phaseLabel = {
  fetching: "Fetching from cache",
  realising: "Building",
  inputs: "Fetching flake inputs",
  cache: "Checking binary cache",
  evaluating: "Evaluating",
} as const;

/** Flake inputs arrive as downloads plus "unpacking …"/"fetching …" steps; narinfo lookups are cache queries. */
function isInputFetch(activity: Activity): boolean {
  if (activity.type === ACT_FILE_TRANSFER) {
    return !activity.text.includes(".narinfo");
  }
  return activity.type === 0 && /^(?:unpacking|fetching) /.test(cleanLine(activity.text));
}

function isLockWait(activity: Activity): boolean {
  return cleanLine(activity.text).startsWith("waiting for lock on ");
}

function waitingReason(activity: Activity): string {
  const text = cleanLine(activity.text);
  const locked = /^waiting for lock on '([^']+)'/.exec(text)?.[1];
  return locked === undefined ? text : `${storeName(locked)} is locked by another Nix process`;
}

function summaryLine(
  built: number,
  fetched: number,
  elapsedMs: number,
  waitedForLock: boolean,
): string {
  const elapsed = formatDuration(elapsedMs);
  if (built > 0 && fetched > 0) {
    return `Built ${plural(built, "derivation")} and fetched ${plural(fetched, "path")} in ${elapsed}`;
  }
  if (built > 0) {
    return `Built ${plural(built, "derivation")} in ${elapsed}`;
  }
  if (fetched > 0) {
    return `Fetched ${plural(fetched, "path")} in ${elapsed}`;
  }
  if (waitedForLock) {
    return `Already built by another Nix process ${ui.muted(`(waited ${elapsed})`)}`;
  }
  return `Already built ${ui.muted(`(evaluated in ${elapsed})`)}`;
}

/** What Nix is doing, rebuilt from its event stream; reports notable steps through `log`. */
class NixBuildState {
  readonly errors: string[] = [];
  readonly rawTail: string[] = [];
  readonly startedAt: number;
  built = 0;
  /** Set when another Nix process held a lock this build waited on; it built that output. */
  waitedForLock = false;
  private readonly activities = new Map<number, Activity>();
  // Counters outlive their activities: finished downloads still count toward the totals.
  private readonly counters = new Map<number, Counter>();
  private readonly expected = new Map<string, number>();
  // Nix's Builds counter counts extra goals (one derivation ends at 1/2), so prefer its plan.
  private plannedBuilds = 0;
  private doneSeen = 0;
  private failedSeen = 0;
  // Once Nix builds or fetches, gaps between steps are scheduling, not evaluation.
  private realising = false;
  private fetchStartedAt: number | undefined;
  private loggedPaths = 0;
  private loggedBytes = 0;

  constructor(
    private readonly now: () => number,
    private readonly log: (message: string) => void,
  ) {
    this.startedAt = now();
  }

  apply(event: NixEvent): void {
    const id = event.id ?? 0;
    switch (event.action) {
      case "start":
        this.start(event, id);
        return;
      case "stop":
        this.stop(id);
        return;
      case "result":
        this.result(event, id);
        return;
      case "msg":
        this.message(event);
        return;
      default:
        return;
    }
  }

  raw(line: string): void {
    if (line.trim() === "") {
      return;
    }
    this.rawTail.push(line);
    if (this.rawTail.length > RAW_TAIL_LINES) {
      this.rawTail.shift();
    }
    this.log(line);
  }

  builds(): Tally {
    const counter = this.sum(ACT_BUILDS);
    if (this.plannedBuilds === 0) {
      return { ...counter, total: Math.max(counter.expected, counter.done + counter.running) };
    }
    const active = this.running(ACT_BUILD).length;
    const total = Math.max(this.plannedBuilds, this.built + this.failedSeen + active);
    return { ...counter, done: this.built, total };
  }

  paths(): Tally {
    const counter = this.sum(ACT_COPY_PATHS);
    return { ...counter, total: Math.max(counter.expected, counter.done + counter.running) };
  }

  /** The longest-running build is the one worth naming: it is what the wait is for. */
  phase(): Phase {
    const builds = this.running(ACT_BUILD);
    const slowest = builds[0];
    if (slowest !== undefined) {
      return { kind: "building", build: slowest, others: builds.length - 1 };
    }
    if (this.fetching()) {
      return { kind: "fetching" };
    }
    // Another process holds a lock on an output this build needs (or no build machine is free).
    const waiting = this.running(ACT_BUILD_WAITING)[0];
    if (waiting !== undefined) {
      return { kind: "waiting", activity: waiting };
    }
    if (this.realising) {
      return { kind: "realising" };
    }
    const inputs = [...this.activities.values()].filter(isInputFetch);
    if (inputs.length > 0) {
      return { kind: "inputs", activities: inputs };
    }
    // After evaluation, Nix asks the binary caches which paths it can fetch before printing its plan.
    return this.running(ACT_QUERY_PATH_INFO).length > 0
      ? { kind: "cache" }
      : { kind: "evaluating" };
  }

  mainRow(): Row {
    const phase = this.phase();
    const t = this.now();
    const elapsed = ` · ${formatDuration(t - this.startedAt)}`;
    switch (phase.kind) {
      case "building": {
        const { build, others } = phase;
        const host = build.machine ? ` on ${build.machine}` : "";
        const step = build.phase ? ` (${build.phase})` : "";
        const more = others > 0 ? ` +${others} more` : "";
        return {
          head: `Building ${bar(this.builds())} · `,
          middle: `${build.name}${host}${step}${more}`,
          tail: ` · ${formatDuration(t - build.started)}`,
        };
      }
      case "fetching": {
        const downloaded = this.sum(ACT_FILE_TRANSFER).done;
        const total = Math.max(this.expectedOf(ACT_FILE_TRANSFER), downloaded);
        return {
          head: `Fetching ${bar(this.paths())} · `,
          middle: `${formatBytes(downloaded)} of ${formatBytes(total)}`,
          tail: ` · ${formatDuration(t - (this.fetchStartedAt ?? this.startedAt))}`,
        };
      }
      case "waiting":
        return {
          head: "Waiting · ",
          middle: waitingReason(phase.activity),
          tail: ` · ${formatDuration(t - phase.activity.started)}`,
        };
      case "realising":
        return { head: `Building ${bar(this.builds())}`, middle: "", tail: elapsed };
      default:
        return { head: phaseLabel[phase.kind], middle: "", tail: elapsed };
    }
  }

  detailRow(): string {
    const phase = this.phase();
    switch (phase.kind) {
      case "building":
        return phase.build.lastLine ?? "";
      case "fetching": {
        const substitutes = this.running(ACT_SUBSTITUTE);
        const newest = substitutes.at(-1);
        const more = substitutes.length > 1 ? ` +${substitutes.length - 1} more` : "";
        return newest === undefined ? "" : `${newest.name}${more}`;
      }
      case "inputs":
        return this.inputDetail(phase.activities);
      case "evaluating": {
        // Show what Nix itself would show at its default verbosity.
        const visible = [...this.activities.values()].filter(
          (activity) => activity.level <= LVL_INFO && activity.text !== "",
        );
        return cleanLine(visible.at(-1)?.text ?? "");
      }
      default:
        return "";
    }
  }

  /** Short phase for the terminal title. */
  label(): string {
    const phase = this.phase();
    switch (phase.kind) {
      case "building":
        return `Building ${phase.build.name}`;
      case "waiting":
        return isLockWait(phase.activity) ? "Waiting for another Nix process" : "Waiting";
      default:
        return phaseLabel[phase.kind];
    }
  }

  /** The input being fetched (a flake ref when Nix names one) and the bytes downloaded so far. */
  private inputDetail(activities: Activity[]): string {
    const named = activities.findLast((activity) => activity.type !== ACT_FILE_TRANSFER);
    const transfers = activities.filter((activity) => activity.type === ACT_FILE_TRANSFER);
    const source = named ?? transfers.at(-1);
    const ref = /'([^']+)'/.exec(cleanLine(source?.text ?? ""))?.[1] ?? "";
    let bytes = 0;
    for (const transfer of transfers) {
      bytes += this.counters.get(transfer.id)?.done ?? 0;
    }
    const parts = [ref.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, "$1")];
    if (bytes > 0) {
      parts.push(formatBytes(bytes));
    }
    return parts.filter((part) => part !== "").join(" · ");
  }

  private fetching(): boolean {
    return this.paths().running > 0 || this.running(ACT_COPY_PATH).length > 0;
  }

  private running(type: number): Activity[] {
    return [...this.activities.values()]
      .filter((activity) => activity.type === type)
      .toSorted((a, b) => a.started - b.started);
  }

  private sum(type: number): Omit<Counter, "type"> {
    const total = { done: 0, expected: 0, running: 0, failed: 0 };
    for (const counter of this.counters.values()) {
      if (counter.type === type) {
        total.done += counter.done;
        total.expected += counter.expected;
        total.running += counter.running;
        total.failed += counter.failed;
      }
    }
    return total;
  }

  private expectedOf(type: number): number {
    let total = 0;
    for (const [key, value] of this.expected) {
      if (key.endsWith(`:${type}`)) {
        total += value;
      }
    }
    return total;
  }

  private start(event: NixEvent, id: number): void {
    const type = event.type ?? 0;
    const activity: Activity = {
      id,
      type,
      level: event.level ?? LVL_INFO,
      text: event.text ?? "",
      name: "",
      started: this.now(),
    };
    if (type === ACT_BUILD || type === ACT_SUBSTITUTE) {
      activity.name = storeName(stringField(event.fields, 0));
    }
    if (type === ACT_BUILD) {
      activity.machine = stringField(event.fields, 1) || undefined;
    }
    if (type === ACT_BUILD || type === ACT_COPY_PATH) {
      this.realising = true;
    }
    if (type === ACT_COPY_PATH) {
      this.fetchStartedAt ??= activity.started;
    }
    this.activities.set(id, activity);
  }

  // A build reports its outcome by bumping the Builds counters just before it stops;
  // a build Nix cancels after another one failed bumps neither.
  private stop(id: number): void {
    const activity = this.activities.get(id);
    this.activities.delete(id);
    if (activity?.type === ACT_BUILD_WAITING && isLockWait(activity)) {
      this.waitedForLock = true;
    }
    if (activity?.type !== ACT_BUILD) {
      return;
    }
    const counts = this.sum(ACT_BUILDS);
    const elapsed = formatDuration(this.now() - activity.started);
    if (counts.failed > this.failedSeen) {
      this.failedSeen += 1;
      const phase = activity.phase ? ` ${ui.muted(`(${activity.phase})`)}` : "";
      this.log(`  ${pc.red("✗")} ${activity.name} failed after ${elapsed}${phase}`);
      return;
    }
    if (counts.done > this.doneSeen) {
      this.doneSeen += 1;
      this.built += 1;
      if (this.now() - activity.started >= NOTABLE_BUILD_MS) {
        this.log(`  ${ui.success(`Built ${activity.name} ${ui.muted(`· ${elapsed}`)}`)}`);
      }
    }
  }

  private result(event: NixEvent, id: number): void {
    const activity = this.activities.get(id);
    switch (event.type) {
      case RES_PROGRESS:
        this.recordProgress(event, id, activity);
        return;
      case RES_SET_EXPECTED:
        this.expected.set(`${id}:${numberField(event.fields, 0)}`, numberField(event.fields, 1));
        return;
      case RES_SET_PHASE:
        if (activity !== undefined) {
          activity.phase = stringField(event.fields, 0) || undefined;
        }
        return;
      case RES_BUILD_LOG_LINE: {
        const line = cleanLine(stringField(event.fields, 0));
        if (activity !== undefined && line !== "") {
          activity.lastLine = line;
        }
        return;
      }
      default:
        return;
    }
  }

  private recordProgress(event: NixEvent, id: number, activity: Activity | undefined): void {
    const type = activity?.type ?? this.counters.get(id)?.type;
    if (type === undefined) {
      return;
    }
    this.counters.set(id, {
      type,
      done: numberField(event.fields, 0),
      expected: numberField(event.fields, 1),
      running: numberField(event.fields, 2),
      failed: numberField(event.fields, 3),
    });
    if (type === ACT_COPY_PATHS) {
      this.logFetched();
    }
  }

  private logFetched(): void {
    const copies = this.paths();
    const settled = copies.expected > 0 && copies.done >= copies.expected && copies.running === 0;
    if (!settled || copies.done <= this.loggedPaths) {
      return;
    }
    const bytes = this.sum(ACT_FILE_TRANSFER).done;
    const elapsed = formatDuration(this.now() - (this.fetchStartedAt ?? this.startedAt));
    const detail = ui.muted(`· ${formatBytes(bytes - this.loggedBytes)} · ${elapsed}`);
    this.log(
      `  ${ui.success(`Fetched ${plural(copies.done - this.loggedPaths, "path")} ${detail}`)}`,
    );
    this.loggedPaths = copies.done;
    this.loggedBytes = bytes;
    this.fetchStartedAt = undefined;
  }

  private message(event: NixEvent): void {
    const text = event.msg ?? "";
    const level = event.level ?? LVL_INFO;
    if (level <= LVL_ERROR) {
      this.errors.push(text);
      return;
    }
    const plain = stripVTControlCharacters(text);
    // printMissing's headline, worded this way since Nix 2.0.
    const plan = /^(?:these (\d+) derivations|this derivation) will be built/.exec(plain);
    if (plan !== null) {
      this.plannedBuilds += Number(plan[1] ?? 1);
    }
    if (level === LVL_WARN) {
      this.log(ui.warning(plain.replace(/^warning:\s*/, "")));
      return;
    }
    // Headlines such as "these 12 derivations will be built:"; the indented path lists are noise.
    if (level <= LVL_INFO && plain.trim() !== "" && !/^\s/.test(plain)) {
      this.log(ui.muted(plain.replace(/:$/, "")));
    }
  }
}

/** Parse one stderr line; anything that is not a Nix event is raw output. */
function parseLine(line: string): NixEvent | undefined {
  if (!line.startsWith("@nix ")) {
    return undefined;
  }
  try {
    return Option.getOrUndefined(decodeNixEvent(JSON.parse(line.slice(5))));
  } catch {
    return undefined;
  }
}

/** Keeps the terminal title in step without rewriting it for every event. */
function sessionReporter(session: NixBuildSession | undefined, state: NixBuildState) {
  let label: string | undefined;
  let percent: number | undefined;
  return () => {
    if (session === undefined) {
      return;
    }
    const next = state.label();
    if (next !== label) {
      session.phase(next);
      label = next;
      percent = undefined;
    }
    const builds = state.builds();
    const paths = state.paths();
    const done = builds.done + paths.done;
    const total = builds.total + paths.total;
    const nextPercent = total > 0 ? Math.floor((done * 100) / total) : undefined;
    if (nextPercent !== undefined && nextPercent !== percent) {
      session.progress(done, total);
      percent = nextPercent;
    }
  };
}

/** Two live rows under the log: what Nix is doing, then its latest output line. */
function liveRows(stream: NodeJS.WriteStream, state: NixBuildState) {
  const width = () => Math.max(20, (stream.columns ?? 80) - 1);
  // cli-progress clips rows with a raw substr that counts escape codes, so fit them first.
  const renderMain = () => {
    const icon = `${pc.cyan(ACTIVITY_ICON)} `;
    const row = state.mainRow();
    const budget = width() - icon.length - row.head.length - row.tail.length;
    return `${icon}${row.head}${truncate(row.middle, budget)}${row.tail}`;
  };
  const renderDetail = () => {
    const prefix = "    › ";
    const overhead = pc.dim(prefix).length - prefix.length;
    return pc.dim(truncate(`${prefix}${state.detailRow()}`, width() - overhead));
  };
  const container = new cliProgress.MultiBar({
    format: (_options, _params, payload: { render: () => string }) => payload.render(),
    stream,
    forceRedraw: true,
    fps: 5,
    gracefulExit: true,
    hideCursor: true,
    linewrap: true,
    clearOnComplete: true,
    stopOnComplete: false,
  });
  const main = container.create(1, 0, { render: renderMain });
  let detail: cliProgress.SingleBar | undefined;
  return {
    log: (message: string) => container.log(`${message}\n`),
    sync: () => {
      const wanted = state.detailRow() !== "";
      if (wanted && detail === undefined) {
        detail = container.create(1, 0, { render: renderDetail });
      } else if (!wanted && detail !== undefined) {
        container.remove(detail);
        detail = undefined;
      }
    },
    stop: () => {
      // remove() flushes queued logs; stop() alone would drop them (cli-progress 3.12).
      if (detail !== undefined) {
        container.remove(detail);
      }
      container.remove(main);
      container.stop();
    },
  };
}

/** Turn Nix's event stream into live rows, a log of notable steps, and a summary. */
export function createNixBuildProgress(options: NixBuildProgressOptions = {}): NixBuildProgress {
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  const isTTY = stream.isTTY;
  let finished = false;
  const log = (message: string) =>
    rows !== undefined && !finished ? rows.log(message) : stream.write(`${message}\n`);
  const state = new NixBuildState(now, log);
  const rows = isTTY ? liveRows(stream, state) : undefined;
  const report = sessionReporter(options.session, state);
  const heartbeat = isTTY
    ? undefined
    : setInterval(() => {
        const row = state.mainRow();
        log(ui.muted(`${ACTIVITY_ICON} ${row.head}${row.middle}${row.tail}`));
      }, HEARTBEAT_MS);
  heartbeat?.unref();

  return {
    feed: (line) => {
      if (finished) {
        return;
      }
      const event = parseLine(line);
      if (event === undefined) {
        state.raw(line);
      } else {
        state.apply(event);
      }
      rows?.sync();
      report();
    },
    finish: (success) => {
      if (finished) {
        return;
      }
      clearInterval(heartbeat);
      if (success) {
        // Level-0 output of a successful build is evaluation output such as builtins.trace.
        for (const text of state.errors) {
          log(ui.note(stripVTControlCharacters(text)));
        }
      }
      rows?.stop();
      finished = true;
      if (success) {
        const summary = summaryLine(
          state.built,
          state.paths().done,
          now() - state.startedAt,
          state.waitedForLock,
        );
        stream.write(`${ui.success(summary)}\n`);
      }
    },
    failureDetail: () => {
      const detail = (state.errors.length > 0 ? state.errors : state.rawTail).join("\n").trim();
      return isTTY ? detail : stripVTControlCharacters(detail);
    },
  };
}
