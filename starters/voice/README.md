# hello-voice — voice-agent vertical slice

Minimal `target: voice` example: a brief voice assistant powered by the
OpenAI Realtime API (`gpt-4o-realtime-preview`). Speak a question, hear a
one-sentence reply. Audio in/out is handled by the SDK — no manual
streaming code.

## Run it

```bash
cd starters/voice          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist   # writes dist/{daemon,voice-loop,agent}.ts
OPENAI_API_KEY=sk-... bun dist/daemon.ts      # starts the voice daemon
```

The provider is OpenAI by default; switch with the `voice.provider:` field
in `crewhaus.yaml` (`openai`, `elevenlabs`, etc.).

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile voice
bun run run voice
```

</details>

See [`walkthroughs/09-voice-agent.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/09-voice-agent.md) for the
push-to-talk vs. always-on modes, VAD configuration, and how the runtime
interleaves audio with tool calls.
