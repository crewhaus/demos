# Recipe 29 — Permissions Deep Dive

The full mental model for the five-layer permission system: how rules
compose across layers, how patterns match tool names and arguments,
how the four modes change defaults, and the security guard that
blocks `mode: bypass` from any source other than a CLI flag.

You'd read this end-to-end if you're:

- Authoring **production permission rules** for a real workload.
- Debugging an unexpected ask / deny.
- Reviewing a teammate's permission config before merge.

For first-time spec authoring, [Recipe 01 Step 4](01-cli-coding-agent.md#step-4--permissions)
covers the basics.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  spec block and the first read of rule grammar.

## Try it

The richest live permissions block in the demos is
[`starters/showcases/procode/crewhaus.yaml`](../starters/showcases/procode/crewhaus.yaml) lines
463–545: a complete `mode: default` setup with `alwaysAllow`,
`alwaysAsk`, and `alwaysDeny` patterns covering reads, edits, web,
allow-listed bash, and hard-denied destructive commands. Compile and
run with
`bun run compile starters/showcases/procode && bun run run starters/showcases/procode`, then try
`git push --force` to watch the deny fire. Every other `hello-*`
demo ships its own minimal permissions block.

Read that block top to bottom and note where the denials sit: **first**,
above every allow and above the catch-all ask. That ordering is load-
bearing, for the reason the next two sections spell out.

## The five rule sources

The permission engine evaluates rules from five layers, in priority
order. **Earlier layers win.** The table is highest-priority first; a
lower layer can never override a decision an earlier one already made.

| Layer        | Source                                                | Example                                          |
| ------------ | ----------------------------------------------------- | ------------------------------------------------ |
| 1. Flag      | `--permission-mode <mode>` on the CLI.                | `crewhaus run spec.yaml --permission-mode auto`   |
| 2. Settings  | `permissions` block of `<cwd>/.crewhaus/settings.json`. | `{"permissions":{"mode":"auto","rules":[...]}}` |
| 3. YAML      | `permissions:` block in the spec.                     | Default authoring layer.                          |
| 4. Hooks     | Reserved for hook-supplied rules.                     | Empty in the 0.4.2 CLI.                           |
| 5. Builtin   | `BUILTIN_DEFAULT_RULES` in the engine.                 | `alwaysAllow Read`, `alwaysAsk Bash(sudo**)`.     |

The first and fourth layers carry no authored rules. The **flag** layer
supplies the *mode* the evaluation runs under — `--permission-mode` sets
no rules — and the **hooks** layer is a reserved slot the CLI leaves
empty. Settings and YAML are where your rules come from, and settings
beats YAML: a project-local `.crewhaus/settings.json` is how you
override a spec you don't want to edit.

The complete evaluation:

```
flag → settings → yaml → hooks → builtin
```

The first rule that matches decides, and the walk stops there.

Hooks *can* still veto a call, just not through this table: a
`pre-tool` hook returning `{decision: deny}` (or `block`) short-circuits
in runtime-core **before** the engine is consulted at all. So a hook
effectively outranks every layer in the table: the call never gets
there.

## The four modes

| Mode      | Defaults                                                                  |
| --------- | ------------------------------------------------------------------------- |
| `default` | Rules decide; unmatched calls ask. `Read`/`Grep`/`Glob` are allowed by the builtin layer. |
| `plan`    | Strictest. Deny every non-`readOnly` tool; no rule is consulted at all.    |
| `auto`    | Rules decide; unmatched calls allow `readOnly`, ask `destructive`, allow the rest. |
| `bypass`  | Allow everything. **CLI-flag-only.**                                       |

### The `bypass` security guard

`bypass` is the developer's "I know what I'm doing" escape hatch. But
to prevent a malicious or buggy file from silently turning it on,
**`parsePermissionsConfig` rejects `mode: bypass` from any source
except the CLI flag**.

So a yaml spec containing:

```yaml
permissions:
  mode: bypass
```

Fails at parse. `crewhaus lint` prints, verbatim:

```
✗ [parse] <spec>: permissions.mode: bypass is rejected — bypass mode is only available via the --permission-mode CLI flag, never from a spec file
```

Same for settings.json, where `parsePermissionsConfig` throws its own
`bypass mode cannot be set from settings` before Zod even runs. The
only legal source is:

```bash
crewhaus run spec.yaml --permission-mode bypass
```

This is **a security-critical invariant**. There's a dedicated unit
test in `packages/permission-engine/src/index.test.ts` that asserts
the rejection — don't relax it.

## Rule kinds and declaration order

| Kind          | Effect                                       |
| ------------- | -------------------------------------------- |
| `alwaysAllow` | Tool call proceeds without prompt.            |
| `alwaysAsk`   | User prompted for each call.                  |
| `alwaysDeny`  | Tool call refused; the model sees a denial.   |

Read this section twice — it's the one thing about the engine that
surprises everybody.

**There is no tier precedence.** Within a layer the engine walks the
rules top to bottom and takes the **first** one whose pattern matches.
A `deny` written below a matching `allow` or `ask` is dead code.

```yaml
permissions:
  rules:
    - type: alwaysAllow
      pattern: Bash(*)
    - type: alwaysDeny
      pattern: Bash(rm -rf *)
```

A `Bash(rm -rf tmp)` call matches both rules. `alwaysAllow Bash(*)` is
declared first, so the call is **allowed** — the deny never runs. Don't
take the recipe's word for it; ask the engine, from any bundle you've
compiled with `crewhaus compile <spec> -o dist --check`:

```bash
bun -e 'const {evaluate} = await import("./dist/node_modules/@crewhaus/permission-engine/dist/index.js");
const rules = { flag: [], settings: [], hooks: [], builtin: [], yaml: [
  { type: "alwaysAllow", pattern: "Bash(*)",        source: "yaml" },
  { type: "alwaysDeny",  pattern: "Bash(rm -rf *)", source: "yaml" },
]};
console.log(evaluate({ toolName: "Bash", input: { command: "rm -rf tmp" },
  readOnly: false, destructive: true }, "default", rules));'
# → allow
```

Swap the two entries and the same call returns `deny`. The rule that
follows from this is short: **narrow denies above broad allows, and the
catch-all last.** A `Bash(ls)` call matches only `Bash(*)` either way,
so it's allowed regardless.

## The pattern grammar

Patterns are glob-like, with optional argument matchers:

| Pattern                  | Matches                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `Read`                   | Any `Read` call regardless of arguments.                            |
| `Read(*)`                | `Read` whose path argument contains no `/` — **narrower** than bare `Read`. |
| `Write(**/src/**)`       | `Write` whose path argument is under any `src/` directory.           |
| `Bash(git *)`            | `Bash` whose command starts with `git ` and has no `/` after it.     |
| `Bash(**)`               | Any `Bash` call.                                                     |
| `Bash(rm -rf**)`          | Any `Bash` whose command starts with `rm -rf`, slashes included.     |
| `*__list_directory`      | Any tool whose name ends with `__list_directory` (MCP namespacing).  |

The argument matcher is a small glob:

- `*` matches any sequence of non-`/` characters.
- `**` matches any sequence including `/`.
- `?` matches a single character.

**This is the single easiest way to write a deny that doesn't fire.**
`Bash(rm -rf *)` matches `rm -rf node_modules` but **not**
`rm -rf /tmp/foo` — the `/` stops a single `*` dead. Same for
`Bash(git push --force*)`, which misses `git push --force origin/main`.
A denial you actually want enforced needs `**`:

```yaml
- { type: alwaysDeny, pattern: Bash(rm -rf**) }          # not Bash(rm -rf *)
- { type: alwaysDeny, pattern: Bash(git push --force**) }
```

The builtin layer already does this — `BUILTIN_DEFAULT_RULES` ships
`alwaysAsk Bash(rm**)`, with a comment saying `**` is "necessary to
catch `rm -rf /tmp/foo`".

The asymmetry is what makes this worth care: a too-narrow **allow**
fails safe (the call falls through and prompts), while a too-narrow
**deny** fails open (the dangerous form sails past the rule you thought
covered it). Audit your denies with `**`; leave your allows narrow.

The matcher is **string-glob**, not regex, so `Bash(rm -rf /)` matches
only the literal command `rm -rf /`.

## The `evaluate` contract

```typescript
evaluate(
  call: {
    toolName: string,
    input: unknown,
    readOnly: boolean,
    destructive: boolean,
    requiresSandbox?: boolean,
  },
  mode: PermissionMode,
  rules: RuleSet,                    // { flag, settings, yaml, hooks, builtin }
  opts?: { sandboxAvailable?: boolean },
): "allow" | "deny" | "ask"
```

`rules` is the five-layer `RuleSet`, not a flat array — each key holds
that layer's rules in declaration order.

Implementation order:

1. `mode: bypass` → `allow`. `mode: plan` → `allow` if `readOnly`, else
   `deny`. Neither consults a single rule.
2. Walk the layers in priority order (`flag`, `settings`, `yaml`,
   `hooks`, `builtin`); within each layer, walk its rules in
   declaration order. **The first pattern that matches decides**, and
   the walk stops.
3. Nothing matched → the mode's fall-through.
4. `requiresSandbox` tools get one last gate: unless a non-noop sandbox
   backend is configured *and* step 2 or 3 produced `allow`, the call is
   denied — with a `reason` naming whichever of the two is missing.

The fall-through in step 3:

| Mode      | No rule matched                                                |
| --------- | -------------------------------------------------------------- |
| `default` | `ask` — for every tool, whatever its flags.                     |
| `auto`    | `allow` if `readOnly`; `ask` if `destructive`; else `allow`.    |

Note what that means in `default` mode: the reason `Read`, `Glob` and
`Grep` don't prompt is **not** the fall-through reading `readOnly` —
it's `BUILTIN_DEFAULT_RULES`, which carries an `alwaysAllow` for those
three by name. A custom tool that declares `readOnly: true` and nothing
else still asks. That's the fail-closed default, and it's worth
knowing it comes from the builtin layer rather than from the flags.

`auto` is the mode that trades that away: there, a tool declaring
neither flag is allowed outright.

`evaluateWithReason` returns the same decision plus the `reason` string
that runtime-core publishes on `permission_decision` trace events.

## Sub-agent permission inheritance

Three modes ([Recipe 28](28-sub-agents-and-task.md) for full
treatment):

| Mode      | Behavior                                                                 |
| --------- | ------------------------------------------------------------------------ |
| `inherit` | Child gets exactly the parent's rules. **This is what an absent `permissions:` key does.** |
| `scoped`  | Child gets only rules whose `toolGlob` matches a child tool.               |
| Explicit  | Child gets rules built from its definition's `permissions.allow` / `.deny` lists. |

**`bypass` does not propagate.** A parent in bypass mode still
produces children in `default` mode. This is the same property the
parser enforces (bypass is CLI-flag-only); inheritance respects it.

## Tenant policy overrides (managed only)

For multi-tenant managed deployments ([Recipe 11](11-managed-multitenant.md)),
the policy engine runs **after** the permission grant, before exec:

```
permission_engine.evaluate → policy_engine.evaluatePolicy → tool.exec
```

The policy engine can:

- **`audit-and-allow`** a call (the permission engine said allow; the
  policy engine wraps it with an audit-log entry).
- **`deny`** even if the permission engine said allow (per-tenant
  override).

The policy engine **cannot** override a permission denial — defense
in depth. Once the permission engine says deny, the call doesn't
reach the policy engine at all.

## Worked examples

### 1. Coding agent — Read free, Write scoped, Bash gated

```yaml
permissions:
  mode: default
  rules:
    - type: alwaysDeny
      pattern: Bash(rm -rf**)
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAllow
      pattern: Glob
    - type: alwaysAllow
      pattern: Grep
    - type: alwaysAllow
      pattern: Write(**/src/**)
    - type: alwaysAllow
      pattern: Edit(**/src/**)
    - type: alwaysAllow
      pattern: Bash(bun *)
    - type: alwaysAllow
      pattern: Bash(git status)
    - type: alwaysAllow
      pattern: Bash(git diff*)
    - type: alwaysAsk
      pattern: Bash(**)
```

What the agent can do without prompts: read anything, write into any
`src/` dir, run `bun *`, `git status`, `git diff*`. Anything else
that's Bash asks. `rm -rf *` is denied outright.

The deny is first on purpose. Move it to the bottom — where it reads
more naturally — and `rm -rf node_modules` resolves to **ask**, because
`alwaysAsk Bash(**)` above it matches first. Same ten rules, different
posture.

### 2. Slack bot — Read free, Bash always asks

```yaml
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAsk
      pattern: Bash(**)
```

In daemon context, "ask" means the daemon logs the question to
stdout/audit. For Slack bots typically replaced with curated
`alwaysAllow Bash(safe-prefix *)` rules so the daemon runs
non-interactively.

### 3. Browser agent — destructive tools allow-listed

```yaml
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Screenshot
    - type: alwaysAllow
      pattern: FindElement
    - type: alwaysAllow
      pattern: Click
    - type: alwaysAllow
      pattern: Type
    - type: alwaysAllow
      pattern: Key
    - type: alwaysAllow
      pattern: Scroll
```

The browser tools declare `destructive: true`; without explicit
allows, every action would prompt. The allow-listed shape is the
production pattern for browser agents ([Recipe 10](10-browser-agent.md)).

### 4. Read-only investigator

```yaml
permissions:
  mode: plan
```

Plan mode denies all writes. The agent has to reason without acting —
useful for "tell me what's wrong with this codebase" workloads where
you don't want it to start changing files.

## Debugging permission decisions

`CREWHAUS_TRACE=pretty` prints one line per decision:

```
2026-05-11T08:42:13.004Z [permission_decision]  tool=Bash decision=deny mode=default
2026-05-11T08:42:19.881Z [permission_decision]  tool=Python decision=deny mode=default reason=tool "Python" requires a sandbox but none is configured (CREWHAUS_SANDBOX must be set to docker or podman)
```

That tells you **what** was decided, not **which rule** decided it. A
`reason` is attached only by the sandbox floor, the justification gate,
and the egress / prompt-injection classifiers — never by an ordinary
rule match. When an outcome surprises you, the fastest answer
is to evaluate the rule set directly with the one-liner from
[Rule kinds and declaration order](#rule-kinds-and-declaration-order),
feeding it your spec's own rules:

```bash
bun -e 'const y = Bun.YAML.parse(await Bun.file("crewhaus.yaml").text());
const {evaluate} = await import("./dist/node_modules/@crewhaus/permission-engine/dist/index.js");
const rules = { flag: [], settings: [], hooks: [], builtin: [],
  yaml: y.permissions.rules.map(r => ({...r, source: "yaml"})) };
console.log(evaluate({ toolName: "Bash", input: { command: "git push --force" },
  readOnly: false, destructive: true }, y.permissions.mode, rules));'
```

Nine times out of ten the answer is rule order.

## Things that look like permissions but aren't

| Symptom                                                            | Better tool                                    |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Want to **transform** tool input before exec (PII redaction).       | `pre-tool` hook with `mutate`.                  |
| Want a **per-tenant** override.                                     | Policy engine + tenant config.                  |
| Want **rate** limits on tool use.                                   | [Rate limiter](19-rate-limiting-and-budgets.md). |
| Want **audit** of allowed calls.                                    | `sideEffect: audit-and-allow` flag.            |

## What to read next

- **Shell hook-based runtime checks.** [Recipe 14 — Hooks](14-hooks.md).
- **Sandbox-enforced code execution.** [Recipe 30 — Sandboxed Code Execution](30-sandboxed-code-execution.md).
- **Sub-agent inheritance.** [Recipe 28 — Sub-agents and Task](28-sub-agents-and-task.md).

## Pointers to source

- **Permission engine:** [`packages/permission-engine`](https://github.com/crewhaus/factory/blob/main/packages/permission-engine).
- **Pattern matcher:** [`packages/tool-permission-matcher`](https://github.com/crewhaus/factory/blob/main/packages/tool-permission-matcher).
- **Policy engine (multi-tenant):** [`packages/policy-engine`](https://github.com/crewhaus/factory/blob/main/packages/policy-engine).
- **Sub-agent inheritance:** [`packages/sub-agent-permission-inheritance`](https://github.com/crewhaus/factory/blob/main/packages/sub-agent-permission-inheritance).
- **Module catalog reference:** §7, §13 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
