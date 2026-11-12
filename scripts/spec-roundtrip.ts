#!/usr/bin/env bun
/**
 * Every spec in this repository round-trips through factory's guarded spec
 * writer (`commitSpec` from `@crewhaus/spec-patch/commit`, the one way a
 * spec file is written).
 *
 * The specs are every tracked `*.yaml` / `*.yml` file (outside `.github/`)
 * whose root is a map with `name` and `target`, and every ```yaml fence in a
 * tracked Markdown file that looks like a whole spec (a `name:` line and a
 * `target:` line, the rule `scripts/test-walkthroughs.ts` uses).
 *
 * Each spec is copied into a fresh temporary directory, never committed in
 * place, and goes through four commits, each on its own copy:
 *
 *  1. Unchanged — a commit with no edits writes nothing and leaves the file
 *     byte-identical.
 *  2. Scalar edit — renaming `name` validates against the spec schema, keeps
 *     the formatting, and changes no byte outside the old `name` value.
 *  3. Added key — adding a top-level key keeps the formatting and changes no
 *     byte except the new line (and a missing final newline before it).
 *  4. Stale revision — a commit computed from another revision writes
 *     nothing, answers `conflict` with the file's revision, and keeps a draft.
 *
 * A tracked YAML file that does not parse is a failure. So is finding fewer
 * specs than the floors below: a filter that stops matching must not pass by
 * checking nothing. Adding a spec needs no edit here.
 *
 * The writer comes from the factory checkout under test: `FACTORY_PATH`, or a
 * sibling `../factory`. The script needs no install in this repository and no
 * network or credentials. It exits 1 on any failure.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FACTORY_ROOT = resolve(process.env["FACTORY_PATH"] ?? join(REPO_ROOT, "..", "factory"));
const SPEC_PATCH_DIR = join(FACTORY_ROOT, "packages", "spec-patch");
const COMMIT_MODULE = join(SPEC_PATCH_DIR, "src", "commit.ts");

/** The fewest spec files and walkthrough specs this repository holds. */
const SPEC_FILE_FLOOR = 40;
const WALKTHROUGH_SPEC_FLOOR = 51;

const ADDED_LINE = "zz_added: value\n";

type Source = { label: string; text: string };

type CommitModule = {
  commitSpec: (
    target: { specPath: string },
    change: { kind: "edits"; edits: ReadonlyArray<{ path: ReadonlyArray<string>; value?: unknown }> },
    opts: {
      expectedRev: string;
      writer: "home.spec";
      actor: { kind: "process" };
      parse?: (yamlText: string) => unknown;
    },
  ) => Promise<
    | { ok: true; wrote: boolean; formatting: string; yaml: string; rev: string }
    | {
        ok: false;
        code: string;
        reason: string;
        current?: { rev: string };
        draft?: { id: string; path: string };
      }
  >;
  specRev: (text: string) => string;
  parseYamlOnly: (yamlText: string) => unknown;
};

type YamlModule = {
  parseDocument: (text: string) => {
    errors: ReadonlyArray<{ message: string }>;
    contents: unknown;
    get: (key: string, keepScalar?: boolean) => unknown;
  };
  isMap: (node: unknown) => node is { has: (key: string) => boolean };
};

const failures: string[] = [];

function fail(label: string, check: string, reason: string): void {
  failures.push(`✗ ${label} ${check}: ${reason}`);
}

/** The first byte offset at which `a` and `b` differ, or -1 when they are equal. */
function firstDiff(a: string, b: string): number {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i;
  return x.length === y.length ? -1 : n;
}

