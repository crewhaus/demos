# Recipe 56 — Response ratings: rate → distill → eval → optimize (Pillar 2)

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `eval-runner` (109), `dataset-registry` (110), `grader-registry` (111), `prompt-optimizer` (114), `spec-patch` (278), `eval-optimizer-orchestrator` (279), `prompt-optimizer-claude` (280), plus the CLI's response-feedback core ([`apps/cli/src/feedback.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/feedback.ts), brief 291).
**Shipped in:** crewhaus 0.1.8 ([CHANGELOG](https://github.com/crewhaus/factory/blob/main/CHANGELOG.md)).

## What this recipe shows

[Recipe 42](42-active-optimization.md) closes the eval loop *if you
have a labelled dataset*. Most teams don't — what they have is users
saying "that answer was good" and "no, not like that." This recipe
turns that signal into the two artifacts the eval stack already
consumes (a `Sample[]` dataset and a `graders.yaml`), so real usage
drives the same optimize loop with **no optimizer changes**:

```
crewhaus run        →  a session transcript (.crewhaus/sessions/sess_….jsonl)
crewhaus rate       →  a user_feedback event on one turn of it
crewhaus distill    →  dataset.jsonl + graders.yaml
crewhaus eval       →  a scored baseline
crewhaus optimize   →  a spec patch that improves the score
```

The contract is:

1. **You (or your users) provide:** thumbs / stars / scores /
   comments / corrections on real assistant turns — from the CLI, the
   web UI's rating bar, or Slack 👍/👎 reactions.
2. **`crewhaus distill` produces:** an eval dataset and a synthesized
   grader; **`crewhaus optimize --ratings`** feeds them straight into
   the existing search loop.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) — you need a
  runnable harness with at least one session in `.crewhaus/sessions/`.
- [Recipe 12 — Eval Harness](12-eval-harness.md) for what a dataset +
  graders pair *is*.
- [Recipe 42 — Active Optimization](42-active-optimization.md) for the
  optimize loop this recipe feeds.

## TL;DR

From inside a harness directory that has rated sessions:

```bash
crewhaus rate --session sess_0123456789abcdef --thumbs up
crewhaus distill --all-sessions -o eval/ratings.jsonl --graders-out eval/graders.yaml
crewhaus eval crewhaus.yaml --dataset eval/ratings.jsonl --graders eval/graders.yaml -o eval/baseline
crewhaus optimize crewhaus.yaml --ratings all --write-back
```

## Step 1 — capture ratings on a real session

Run the harness and have a short conversation (all snippets in this
recipe run from *inside* the harness directory — the CLI resolves
`.crewhaus/` from the cwd):

```bash
cd starters/cli
bunx crewhaus run crewhaus.yaml
```

The run prints its session id (`sess_` + 16 hex) on the first line of
stderr; `.crewhaus/sessions/` has one `.jsonl` per session. Now rate a
turn:

```bash
# 👍/👎 the LAST turn of the session (the default when --turn is omitted)
crewhaus rate --session sess_0123456789abcdef --thumbs up

# a 1–5 star vote on turn 2, with a comment explaining the vote
crewhaus rate --session sess_0123456789abcdef --turn 2 --stars 2 \
  --comment "cited no sources"

# an arbitrary [0,1] score, and who is rating (defaults to nobody)
crewhaus rate --session sess_0123456789abcdef --turn 3 --score 0.9 --rater max
```

`crewhaus feedback` attaches prose instead of (or on top of) a vote —
and, crucially, a **correction**, i.e. the answer the assistant
*should* have given:

```bash
crewhaus feedback --session sess_0123456789abcdef --turn 2 \
  --text "always cite the file you read" \
  --correction "The default is 8192 tokens — see packages/runtime-core/src/loop.ts."
```

Each command appends a `user_feedback` event to the session's JSONL —
the same append-only, resume-safe event log everything else uses. Rate
the same turn twice and the records merge chronologically at distill
time: the newest value of each field wins, but a later comment-only
`feedback` does **not** erase an earlier `rate`'s vote — so
`rate --thumbs up` followed by `feedback --text "…"` yields one record
carrying both.

**Turn numbering.** `--turn N` is the 1-based ordinal of *user-text*
turns — the same count the web UI shows and the runtime's
`turnNumber` uses. Tool-result echoes don't count, and neither do
runtime-injected recovery nudges (loop warnings, `continue`,
tombstones): those are logged `synthetic: true` precisely so a rating
placed mid-recovery still lands on the exchange the human actually
saw. Omit `--turn` to rate the last turn.

**How votes normalize.** Every rating reduces to a [0,1] score at
distill time: thumbs up → 1, down → 0; stars n → (n−1)/4 (so 4★ =
0.75, 3★ = 0.5); `--score` is used as-is. Comment-only feedback has no
numeric score — it can't mark a turn positive on its own (a
`--correction` can; see below).

