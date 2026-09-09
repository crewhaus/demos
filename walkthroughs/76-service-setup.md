---
test:
  spec: starters/channel/crewhaus.yaml
  packages:
    - packages/service-setup
    - packages/preflight
    - packages/channel-adapter-slack
    - packages/target-channel-bot
---

# Recipe 76 — One command for the Slack app, the tunnel, and the wiki space

**Pillar:** Pillar 1 — the compiler is the protagonist. The spec already says
what the harness needs; provisioning should read it, not repeat it.
**Catalog modules:** `service-setup`, with `preflight` (the shared `$VAR`
secret grammar), `channel-adapter-slack` (where the scope list is derived
from), and `target-channel-bot` (whose gateway routes define the two webhook
paths).
**Shipped:** `crewhaus services setup`.
**Starter:** [`starters/channel/`](../starters/channel/README.md).

Compiling a channel harness takes seconds. Getting it to actually receive a
message has, until now, taken a trip through three consoles: create a Slack
app and tick the right scopes, stand up a tunnel so Slack can reach a laptop, and
make a wiki space for the agent's memory. Do that once and it is tedious. Do
it across a fleet and it is a source of quiet, hard-to-debug drift — one app
missing `reactions:read`, one tunnel row pointing at the wrong port, one
harness writing into another's wiki.

`services setup` reads the spec and does all three.

## What the spec already tells it

Take the channel starter:

```yaml
# starters/channel/crewhaus.yaml — the two blocks setup reads
name: hello-channel
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
```

That is enough to derive the app's display name, the scopes and events the
adapter actually consumes, both request URLs, and — this is the part that
keeps the command generic — **the names of the variables the credentials
belong in**. `channel-adapter-slack` never reads a credential from the
environment; the daemon passes them in as constructor config. So the variable
names are the author's choice, and setup takes them from the spec rather than
assuming a convention. A fleet that writes `$SECRETARY_SLACK_BOT_TOKEN` and a
lone harness that writes `$SLACK_BOT_TOKEN` both work, unchanged.

## The dry run

Always look first:

```bash
crewhaus services setup crewhaus.yaml --zone example.com --port 3000 --dry-run
```

```
harness   hello-channel  (crewhaus.yaml, channel target)
events    :3000
writes    ./.env

Cloudflare
  → find-or-create tunnel "crewhaus"
  → public hostname hello-channel.example.com → http://localhost:3000
  → DNS CNAME hello-channel.example.com → <tunnel>.cfargotunnel.com (proxied)
Slack
  → create app "hello-channel" from a manifest (7 bot scopes)
  → events   https://hello-channel.example.com/slack/events
  → actions  https://hello-channel.example.com/slack/actions
  → open the install page, capture the bot token through the tunnel

dry run — nothing was contacted or written.
```

Two things in that plan are worth pausing on.

**`--port` is not derived, and cannot be.** The Slack events listener binds
`process.env.PORT` and has no spec field at all. The `gateway.port` in a spec
is a different listener — the control UI — and tunnelling that instead is a
uniquely confusing failure: the hostname serves a page, and Slack still times
out. Setup prints both and tunnels the right one, but you have to tell it
which port the launcher exports.

**Both request URLs are set.** `/slack/events` carries messages;
`/slack/actions` carries Approve/Deny button clicks, and they are separate
webhooks. An app configured with only the first renders approval cards whose
buttons do nothing.

## Running it

```bash
crewhaus services setup crewhaus.yaml --zone example.com --port 3000
```

Setup asks for three provisioning credentials, or reads them from the
environment or the harness `.env` if they are already there:

| Variable | Where to mint it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → API tokens. *Account · Cloudflare Tunnel · Edit*, *Zone · DNS · Edit*, *Zone · Zone · Read* |
| `SLACK_CONFIG_TOKEN` | api.slack.com/apps → Your App Configuration Tokens |
| `THREDZ_API_KEY` | your Thredz account's API keys, with a wiki read-write grant |

These are a different tier from the credentials the harness runs with. They
are read once, used, and dropped — never written into a spec, never written
into `.env`. What lands in the harness is only what the daemon needs: the bot
token, the signing secret, and the app id.

When the tunnel is new, setup finishes by printing the connector command. It
does not run it for you — that step wants `sudo`, and a provisioning tool
that escalates on your behalf is a different thing than one that tells you
what to run:

```bash
sudo cloudflared service install <token>
```

## The circle it has to break

There is an ordering problem hiding in the middle of this, and it is worth
knowing about because it explains a design choice you would otherwise find
strange.

A Slack app's request URL has to answer a `url_verification` challenge before
Slack will accept it. The thing that would answer is the compiled daemon. But
the daemon gates its boot on every secret the spec declares and exits when
one is unset — and the signing secret it needs is returned exactly once, in
the response to the app-creation call that has not happened yet. The daemon
cannot start before the app exists; the app's URL cannot verify before
something answers it.

Setup breaks the circle by standing in. A verification challenge needs no
credential to answer correctly — the response is the challenge, echoed — so
setup binds the events port itself for the length of the run, answers, and
releases the port before the daemon takes it. If something is already
listening it skips this entirely and lets the daemon answer.

The same listener catches the OAuth redirect, which is why the install can
complete without you pasting a token: Slack requires an HTTPS callback, and
the tunnel setup just built terminates TLS.

## Running it again

Every step is find-or-create, so a second run is safe and reports what was
already true:

```
~ tunnel "crewhaus" (already set)
~ public hostname hello-channel.example.com → http://localhost:3000 (already set)
✓ Slack app A012345 updated from manifest
```

Three details make that safe rather than merely convenient. The Cloudflare
ingress write is read-merge-write, because `PUT …/configurations` replaces
the *whole* configuration — a naive write on a tunnel that
fronts a whole fleet deletes every other harness's hostname. The catch-all rule is pinned last, because the API
accepts a malformed rule list with `success: true` while the connector
quietly keeps serving the old configuration. And the Slack credentials are
written to `.env` the instant they arrive, before the install step that can
fail, because nothing can read that signing secret back.

## Narrowing

```bash
# just the wiki space, on a harness whose Slack app already exists
crewhaus services setup crewhaus.yaml --services thredz

# update an existing app's manifest after changing the spec
crewhaus services setup crewhaus.yaml --zone example.com --port 3000 \
  --services slack --app-id A012345

# a fleet sharing one .env one directory up
crewhaus services setup crewhaus.yaml --zone example.com --port 3002 \
  --hostname foreman.example.com --env-file ../.env
```

## Then verify

`services setup` provisions. `channel verify` checks:

```bash
crewhaus channel verify crewhaus.yaml --platform slack
```

That reports the boot-gate env refs the compiled daemon refuses to start
without, then diffs the scopes Slack actually granted against the ones the
adapter needs. Green there means the next `./run.sh` will boot and receive.

## See also

- [Recipe 37](37-channel-telegram.md) — the same channel shape on Telegram.
- [Recipe 53](53-justification-gates.md) — the approval cards whose buttons
  need that second request URL.
