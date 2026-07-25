#!/usr/bin/env bun
/**
 * verify-drivers — replay every starter's `demo.beats.json` the way the Demo
 * Driver would, and prove it green before anyone points a camera at it.
 *
 * For each `starters/**\/demo.beats.json`:
 *
 *   1. Schema — ids unique, actions known, per-action required fields present,
 *      every `command` beat classified (`verify.mode`), pacing sane.
 *   2. Materialize — replay `reset` / `type` beats with the driver's exact
 *      semantics (replace · append · anchor+position · sourceLines slice ·
 *      appendNewline) into the real scratch files the drive writes.
 *   3. Ladder integrity — when a manifest types a starter's own spec back in
 *      contiguous `sourceLines` slices, assert the materialized scratch file is
 *      byte-identical to the committed source. A driver can never drift from
 *      the starter it demos.
 *   4. Offline commands — run every `verify.mode: offline` command beat, in
 *      order, from the manifest's `cwd`, at the file state that beat will see,
 *      and assert its exit code matches `expectedExit`.
 *   5. Paths — assert every `open` file and every `type` source resolves at
 *      that point in the drive (beats a needs-key/manual step produces are
 *      reported, not failed).
 *
 * `needs-key` and `manual` beats are not executed — they need a live API key or
 * a human at the keyboard. They are still schema- and path-checked.
 *
 * Usage:
 *   bun scripts/verify-drivers.ts                     # every driver
 *   bun scripts/verify-drivers.ts cli rag             # only matching manifests
 *   bun scripts/verify-drivers.ts --report out.json   # machine-readable report
 *   bun scripts/verify-drivers.ts --keep              # leave scratch dirs behind
 *   bun scripts/verify-drivers.ts --schema-only       # skip running commands
 *
 * Env:
 *   CREWHAUS_BIN   an explicit CLI to exercise; wins over every other candidate
 *   FACTORY_PATH   a factory checkout to resolve the source CLI from
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const REPO = resolve(import.meta.dir, "..");

/**
 * Resolve the CLI a beat's bare `crewhaus …` should reach, then put a shim for
 * it first on PATH — so beat commands stay exactly what a viewer types.
 *
 * Precedence, deliberately different from scripts/compile.ts: a demo driver
 * demos the *published* product, so an installed `crewhaus` is the authority
 * when one exists. CI has none, and falls through to the sibling factory
 * checkout it already clones.
 *   1. CREWHAUS_BIN            explicit override
 *   2. `crewhaus` on PATH      what the operator recording the screencast has
 *   3. FACTORY_PATH/../factory the source CLI (contributor + CI path)
 *   4. node_modules/crewhaus   after `bun add -d crewhaus` in this repo
 *   5. `bun x crewhaus`        last resort
 */
function resolveCli(): { argv: string[]; label: string } {
  const bin = process.env.CREWHAUS_BIN;
  if (bin) return { argv: [bin], label: `CREWHAUS_BIN=${bin}` };
  const onPath = spawnSync("command", ["-v", "crewhaus"], { shell: true, encoding: "utf8" });
  if ((onPath.status ?? 1) === 0 && onPath.stdout.trim()) {
    return { argv: [onPath.stdout.trim()], label: onPath.stdout.trim() };
  }
  const factoryRoot = process.env.FACTORY_PATH ?? join(REPO, "..", "factory");
  const sourceCli = join(factoryRoot, "apps", "cli", "src", "index.ts");
  if (existsSync(sourceCli)) return { argv: ["bun", sourceCli], label: `factory source ${sourceCli}` };
  const installed = join(REPO, "node_modules", "crewhaus", "src", "index.ts");
  if (existsSync(installed)) return { argv: ["bun", installed], label: "node_modules/crewhaus" };
  return { argv: ["bun", "x", "crewhaus"], label: "bun x crewhaus" };
}

const CLI = resolveCli();

