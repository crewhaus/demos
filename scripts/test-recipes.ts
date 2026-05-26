#!/usr/bin/env bun
/**
 * Static validation for recipes/*.md.
 *
 * For every recipe file, the script runs a set of checks that catch the
 * kinds of bugs human reviewers shouldn't have to find:
 *
 *  1. Markdown links to local paths resolve to files that exist.
 *  2. Embedded YAML code fences that look like full crewhaus.yaml specs
 *     parse cleanly through `crewhaus compile`.
 *  3. `bun run <script>` commands reference scripts that exist in
 *     package.json.
 *  4. Optional frontmatter `test:` blocks declare:
 *       - `spec`       — path to a spec file the recipe relies on
 *                        (validated by `crewhaus compile`).
 *       - `bun_scripts` — script names that must exist in package.json.
 *       - `packages`    — package directories that must exist.
 *
 * The script is fast (~few-second on the full recipe set), deterministic,
 * and requires zero network or API credentials. It is the right thing
 * to run on every PR that touches recipes/.
 *
 * For live runs of the smoke commands (compile + execute), see
 * scripts/smoke-recipes.ts, which is gated behind an env var and an
 * Anthropic credential.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RECIPES_DIR = join(REPO_ROOT, "recipes");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
const FACTORY_ROOT = resolve(process.env["FACTORY_PATH"] ?? join(REPO_ROOT, "..", "factory"));
const CLI_ENTRY = join(FACTORY_ROOT, "apps", "cli", "src", "index.ts");

type Failure = {
  recipe: string;
  line?: number;
  message: string;
};

type Recipe = {
  path: string;
  rel: string;
  content: string;
  frontmatter: RecipeFrontmatter;
};

type RecipeFrontmatter = {
  spec?: string;
  bunScripts?: string[];
  packages?: string[];
};

const failures: Failure[] = [];
let pkgScripts: Set<string> | undefined;

// Aspirational scripts: recipes describe sections that haven't been built
// yet (or scripts that were removed during the factory→demos split and
// haven't been re-homed). The matching `bun run` commands and frontmatter
// `bun_scripts` entries are recognised by the recipe author as TODO. The
// gate stays active for *any other* unknown script — drop an entry from
// this set once the corresponding script lands in factory or demos.
const ASPIRATIONAL_SCRIPTS = new Set<string>([
  "build:binary", // recipe 24 (docker-and-helm)
  "compile:section-09-mcp-smoke", // recipe 13 (mcp-servers)
  "play:jetbrains", // recipe 25 (vscode-and-jetbrains)
  "run:section-09-mcp-smoke", // recipe 13 (mcp-servers)
  "smoke:section-13", // recipe 28 (sub-agents-and-task)
  "smoke:section-18", // recipe 30 (sandboxed-code-execution)
  "smoke:section-29", // recipe 12 (eval-harness)
  "smoke:section-32", // recipes 24, 36
  "smoke:section-33-discord", // recipe 38
  "smoke:section-33-imessage", // recipe 40
  "smoke:section-33-telegram", // recipe 37
  "smoke:section-33-whatsapp", // recipe 39
  "smoke:section-34", // recipe 27 (federation)
  "smoke:section-35-jetbrains", // recipe 25
  "smoke:section-35-playground", // recipes 25, 35
  "smoke:section-35-vscode", // recipe 25
  "smoke:section-36-registry", // recipe 30
  "smoke:section-39-compliance", // recipe 23
  "smoke:section-39-enc", // recipe 23
  "smoke:section-39-pii", // recipe 23
  "smoke:section-39-retention", // recipe 23
  "studio", // recipe 35 (studio-walkthrough)
]);

function loadPkgScripts(): Set<string> {
  if (pkgScripts) return pkgScripts;
  // Recipes can reference scripts from either repo: hello-* demos here,
  // section-NN-smoke fixtures still in factory. Accept both so a recipe's
  // bun_scripts entry like `smoke:section-33-imessage` validates against
  // factory's package.json without us having to copy the script over.
  const set = new Set<string>(ASPIRATIONAL_SCRIPTS);
  for (const pkgPath of [PACKAGE_JSON, join(FACTORY_ROOT, "package.json")]) {
    if (!existsSync(pkgPath)) continue;
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    for (const name of Object.keys(parsed.scripts ?? {})) set.add(name);
  }
  pkgScripts = set;
  return pkgScripts;
}

function loadRecipes(): Recipe[] {
  const out: Recipe[] = [];
  for (const name of readdirSync(RECIPES_DIR).sort()) {
    if (!name.endsWith(".md")) continue;
    const path = join(RECIPES_DIR, name);
    const content = readFileSync(path, "utf-8");
    out.push({
      path,
      rel: relative(REPO_ROOT, path),
      content,
      frontmatter: parseFrontmatter(content),
    });
  }
  return out;
}

/**
 * Parse the recipe's leading YAML frontmatter into a plain object. We
 * support exactly the shape we need (a `test:` block with `spec`,
 * `bun_scripts`, `packages` fields), not arbitrary YAML — keeps the
 * script dependency-free.
 *
 *   ---
 *   test:
 *     spec: hello-cli/crewhaus.yaml
 *     bun_scripts:
 *       - compile:hello
 *       - run:hello
 *     packages:
 *       - packages/runtime-core
 *   ---
 */