function git(args: string[], cwd: string): string | undefined {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

function trackedFiles(patterns: string[]): string[] {
  const out = git(["ls-files", "-z", "--", ...patterns], REPO_ROOT);
  if (out === undefined) {
    process.stderr.write("[spec-roundtrip] git ls-files failed; run this from a git checkout\n");
    process.exit(1);
  }
  return out.split("\0").filter((p) => p.length > 0);
}

/** Fenced code blocks, as `scripts/test-walkthroughs.ts` finds them. */
function codeFenceRanges(content: string): Array<{ start: number; end: number; lang: string }> {
  const ranges: Array<{ start: number; end: number; lang: string }> = [];
  const lines = content.split("\n");
  let inFence = false;
  let fenceStart = 0;
  let fenceLang = "";
  let offset = 0;
  for (const line of lines) {
    const m = /^```(\S*)/.exec(line);
    if (m) {
      if (!inFence) {
        inFence = true;
        fenceStart = offset;
        fenceLang = m[1] ?? "";
      } else {
        ranges.push({ start: fenceStart, end: offset + line.length, lang: fenceLang });
        inFence = false;
      }
    }
    offset += line.length + 1;
  }
  return ranges;
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function specFiles(yaml: YamlModule): Source[] {
  const specs: Source[] = [];
  for (const rel of trackedFiles(["*.yaml", "*.yml"])) {
    if (rel.startsWith(".github/")) continue;
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    const doc = yaml.parseDocument(text);
    if (doc.errors.length > 0) {
      fail(rel, "parse", `the YAML does not parse: ${doc.errors[0]?.message.split("\n")[0]}`);
      continue;
    }
    const root = doc.contents;
    if (yaml.isMap(root) && root.has("name") && root.has("target")) {
      specs.push({ label: rel, text });
    }
  }
  return specs;
}

function walkthroughSpecs(): Source[] {
  const specs: Source[] = [];
  for (const rel of trackedFiles(["*.md"])) {
    const content = readFileSync(join(REPO_ROOT, rel), "utf8");
    for (const fence of codeFenceRanges(content)) {
      if (fence.lang !== "yaml") continue;
      const inner = content.slice(fence.start, fence.end).split("\n").slice(1, -1).join("\n");
      if (!(/^name:\s/m.test(inner) && /^target:\s/m.test(inner))) continue;
      specs.push({ label: `${rel}:L${lineNumberAt(content, fence.start)}`, text: `${inner}\n` });
    }
  }
  return specs;
}

/** One copy of a spec, in its own directory under `root`. */
class Scratch {
  readonly root: string;
  private next = 0;

  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "spec-roundtrip-")));
  }

  /** A target path is strictly inside the scratch root; anything else stops the run before it writes. */
  assertContained(path: string): void {
    const rel = relative(this.root, resolve(path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`refusing to write outside the scratch directory: ${path}`);
    }
  }

  copy(source: string): string {
    const dir = join(this.root, String(this.next++));
    const path = join(dir, "crewhaus.yaml");
    this.assertContained(path);
    mkdirSync(dir);
    writeFileSync(path, source);
    return path;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function describeFailure(result: { ok: false; code: string; reason: string }): string {
  return `refused (${result.code}): ${result.reason.split("\n")[0]}`;
}

async function roundTrip(
  spec: Source,
  writer: CommitModule,
  yaml: YamlModule,
  scratch: Scratch,
): Promise<void> {
  const s = spec.text;
  const rev = writer.specRev(s);
  const base = { writer: "home.spec", actor: { kind: "process" } } as const;
  const commit: CommitModule["commitSpec"] = (target, change, opts) => {
    scratch.assertContained(target.specPath);
    return writer.commitSpec(target, change, opts);
  };

  // 1. Unchanged.
  {
    const path = scratch.copy(s);
    const r = await commit({ specPath: path }, { kind: "edits", edits: [] }, { ...base, expectedRev: rev });
    const disk = readFileSync(path, "utf8");
    if (!r.ok) fail(spec.label, "unchanged", describeFailure(r));
    else if (r.wrote) fail(spec.label, "unchanged", "a commit with no edits wrote the file");
    else if (disk !== s) fail(spec.label, "unchanged", `the file differs from the source at byte ${firstDiff(s, disk)}`);
  }

  // 2. Scalar edit.
  {
    const doc = yaml.parseDocument(s);
    const node = doc.get("name", true) as { range?: [number, number, number]; value?: unknown } | undefined;
    const range = node?.range;
    if (range === undefined) {
      fail(spec.label, "scalar edit", "the source's `name` has no range to compare around");
    } else {
      const [start, end] = range;
      const renamed = `${String(node?.value)}-renamed`;
      const path = scratch.copy(s);
      const r = await commit(
        { specPath: path },
        { kind: "edits", edits: [{ path: ["name"], value: renamed }] },
        { ...base, expectedRev: rev },
      );
      const disk = readFileSync(path, "utf8");
      if (!r.ok) fail(spec.label, "scalar edit", describeFailure(r));
      else if (!r.wrote) fail(spec.label, "scalar edit", "the rename wrote nothing");
      else if (r.formatting !== "kept") fail(spec.label, "scalar edit", `formatting was ${r.formatting}, not kept`);
      else if (disk !== r.yaml)
        fail(spec.label, "scalar edit", `the file differs from the result at byte ${firstDiff(r.yaml, disk)}`);
      else {
        const out = r.yaml;
        const tail = s.length - end;
        const middleEnd = out.length - tail;
        if (middleEnd < start) {
          fail(spec.label, "scalar edit", "the result is shorter than the bytes around `name`");
        } else if (out.slice(0, start) !== s.slice(0, start)) {
          fail(spec.label, "scalar edit", `a byte before \`name\` changed at byte ${firstDiff(s.slice(0, start), out.slice(0, start))}`);
        } else if (out.slice(middleEnd) !== s.slice(end)) {
          fail(
            spec.label,
            "scalar edit",
            `a byte after \`name\` changed at byte ${Buffer.byteLength(s.slice(0, end)) + firstDiff(s.slice(end), out.slice(middleEnd))} of the source`,
          );
        } else if (!out.slice(start, middleEnd).includes(renamed)) {
          fail(spec.label, "scalar edit", "the new name is not where the old one was");
        }
      }
    }
  }

  // 3. Added key.
  {
    const path = scratch.copy(s);
    const r = await commit(
      { specPath: path },
      { kind: "edits", edits: [{ path: ["zz_added"], value: "value" }] },
      { ...base, expectedRev: rev, parse: writer.parseYamlOnly },
    );
    const disk = readFileSync(path, "utf8");
    if (!r.ok) fail(spec.label, "added key", describeFailure(r));
    else if (!r.wrote) fail(spec.label, "added key", "the added key wrote nothing");
    else if (r.formatting !== "kept") fail(spec.label, "added key", `formatting was ${r.formatting}, not kept`);
    else if (disk !== r.yaml)
      fail(spec.label, "added key", `the file differs from the result at byte ${firstDiff(r.yaml, disk)}`);
    else {
      const out = r.yaml;
      const at = out.indexOf(ADDED_LINE);
      if (at === -1) fail(spec.label, "added key", "the result has no `zz_added: value` line");
      else if (out.indexOf(ADDED_LINE, at + 1) !== -1)
        fail(spec.label, "added key", "the result has more than one `zz_added: value` line");
      else {
        // The writer may add the source's missing final newline before the new key, and nothing else.
        const expected = s.endsWith("\n") ? s : `${s}\n`;
        const without = out.slice(0, at) + out.slice(at + ADDED_LINE.length);
        if (without !== expected) {
          fail(spec.label, "added key", `a byte besides the new line changed at byte ${firstDiff(expected, without)}`);
        }
      }
    }
  }

  // 4. Stale revision.
  {
    const path = scratch.copy(s);
    const doc = yaml.parseDocument(s);
    const r = await commit(
      { specPath: path },
      { kind: "edits", edits: [{ path: ["name"], value: `${String(doc.get("name"))}-renamed` }] },
      { ...base, expectedRev: writer.specRev(`${s}# edited elsewhere\n`) },
    );
    const disk = readFileSync(path, "utf8");
    if (r.ok) fail(spec.label, "stale revision", `a commit from a stale revision succeeded (wrote: ${r.wrote})`);
    else if (r.code !== "conflict") fail(spec.label, "stale revision", `answered ${r.code}, not conflict: ${r.reason}`);
    else if (r.current?.rev !== rev) fail(spec.label, "stale revision", "the conflict does not name the file's revision");
    else if (r.draft === undefined) fail(spec.label, "stale revision", "the conflict kept no draft");
    if (disk !== s)
      fail(spec.label, "stale revision", `the file differs from the source at byte ${firstDiff(s, disk)}`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(COMMIT_MODULE)) {
    process.stderr.write(
      `[spec-roundtrip] the factory under test (${FACTORY_ROOT}) has no guarded spec writer: packages/spec-patch/src/commit.ts is missing (it ships in crewhaus/factory#565 and later)\n`,
    );
    process.exit(1);
  }
  const writer = (await import(COMMIT_MODULE)) as CommitModule;
  const yaml = (await import(Bun.resolveSync("yaml", SPEC_PATCH_DIR))) as YamlModule;

  const files = specFiles(yaml);
  const fences = walkthroughSpecs();
  if (files.length < SPEC_FILE_FLOOR) {
    fail("spec files", "count", `found ${files.length}, fewer than the floor of ${SPEC_FILE_FLOOR}`);
  }
  if (fences.length < WALKTHROUGH_SPEC_FLOOR) {
    fail("walkthrough specs", "count", `found ${fences.length}, fewer than the floor of ${WALKTHROUGH_SPEC_FLOOR}`);
  }

  const scratch = new Scratch();
  try {
    for (const spec of [...files, ...fences]) {
      try {
        await roundTrip(spec, writer, yaml, scratch);
      } catch (err) {
        fail(spec.label, "round trip", (err as Error).message);
        if ((err as Error).message.startsWith("refusing to write outside")) break;
      }
    }
  } finally {
    scratch.dispose();
  }

  if (failures.length > 0) {
    for (const line of failures) process.stderr.write(`${line}\n`);
    process.stderr.write(`\n[spec-roundtrip] ${failures.length} failure(s)\n`);
    process.exit(1);
  }
  const head = git(["rev-parse", "HEAD"], FACTORY_ROOT)?.trim();
  process.stdout.write(
    `[spec-roundtrip] ${files.length} spec files and ${fences.length} walkthrough specs round-trip through the guarded spec writer${head ? ` (factory ${head})` : ""}\n`,
  );
}

await main();