/** A `crewhaus` shim first on PATH, so every beat command runs verbatim. */
function shimPath(): string {
  const dir = join(REPO, "node_modules", ".cache", "crewhaus-driver-shim");
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "crewhaus");
  const quoted = CLI.argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  // Written atomically: concurrent verify runs (one per starter, say) must never
  // observe a half-written shim.
  const tmp = `${shim}.${process.pid}.tmp`;
  writeFileSync(tmp, `#!/bin/sh\nexec ${quoted} "$@"\n`);
  chmodSync(tmp, 0o755);
  renameSync(tmp, shim);
  return dir;
}

const SHIM_DIR = shimPath();
const BEAT_PATH = `${SHIM_DIR}:${process.env.PATH ?? ""}`;

// ── beat types (mirrors crewhaus/demo-driver's src/extension.ts) ────────────
type VerifyMode = "offline" | "needs-key" | "manual";
type Beat = {
  id: string;
  label: string;
  cue?: string;
  action: "open" | "type" | "reset" | "command" | "input";
  file?: string;
  preview?: boolean;
  command?: string;
  text?: string;
  target?: string;
  source?: string;
  sourceLines?: [number, number];
  replace?: boolean;
  anchor?: string;
  position?: "after" | "before" | "replace";
  appendNewline?: boolean;
  speedMsPerChar?: number;
  chunk?: number;
  // verify-only (ignored by the extension, which reads known fields only)
  verify?: { mode: VerifyMode; expectedExit?: number; note?: string; produces?: string[] };
};
type Manifest = {
  title?: string;
  cwd?: string;
  defaults?: { target?: string; speedMsPerChar?: number; chunk?: number };
  groups?: { title: string; beats: Beat[] }[];
  beats?: Beat[];
};

// ── cli args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const filters = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--report");
const KEEP = flag("keep");
const SCHEMA_ONLY = flag("schema-only");
const REPORT = opt("report");

// ── findings ────────────────────────────────────────────────────────────────
type Finding = { manifest: string; beat?: string; kind: string; message: string };
const failures: Finding[] = [];
const warnings: Finding[] = [];
type Stat = {
  manifest: string;
  title: string;
  groups: number;
  beats: number;
  byAction: Record<string, number>;
  byMode: Record<string, number>;
  ran: number;
  ladder: string;
  ok: boolean;
};
const stats: Stat[] = [];

const fail = (manifest: string, kind: string, message: string, beat?: string) =>
  failures.push({ manifest, beat, kind, message });
const warn = (manifest: string, kind: string, message: string, beat?: string) =>
  warnings.push({ manifest, beat, kind, message });

// ── driver semantics: materialize a `type` beat ─────────────────────────────
/** The exact text a `type` beat inserts (extension.ts runType). */
function typedText(beat: Beat, manifestDir: string): string {
  let text: string;
  if (typeof beat.text === "string") {
    text = beat.text;
  } else if (beat.source) {
    const raw = readFileSync(join(manifestDir, beat.source), "utf8");
    if (beat.sourceLines) {
      const [a, b] = beat.sourceLines;
      text = raw.split("\n").slice(Math.max(0, a - 1), b).join("\n");
      if (!text.endsWith("\n")) text += "\n";
    } else {
      text = raw;
    }
  } else {
    throw new Error("neither text nor source");
  }
  if (beat.appendNewline && !text.endsWith("\n")) text += "\n";
  return text;
}

/** Apply a `type` beat to `body`, mirroring the driver's placement rules. */
function applyType(body: string, beat: Beat, text: string, targetRel: string): string {
  if (beat.replace) return text;
  if (beat.anchor) {
    const idx = body.indexOf(beat.anchor);
    if (idx < 0) {
      throw new Error(`anchor not found in ${targetRel}: ${JSON.stringify(beat.anchor)}`);
    }
    const pos = beat.position ?? "after";
    if (pos === "replace") {
      return body.slice(0, idx) + text + body.slice(idx + beat.anchor.length);
    }
    if (pos === "before") {
      const start = body.lastIndexOf("\n", idx - 1) + 1;
      return body.slice(0, start) + text + body.slice(start);
    }
    const nl = body.indexOf("\n", idx + beat.anchor.length);
    if (nl < 0) return body + (text.startsWith("\n") ? text : `\n${text}`);
    return body.slice(0, nl + 1) + text + body.slice(nl + 1);
  }
  if (body.length > 0 && !body.endsWith("\n") && !text.startsWith("\n")) return `${body}\n${text}`;
  return body + text;
}