function parseFrontmatter(content: string): RecipeFrontmatter {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const yaml = content.slice(4, end);
  const lines = yaml.split("\n");
  const out: RecipeFrontmatter = {};
  let inTest = false;
  let inList: "bunScripts" | "packages" | undefined;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue; // comment
    const line = raw.replace(/\r$/, "");
    if (/^test:\s*$/.test(line)) {
      inTest = true;
      continue;
    }
    if (!inTest) continue;
    const specM = /^\s{2}spec:\s*(.+?)\s*$/.exec(line);
    if (specM?.[1] !== undefined) {
      out.spec = stripQuotes(specM[1]);
      inList = undefined;
      continue;
    }
    if (/^\s{2}bun_scripts:\s*$/.test(line)) {
      inList = "bunScripts";
      out.bunScripts = [];
      continue;
    }
    if (/^\s{2}packages:\s*$/.test(line)) {
      inList = "packages";
      out.packages = [];
      continue;
    }
    const itemM = /^\s{4}-\s*(.+?)\s*$/.exec(line);
    if (itemM?.[1] !== undefined && inList !== undefined) {
      const v = stripQuotes(itemM[1]);
      const bucket = out[inList];
      if (bucket !== undefined) bucket.push(v);
      continue;
    }
    if (/^\S/.test(line)) {
      // Top-level key other than `test:` — leave the test block.
      inTest = false;
      inList = undefined;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

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

function isInsideFence(position: number, ranges: Array<{ start: number; end: number }>): boolean {
  for (const r of ranges) {
    if (position >= r.start && position <= r.end) return true;
  }
  return false;
}

function lineNumberAt(content: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Validate a spec file (or spec source string) by compiling it with
 * the in-tree CLI. The compiler runs parse → lower → emit so a clean
 * exit code is strong evidence the spec is well-formed.
 *
 * We compile into a tmpdir and clean up; the recipe is not modified.
 */
function tryCompileSpec(specText: string): { ok: boolean; stderr: string } {
  const tmpRoot = mkdtempSync(join(tmpdir(), "recipe-test-"));
  try {
    const specPath = join(tmpRoot, "crewhaus.yaml");
    const outDir = join(tmpRoot, "out");
    writeFileSync(specPath, specText, "utf-8");
    // Suppress the CLI logger's debug stream so stderr carries only the
    // user-facing `crewhaus: …` error lines.
    const result = spawnSync("bun", [CLI_ENTRY, "compile", specPath, "-o", outDir], {
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", CREWHAUS_LOG_LEVEL: "error" },
    });
    if (result.status === 0) return { ok: true, stderr: "" };
    const lines = result.stderr.split("\n").filter((l) => l.trim() !== "");
    // Prefer `crewhaus:` lines (the user-facing compiler error). Fall
    // back to other non-warning lines if not present; only as a last
    // resort report the first noisy line. Adapter-emitted warnings
    // (e.g. `[adapter-anthropic] could not detect claude CLI...`) are
    // skipped so the real failure surfaces.
    const userLine = lines.find((l) => l.startsWith("crewhaus:"));
    if (userLine) return { ok: false, stderr: userLine };
    const nonWarning = lines.find(
      (l) =>
        !l.startsWith("[adapter-") &&
        !l.startsWith("[mcp]") &&
        !l.includes("could not detect installed claude CLI"),
    );
    return { ok: false, stderr: nonWarning ?? lines[0] ?? "(no error output)" };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Check #1 — every `[text](path)` link that isn't an external URL must
 * resolve to a file or directory that exists. Links inside fenced code
 * blocks are skipped (they're examples, not navigation).
 */
function checkLinks(recipe: Recipe): void {
  const fences = codeFenceRanges(recipe.content);
  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
  while ((m = linkRe.exec(recipe.content)) !== null) {
    if (isInsideFence(m.index, fences)) continue;
    const url = m[1];
    if (url === undefined) continue;
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:"))
      continue;
    if (url.startsWith("#")) continue;
    const beforeHash = url.split("#")[0];
    if (beforeHash === undefined) continue;
    const targetPart = beforeHash.replace(/:\d+$/, "");
    if (targetPart === "") continue;
    const resolved = resolve(dirname(recipe.path), targetPart);
    if (!existsSync(resolved)) {
      failures.push({
        recipe: recipe.rel,
        line: lineNumberAt(recipe.content, m.index),
        message: `broken link: ${targetPart} (resolved to ${relative(REPO_ROOT, resolved)})`,
      });
    }
  }
}

/**
 * Check #2 — every embedded ```yaml fenced block that looks like a
 * complete crewhaus spec (`name:` + `target:` both present) is compiled
 * through the in-tree CLI. The check catches schema drift, unknown
 * keys, and missing required fields.
 *
 * Inline snippets that show partial fields (e.g. just a `permissions:`
 * block for illustration) don't satisfy the heuristic and are skipped.
 */
function checkEmbeddedSpecs(recipe: Recipe): void {
  const fences = codeFenceRanges(recipe.content);
  for (const fence of fences) {
    if (fence.lang !== "yaml") continue;
    const slice = recipe.content.slice(fence.start, fence.end);
    const inner = slice.split("\n").slice(1, -1).join("\n");
    const looksLikeSpec = /^name:\s/m.test(inner) && /^target:\s/m.test(inner);
    if (!looksLikeSpec) continue;
    const result = tryCompileSpec(inner);
    if (!result.ok) {
      failures.push({
        recipe: recipe.rel,
        line: lineNumberAt(recipe.content, fence.start),
        message: `embedded spec failed to compile: ${result.stderr.split("\n")[0]}`,
      });
    }
  }
}

/**
 * Check #3 — every `bun run <script>` reference must match a script
 * defined in package.json.
 */
function checkBunRunScripts(recipe: Recipe): void {
  const scripts = loadPkgScripts();
  const re = /\bbun run ([a-zA-Z0-9_:.\-/]+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
  while ((m = re.exec(recipe.content)) !== null) {
    const script = m[1];
    if (script === undefined) continue;
    if (!scripts.has(script)) {
      failures.push({
        recipe: recipe.rel,
        line: lineNumberAt(recipe.content, m.index),
        message: `bun run "${script}" is not a script in package.json`,
      });
    }
  }
}

/**
 * Check #4 — opt-in frontmatter checks.
 */
function checkFrontmatter(recipe: Recipe): void {
  const fm = recipe.frontmatter;
  if (fm.spec !== undefined) {
    // Specs may live in demos (hello-* tutorials) or factory (section-NN-smoke
    // fixtures). Try demos first, then factory's examples/.
    const candidates = [
      resolve(REPO_ROOT, fm.spec),
      resolve(FACTORY_ROOT, "examples", fm.spec.replace(/^examples\//, "")),
    ];
    const specPath = candidates.find((p) => existsSync(p));
    if (specPath === undefined) {
      failures.push({
        recipe: recipe.rel,
        message: `frontmatter test.spec → ${fm.spec} does not exist (looked in ${candidates.join(", ")})`,
      });
    } else {
      const text = readFileSync(specPath, "utf-8");
      const r = tryCompileSpec(text);
      if (!r.ok) {
        failures.push({
          recipe: recipe.rel,
          message: `frontmatter test.spec ${fm.spec} failed to compile: ${r.stderr.split("\n")[0]}`,
        });
      }
    }
  }
  if (fm.bunScripts !== undefined) {
    const scripts = loadPkgScripts();
    for (const name of fm.bunScripts) {
      if (!scripts.has(name)) {
        failures.push({
          recipe: recipe.rel,
          message: `frontmatter test.bun_scripts → "${name}" is not in package.json`,
        });
      }
    }
  }
  if (fm.packages !== undefined) {
    // Recipe `packages:` entries name @crewhaus/* packages that live in the
    // sibling factory repo, e.g. `packages/eval-runner`. Resolve against
    // FACTORY_ROOT, not REPO_ROOT (demos has no `packages/` of its own).
    for (const pkg of fm.packages) {
      const p = resolve(FACTORY_ROOT, pkg);
      if (!existsSync(p) || !statSync(p).isDirectory()) {
        failures.push({
          recipe: recipe.rel,
          message: `frontmatter test.packages → "${pkg}" is not a directory under FACTORY_ROOT (${FACTORY_ROOT})`,
        });
      }
    }
  }
}

function checkUniqueNumbers(recipes: Recipe[]): void {
  const byNumber = new Map<number, string[]>();
  for (const recipe of recipes) {
    const basename = recipe.rel.split("/").pop() ?? recipe.rel;
    const m = basename.match(/^(\d{2})-/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const list = byNumber.get(n) ?? [];
    list.push(recipe.rel);
    byNumber.set(n, list);
  }
  for (const [n, files] of byNumber) {
    if (files.length > 1) {
      failures.push({
        recipe: files[0],
        message: `duplicate recipe number ${String(n).padStart(2, "0")} shared by: ${files.join(", ")}. Each numbered recipe must claim a unique number.`,
      });
    }
  }
}

function main(): void {
  const recipes = loadRecipes();
  if (recipes.length === 0) {
    process.stderr.write("no recipes found in recipes/\n");
    process.exit(1);
  }

  checkUniqueNumbers(recipes);

  for (const recipe of recipes) {
    checkLinks(recipe);
    checkEmbeddedSpecs(recipe);
    checkBunRunScripts(recipe);
    checkFrontmatter(recipe);
  }

  if (failures.length === 0) {
    process.stdout.write(`✓ all ${recipes.length} recipe(s) validated\n`);
    return;
  }

  const grouped = new Map<string, Failure[]>();
  for (const f of failures) {
    const list = grouped.get(f.recipe) ?? [];
    list.push(f);
    grouped.set(f.recipe, list);
  }
  for (const [recipe, list] of grouped) {
    process.stderr.write(`\n${recipe}\n`);
    for (const f of list) {
      const prefix = f.line === undefined ? "  " : `  L${f.line}: `;
      process.stderr.write(`${prefix}${f.message}\n`);
    }
  }
  process.stderr.write(`\n${failures.length} failure(s) across ${grouped.size} recipe(s)\n`);
  process.exit(1);
}

main();