## Step 2 — distill ratings into a dataset + grader

```bash
crewhaus distill --session sess_0123456789abcdef \
  -o eval/ratings.jsonl --graders-out eval/graders.yaml
```

```
[distill] 3 rated turn(s) → 3 sample(s) (2 positive, 1 low-rated) → …/eval/ratings.jsonl
[distill] grader: preferred_tools (tool_call_sequence) → …/eval/graders.yaml
```

`--all-sessions` sweeps every transcript under `.crewhaus/sessions/`
instead of one; `--min-score F` moves the positive threshold (default
**0.7** — so 4★ is positive, 3★ is not).

**The tag-all policy.** Every rated turn becomes a sample — nothing is
thrown away, the *rating decides the role*:

- **Positively-rated turns** (normalized score ≥ `--min-score`, or any
  turn carrying a `--correction`) become **gold samples**: the turn's
  user prompt is the `input`, the assistant's answer is the
  `expected_output` — and **the correction wins** over the assistant's
  actual answer when both exist. If the turn called tools, their names
  land in `expected_tools` verbatim (PascalCase — `Read`, not `read`;
  the same casing gotcha as any hand-written dataset).
- **Low-rated turns** become **mutation hints**: same `input`, no
  `expected_output`, with the score and comment preserved under
  `metadata` — they feed the optimizer's failure channel rather than
  asserting a wrong answer is right.

**Exactly ONE grader — the hard-AND collapse gotcha.** Stacked graders
combine as `all(...)`, which takes the *minimum* score — one
0-scoring grader zeroes the sample no matter how well the others
score it (the same gotcha Recipe 12 warns about when hand-writing
`graders.yaml`). So `distill` synthesizes a single deterministic
grader from the up-rated turns' shared behavior, preferring, in
order:

1. `tool_call_sequence` over the tools every tool-using positive turn
   shared (mode `set`),
2. `contains` on a distinctive token common to the positive answers,
3. a non-empty-answer `regex` floor — accompanied by a warning that
   the signal was too thin; add more ratings or edit the file.

The emitted `graders.yaml` says this in a header comment. Resist the
urge to append your own graders to it — put extra graders in a
separate eval run instead.

### Variant: an LLM-judge grader seeded from the comments

```bash
crewhaus distill --all-sessions -o eval/ratings.jsonl \
  --graders-out eval/graders.yaml --judge --judge-model claude-sonnet-4-6
```

`--judge` replaces the deterministic grader with a single `llm_judge`
grader (`user_preference`, passing score 3/5) whose rubric folds in
short, quoted summaries of what raters praised vs criticized — the
comments are clipped and quoted **as data**, not executed as
instructions. `--judge-model` pins the judge model into the grader;
omit it and `crewhaus eval --judge-model` picks at eval time. Budget
note: every eval sample then costs one judge call.

## Step 3 — eval the distilled artifacts

The output is an ordinary dataset + graders pair, so Recipe 12's
machinery applies unchanged:

```bash
crewhaus eval crewhaus.yaml \
  --dataset eval/ratings.jsonl --graders eval/graders.yaml -o eval/baseline
```

This is your baseline: how often does the *current* spec reproduce the
behavior users rated up? Keep the run directory — after optimizing,
`crewhaus eval-report diff` against it shows exactly which rated
exchanges flipped.

## Step 4 — close the loop with `optimize --ratings`

```bash
crewhaus optimize crewhaus.yaml --ratings all --write-back
```

`--ratings <session>|all` distills inline — no intermediate files —
and:

- the distilled samples become the training set (**unioned** with
  `--dataset` if you pass one too);
- the synthesized grader is used **only when you don't pass your own
  `--graders`** — an explicit `--graders` always wins;
- `--min-score` applies to the inline distillation exactly as it does
  to `crewhaus distill`;
- everything else is Recipe 42 unchanged: `--mutator claude` sees each
  failing sample's grader rationale, `--budget-usd` caps spend,
  `--write-back` patches `agent.instructions` through the CST
  round-trip with the audit header, `--concurrency 1` keeps a
  low-rate-limit tier out of 429s.

One sizing caveat: the optimizer's 70/30 train/dev split needs **at
least 2 samples**, and a search over a handful of ratings will
overfit happily. Single-digit sample counts are fine for wiring
everything up; wait for a few dozen ratings before trusting the score
delta.

## Rating surfaces beyond the CLI