// ── ladder integrity ────────────────────────────────────────────────────────
/**
 * A "ladder" driver types one starter file back in contiguous 1-indexed slices.
 * Detect that shape and report it, so step 3 can assert byte-identity.
 */
function ladderClaim(
  beats: Beat[],
  manifestDir: string,
  defaultTarget?: string,
): { source: string; target: string } | null {
  const typed = beats.filter((b) => b.action === "type");
  if (typed.length === 0) return null;
  const sources = new Set(typed.map((b) => b.source ?? ""));
  if (sources.size !== 1 || sources.has("")) return null;
  if (typed.some((b) => !b.sourceLines || b.anchor)) return null;
  const targets = new Set(typed.map((b) => b.target ?? defaultTarget ?? ""));
  if (targets.size !== 1 || targets.has("")) return null;
  const source = typed[0]!.source!;
  const lines = readFileSync(join(manifestDir, source), "utf8").split("\n");
  const total = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  let cursor = 1;
  for (const b of typed) {
    const [a, z] = b.sourceLines!;
    if (a !== cursor) return null;
    cursor = z + 1;
  }
  if (cursor - 1 !== total) return null;
  return { source, target: [...targets][0]! };
}

// ── the demo terminal ───────────────────────────────────────────────────────
/**
 * One persistent shell per manifest, because that is what the Demo Driver has:
 * a single managed terminal that every beat is typed into, in order. State a
 * beat sets — an `export`, a shell variable — carries to the beats after it,
 * exactly as it will on camera. A fresh shell per beat would quietly verify a
 * different drive than the one being recorded.
 *
 * A real shell is the point here: the strings being replayed ARE shell commands,
 * authored in this repo's committed `demo.beats.json` manifests and reviewed
 * like any other source. There is no external or user-supplied input to escape.
 *
 * Each command runs with stdin closed and stderr folded into stdout, then a
 * sentinel line carries its exit code back.
 */
class DemoShell {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private buf = "";
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(
    private cwd: string,
    private path: string,
  ) {}

