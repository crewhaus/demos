/**
 * Granular LOC counting shared by the metrics harness.
 *
 * Two counts are produced for every file/region:
 *   - raw     : total physical lines
 *   - code    : non-blank lines that are not pure comments (the honest count)
 *
 * Comment stripping is line-oriented and conservative for TS/JS and YAML:
 *   - blank / whitespace-only lines are excluded from `code`
 *   - lines that are entirely a `//` or `#` comment are excluded
 *   - lines inside a `/* ... *​/` block comment are excluded
 * Trailing inline comments on a code line still count the line as code (it
 * carries real syntax), which is the standard, defensible convention.
 *
 * We deliberately do NOT try to be cleverer than this: under-counting our own
 * favoured side (CrewHaus authored spec) and over-counting the hand-built side
 * is the conservative direction for the thesis, and a line-oriented stripper is
 * auditable by hand.
 *
 * Caveat: the stripper is not string-aware — a `*​/` sequence inside a string
 * literal could end block-comment mode early. No file this harness counts
 * contains that pattern, so it does not affect any reported number.
 */
import { readFileSync } from "node:fs";

export type LocCount = { raw: number; code: number };

function isYamlLike(path: string): boolean {
  return path.endsWith(".yaml") || path.endsWith(".yml");
}

/** Count code vs raw lines for an array of source lines. */
export function countLines(lines: string[], commentToken: "//" | "#"): LocCount {
  let code = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      // Still inside /* ... */ — does it close on this line?
      if (line.includes("*/")) {
        inBlock = false;
        const after = line.slice(line.indexOf("*/") + 2).trim();
        if (after !== "" && !after.startsWith(commentToken)) code += 1;
      }
      continue;
    }
    if (line === "") continue;
    if (commentToken === "//" && line.startsWith("/*")) {
      // Opens a block comment; may also close on the same line.
      if (!line.includes("*/")) inBlock = true;
      else {
        const after = line.slice(line.indexOf("*/") + 2).trim();
        if (after !== "" && !after.startsWith(commentToken)) code += 1;
      }
      continue;
    }
    if (line.startsWith(commentToken)) continue;
    if (commentToken === "//" && line.startsWith("*")) continue; // jsdoc continuation
    code += 1;
  }
  return { raw: lines.length, code };
}

export function countFile(path: string): LocCount {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  // A file ending in a newline yields a trailing "" element; drop it from raw.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const token = isYamlLike(path) ? "#" : "//";
  return countLines(lines, token);
}

/**
 * Count a *named region* inside a TS file delimited by line markers, so we can
 * attribute hand-written LOC to categories (state schema, node defs, etc.).
 * Markers are matched as substrings; the region spans from the line AFTER the
 * start marker up to (and excluding) the line containing the end marker.
 */
export function countRegion(path: string, startMarker: string, endMarker: string): LocCount {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.includes(startMarker));
  if (startIdx < 0) throw new Error(`start marker not found: ${startMarker} in ${path}`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(endMarker));
  if (endIdx < 0) throw new Error(`end marker not found: ${endMarker} in ${path}`);
  const region = lines.slice(startIdx + 1, endIdx);
  return countLines(region, "//");
}

/** Extract the import line(s) matching a substring (for the "thin bundle" claim). */
export function grepLines(path: string, needle: string): string[] {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((l) => l.includes(needle))
    .map((l) => l.trim());
}