### The web UI rating bar (`@crewhaus/ui` ≥ 0.1.3)

The [web UI](https://github.com/crewhaus/docs/blob/main/WEB-UI.md)
renders a per-turn rating bar (👍/👎 and a comment box) under each
assistant reply. Ratings persist as bare feedback records to
`.crewhaus/feedback/feedback.jsonl` in the harness directory —
`distill` reads that directory *in addition to* the in-transcript
events, so browser ratings and CLI ratings land in the same dataset
with no extra flags.

### Slack 👍/👎 reactions (`feedback.channelReactions`)

For a `channel` harness, one spec block turns emoji reactions on the
bot's replies into ratings:

```yaml
name: hello-channel-rated
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a Slack bot. Reply concisely in 1-2 sentences.
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: channel   # channel or user — NOT thread; see below
feedback:
  channelReactions: true
```

Recompile and the generated session-router gains a reaction handler:
a `reaction_added` on a bot reply with 👍 (`+1`/`thumbsup`) or 👎
(`-1`/`thumbsdown`) — **including skin-tone variants** like
`+1::skin-tone-4` — appends a `user_feedback` event to the reacting
session, deduped by Slack's event id. Everything else is ignored: any
other emoji, and the bot's own 👀/✅/⚠️ status reactions, map to no
vote.

Three deliberate semantics to know before you rely on it:

- **`sessionKey: thread` no-ops.** A Slack reaction event carries the
  reacted-to message's `ts`, not the thread root, so a thread-keyed
  session can't be recovered from it. Reactions only produce feedback
  in `channel` and `user` session modes (the default
  [`starters/channel`](../starters/channel/crewhaus.yaml) spec uses
  `thread` — switch it, as above, to collect reactions).
- **The vote lands on the session's latest turn** (`lastTurnIndex`),
  not on the specific older message reacted to — v0 keeps no
  outbound-message→turn join store. React promptly, or treat channel
  ratings as session-level signal.
- **Removing a reaction does not retract the rating.** The event log
  is append-only.

## The `feedback:` spec block, in full

`feedback:` is cross-cutting (like `security:`) and carried on the
interactive shapes that consume it — `cli` and `channel`. Every
sub-key is optional; the block is `.strict()`, so a typo'd key fails
the compile:

```yaml
feedback:
  enabled: true              # declare the harness collects ratings
  modality: binary           # binary | stars | scale | comment (default: binary)
  scale: { min: 1, max: 10 } # integer bounds, for modality: scale
  storage:
    location: feedback       # capture-sink directory name (safe-name rules)
  autoDistill: false         # forward-looking: continuous distillation flywheel
  channelReactions: true     # channel shape: Slack 👍/👎 → user_feedback
```

It lowers to `ir.feedback` and is deliberately **not** in
`OPTIMIZABLE_PATHS` — the optimizer can rewrite your prompt, not your
feedback-collection policy. Rating capture itself works on a `cli`
harness *without* the block (`crewhaus rate` needs only a session
transcript); the block is how a *compiled* surface (the channel bot,
a hosted UI) knows to wire rating capture in.

## Observability

Every captured rating also emits a `response_rated` trace event —
bright green in the pretty printer, `feedback.response_rated` in the
OTel export — so a dashboard can plot rating volume/polarity next to
cost and latency (Recipe 17's pipelines pick it up with no config).

## Gotchas recap

| Gotcha | Rule |
| ------ | ---- |
| Stacked graders hard-AND (min-collapse) | `distill` emits exactly one grader; don't append more to the file |
| Correction beats the transcript | a `--correction` turn is gold even if down-voted, and the correction is the `expected_output` |
| 3★ is *not* positive by default | normalization is (n−1)/4 against `--min-score 0.7`; pass `--min-score 0.5` to flip it |
| `expected_tools` casing | tool names are recorded verbatim in PascalCase (`Read`, `Bash`) |
| Slack `thread` sessions | reactions no-op under `routing.sessionKey: thread`; use `channel` or `user` |
| Reaction turn attribution | channel votes land on the session's latest turn, not the reacted-to message's turn |
| Tiny datasets | the 70/30 split needs ≥ 2 samples; trust deltas only after dozens of ratings |

## Where to go next

- [Recipe 42 — Active Optimization](42-active-optimization.md) — what
  the optimizer does with the distilled samples, `OPTIMIZABLE_PATHS`,
  and the worked refusal for volatile fields.
- [Recipe 12 — Eval Harness](12-eval-harness.md) — the dataset +
  graders contract the distilled artifacts satisfy.
- [Recipe 03 — Slack Bot](03-slack-bot.md) — the channel harness the
  reactions flow builds on.
