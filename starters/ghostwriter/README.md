# ghostwriter — a drafting double that learns your voice from your edits

A harness that drafts replies, emails, and short posts **in your voice** —
and gets measurably better every week without you ever writing an eval,
a dataset, or a grader by hand. The insight it's built on: **you already
produce perfect training data every time you edit a draft before sending
it.** The edit *is* the label.

```
you ask for a draft ──► ghostwriter drafts ──► you send it as-is?
                                                │            │
                                          rate it up    you edited first?
                                                │            │
                                                ▼            ▼
                                       crewhaus rate   crewhaus feedback
                                       (👍 / stars)     --correction "<what
                                                         you actually sent>"
                                                │            │
                                                └─────┬──────┘
                                                      ▼
                                    autoDistill → versioned ratings dataset
                                                      ▼
                                    crewhaus flywheel run → gated spec patch
                                    (better instructions, reviewed by you)
```

> Walkthrough:
> [72 — Zero to self-improving](../../walkthroughs/72-zero-to-improving.md)
> uses this starter to teach the whole eval vocabulary (sample, dataset,
> grader, baseline, gate) on the way from day 0 to a nightly
> self-improvement loop.

## Run it

```bash
cd starters/ghostwriter
cp .env.example .env          # ANTHROPIC_API_KEY
bunx crewhaus run crewhaus.yaml
```

Then use it for real work:

```
> Draft a reply to Sam: I can't make Thursday, offer Friday morning.
> Draft a two-paragraph update to the team about the launch slipping a week.
```

**The one habit that makes it learn:** when you edit a draft before
sending, paste the version you actually sent back in as a correction —
that becomes the gold answer for that exchange:

```bash
crewhaus rate --session sess_0123456789abcdef --stars 5        # sent as-is
crewhaus feedback --session sess_0123456789abcdef \
  --text "too formal, and never open with 'I hope this finds you well'" \
  --correction "Hey Sam — Thursday's shot on my end. Friday 9am work?"
```

## Make it yours

Replace [`voice/`](voice/)'s three placeholder samples with 3–5 messages
**you actually sent** (scrub anything private). They're the only ground
truth the ghostwriter starts with; everything after that it learns from
your ratings and corrections.

## Files

```
ghostwriter/
  crewhaus.yaml     the spec — persona + feedback: {autoDistill: true}
  voice/            your real writing samples (replace the placeholders)
  .env.example      ANTHROPIC_API_KEY
```

There is deliberately **no eval/ directory**: day 0 of the walkthrough
scaffolds one with `crewhaus scaffold-evals`, and from then on your usage
grows it. Starting empty is the point.