  private start(): void {
    this.proc = Bun.spawn(["/bin/sh"], {
      cwd: this.cwd,
      env: { ...process.env, PATH: this.path },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    this.buf = "";
  }

  /** Run one beat's command; resolve its exit code and combined output. */
  async run(command: string, timeoutMs = 300_000): Promise<{ code: number; output: string }> {
    if (!this.proc) this.start();
    const sentinel = `__BEAT_EXIT_${Math.abs(hash(command))}__`;
    // The brace group keeps the command's own redirections intact while stdin
    // stays closed — otherwise a beat that reads stdin would swallow the
    // sentinel and hang the run.
    const script = `{ ${command}\n} </dev/null 2>&1\nprintf '${sentinel}%s\\n' "$?"\n`;
    this.proc!.stdin.write(script);
    this.proc!.stdin.flush?.();

    const deadline = Date.now() + timeoutMs;
    const re = new RegExp(`${sentinel}(\\d+)\\n`);
    for (;;) {
      const m = re.exec(this.buf);
      if (m) {
        const output = this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        return { code: Number(m[1]), output };
      }
      if (Date.now() > deadline) {
        this.close();
        return { code: -1, output: `${this.buf}\n[verify-drivers] timed out after ${timeoutMs}ms` };
      }
      const chunk = await Promise.race([
        this.reader!.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (chunk.value) this.buf += new TextDecoder().decode(chunk.value);
      else if (chunk.done) {
        // The shell exited (a beat ran `exit`); restart for the next beat.
        const out = this.buf;
        this.close();
        return { code: -1, output: `${out}\n[verify-drivers] the demo shell exited` };
      }
    }
  }

  close(): void {
    try {
      this.reader?.cancel();
      this.proc?.kill();
    } catch {
      /* best effort */
    }
    this.proc = null;
    this.reader = null;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// ── run one manifest ────────────────────────────────────────────────────────
const VALID_ACTIONS = new Set(["open", "type", "reset", "command", "input"]);
const VALID_MODES = new Set<VerifyMode>(["offline", "needs-key", "manual"]);

/**
 * A pipe swallows the exit code of everything left of it (this shell has no
 * pipefail, and turning it on would just make `| head` report SIGPIPE instead),
 * so an offline beat that pipes its `crewhaus` command into a pager asserts
 * nothing at all. Catch the shape rather than pretend the assertion held.
 */
const PIPED_TO_PAGER = /\|\s*(head|tail|less|more|cat)\b/;

async function verifyManifest(manifestPath: string): Promise<void> {
  const rel = relative(REPO, manifestPath);
  const dir = dirname(manifestPath);
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e: any) {
    fail(rel, "json", `invalid JSON: ${e?.message}`);
    return;
  }

  const groups = m.groups?.length ? m.groups : m.beats?.length ? [{ title: "", beats: m.beats }] : [];
  const beats = groups.flatMap((g) => g.beats ?? []);
  const stat: Stat = {
    manifest: rel,
    title: m.title ?? "(untitled)",
    groups: groups.length,
    beats: beats.length,
    byAction: {},
    byMode: {},
    ran: 0,
    ladder: "none",
    ok: true,
  };
  stats.push(stat);
  const before = failures.length;

  if (!m.title) fail(rel, "schema", 'manifest has no "title"');
  if (!m.cwd) fail(rel, "schema", 'manifest has no "cwd" (the demo terminal working dir)');
  if (!beats.length) {
    fail(rel, "schema", "manifest has no beats");
    stat.ok = false;
    return;
  }
  const defaultTarget = m.defaults?.target;

  // ── 1. schema ─────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const b of beats) {
    stat.byAction[b.action] = (stat.byAction[b.action] ?? 0) + 1;
    if (!b.id) fail(rel, "schema", "beat with no id");
    else if (seen.has(b.id)) fail(rel, "schema", `duplicate beat id "${b.id}"`, b.id);
    seen.add(b.id);
    if (!b.label) fail(rel, "schema", "beat has no label", b.id);
    if (!VALID_ACTIONS.has(b.action)) fail(rel, "schema", `unknown action "${b.action}"`, b.id);
    if (b.action === "open" && !b.file) fail(rel, "schema", "action:open with no file", b.id);
    if (b.action === "reset" && !(b.file ?? b.target)) {
      fail(rel, "schema", "action:reset with no file/target", b.id);
    }
    if (b.action === "type") {
      if (typeof b.text !== "string" && !b.source) {
        fail(rel, "schema", "action:type with neither text nor source", b.id);
      }
      if (!(b.target ?? defaultTarget)) {
        fail(rel, "schema", "action:type with no target and no defaults.target", b.id);
      }
      if (b.sourceLines && !b.source) fail(rel, "schema", "sourceLines without source", b.id);
      if (b.sourceLines && (b.sourceLines[0] < 1 || b.sourceLines[1] < b.sourceLines[0])) {
        fail(rel, "schema", `bad sourceLines ${JSON.stringify(b.sourceLines)}`, b.id);
      }
    }
    if (b.action === "command" && !b.command) fail(rel, "schema", "action:command with no command", b.id);
    if (b.action === "input" && typeof b.text !== "string") {
      fail(rel, "schema", "action:input with no text", b.id);
    }
    if (b.action === "command" || b.action === "input") {
      const mode = b.verify?.mode;
      if (!mode) fail(rel, "classify", `${b.action} beat has no verify.mode`, b.id);
      else if (!VALID_MODES.has(mode)) fail(rel, "classify", `bad verify.mode "${mode}"`, b.id);
      else {
        stat.byMode[mode] = (stat.byMode[mode] ?? 0) + 1;
        if (mode === "offline" && typeof b.verify?.expectedExit !== "number") {
          fail(rel, "classify", "offline beat has no verify.expectedExit", b.id);
        }
        if (mode !== "offline" && !(b.cue ?? "").startsWith(`[${mode}]`)) {
          warn(rel, "cue", `${mode} beat's cue should start with "[${mode}]"`, b.id);
        }
      }
    }
    if (b.action === "command" && b.command?.includes(" && cd ")) {
      warn(rel, "style", "compound cd — give the cd its own beat", b.id);
    }
    if (b.action === "command" && b.verify?.mode === "offline" && PIPED_TO_PAGER.test(b.command ?? "")) {
      fail(
        rel,
        "classify",
        "offline beat pipes into a pager, so expectedExit only asserts the pager's status — " +
          "drop the pipe, or redirect to a file and `open` it",
        b.id,
      );
    }
  }

  // ── terminal cwd ──────────────────────────────────────────────────────────
  const termCwd = resolve(dir, m.cwd ?? ".");
  if (!existsSync(termCwd)) fail(rel, "cwd", `manifest cwd does not resolve: ${m.cwd}`);

  // ── 2/4/5. replay ─────────────────────────────────────────────────────────
  const scratch = new Set<string>(); // absolute dirs to sweep afterwards
  const fs_ = new Map<string, string>(); // materialized bodies, abs path → text
  const producedByUnrun = new Set<string>(); // paths only a skipped beat creates
  let shell: DemoShell | null = null; // the manifest's one demo terminal

  const noteScratch = (absFile: string) => {
    // Sweep the top-level scratch dir under the manifest dir (e.g. live/).
    const r = relative(dir, absFile);
    const top = r.split("/")[0];
    if (top && top !== ".." && r !== top) scratch.add(join(dir, top));
  };

  for (const b of beats) {
    try {
      if (b.action === "reset") {
        const abs = resolve(dir, (b.file ?? b.target)!);
        fs_.set(abs, "");
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "");
        noteScratch(abs);
      } else if (b.action === "type") {
        const targetRel = (b.target ?? defaultTarget)!;
        const abs = resolve(dir, targetRel);
        if (b.source && !existsSync(join(dir, b.source))) {
          fail(rel, "path", `type source missing: ${b.source}`, b.id);
          continue;
        }
        const text = typedText(b, dir);
        const body = fs_.get(abs) ?? (existsSync(abs) ? readFileSync(abs, "utf8") : "");
        const next = applyType(body, b, text, targetRel);
        fs_.set(abs, next);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, next);
        noteScratch(abs);
      } else if (b.action === "open") {
        const abs = resolve(dir, b.file!);
        const known = fs_.has(abs) || existsSync(abs);
        if (!known) {
          if (producedByUnrun.has(abs) || b.verify?.mode) {
            warn(rel, "path", `opens a file a skipped beat produces: ${b.file}`, b.id);
          } else {
            fail(rel, "path", `open file missing: ${b.file}`, b.id);
          }
        }
      } else if (b.action === "command") {
        for (const p of b.verify?.produces ?? []) producedByUnrun.add(resolve(dir, p));
        if (SCHEMA_ONLY || b.verify?.mode !== "offline") continue;
        shell ??= new DemoShell(termCwd, BEAT_PATH);
        const res = await shell.run(b.command!);
        stat.ran++;
        const code = res.code;
        const want = b.verify!.expectedExit ?? 0;
        if (code !== want) {
          const tail = res.output.trim().split("\n").slice(-6).join("\n");
          fail(rel, "command", `exit ${code} (want ${want}) for \`${b.command}\`\n      ${tail}`, b.id);
        }
        for (const p of b.verify?.produces ?? []) {
          const abs = resolve(dir, p);
          producedByUnrun.delete(abs);
          if (!existsSync(abs)) fail(rel, "produces", `did not produce ${p}`, b.id);
          noteScratch(abs);
        }
      }
    } catch (e: any) {
      fail(rel, "replay", e?.message ?? String(e), b.id);
    }
  }

  shell?.close();

  // ── 3. ladder integrity ───────────────────────────────────────────────────
  const ladder = ladderClaim(beats, dir, defaultTarget);
  if (ladder) {
    const src = readFileSync(join(dir, ladder.source), "utf8");
    const abs = resolve(dir, ladder.target);
    const got = fs_.get(abs) ?? (existsSync(abs) ? readFileSync(abs, "utf8") : "");
    if (got === src) {
      stat.ladder = `exact (${ladder.source} → ${ladder.target})`;
    } else {
      stat.ladder = "DRIFT";
      fail(
        rel,
        "ladder",
        `typing the slices does not reproduce ${ladder.source} byte-for-byte ` +
          `(got ${got.length} bytes, want ${src.length})`,
      );
    }
  } else if (beats.some((b) => b.action === "type" && b.source)) {
    stat.ladder = "partial (non-contiguous slices)";
  } else if (beats.some((b) => b.action === "type")) {
    stat.ladder = "inline text";
  }

  // ── sweep scratch ─────────────────────────────────────────────────────────
  if (!KEEP) {
    for (const d of scratch) {
      try {
        if (existsSync(d) && statSync(d).isDirectory()) rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  stat.ok = failures.length === before;
}

// ── main ────────────────────────────────────────────────────────────────────
const found = [...new Glob("starters/**/demo.beats.json").scanSync(REPO)].sort();
const targets = found.filter((f) => !filters.length || filters.some((s) => f.includes(s)));
if (!targets.length) {
  console.error(
    filters.length
      ? `verify-drivers: no demo.beats.json matched ${filters.join(", ")}`
      : "verify-drivers: no starters/**/demo.beats.json found",
  );
  process.exit(1);
}

const cliVersion =
  spawnSync(CLI.argv[0]!, [...CLI.argv.slice(1), "--version"], { encoding: "utf8" }).stdout?.trim() ??
  "unknown";
console.log(
  `verify-drivers — ${targets.length} driver(s) · CLI ${cliVersion} (${CLI.label})` +
    `${SCHEMA_ONLY ? " · schema only" : ""}`,
);

for (const t of targets) {
  process.stdout.write(`  ${t} … `);
  const before = failures.length;
  await verifyManifest(join(REPO, t));
  const s = stats[stats.length - 1]!;
  const n = failures.length - before;
  console.log(
    n === 0
      ? `ok (${s.beats} beats, ${s.ran} run, ladder: ${s.ladder})`
      : `${n} FAILURE(S) (${s.beats} beats, ${s.ran} run)`,
  );
}

const totals = stats.reduce(
  (acc, s) => {
    acc.beats += s.beats;
    acc.ran += s.ran;
    for (const [k, v] of Object.entries(s.byAction)) acc.byAction[k] = (acc.byAction[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.byMode)) acc.byMode[k] = (acc.byMode[k] ?? 0) + v;
    return acc;
  },
  { beats: 0, ran: 0, byAction: {} as Record<string, number>, byMode: {} as Record<string, number> },
);

console.log(
  `\n${stats.filter((s) => s.ok).length}/${stats.length} drivers green · ` +
    `${totals.beats} beats (${Object.entries(totals.byAction).map(([k, v]) => `${v} ${k}`).join(", ")}) · ` +
    `${totals.ran} offline commands executed · ` +
    `${Object.entries(totals.byMode).map(([k, v]) => `${v} ${k}`).join(", ")}`,
);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ~ ${w.manifest}${w.beat ? ` [${w.beat}]` : ""}: ${w.message}`);
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  ✗ ${f.manifest}${f.beat ? ` [${f.beat}]` : ""}: ${f.message}`);
}

if (REPORT) {
  writeFileSync(
    resolve(REPORT),
    `${JSON.stringify({ cliVersion, stats, failures, warnings, totals }, null, 2)}\n`,
  );
  console.log(`\nreport → ${REPORT}`);
}

process.exit(failures.length ? 1 : 0);
