# hello-voice — voice-agent vertical slice

Minimal `target: voice` example: a brief voice assistant powered by the
OpenAI Realtime API (`gpt-4o-realtime-preview`). Speak a question, hear a
one-sentence reply. Audio in/out is handled by the SDK — no manual
streaming code.

## Run it

From the repo root:

```bash
bun install
bun run compile voice                       # writes dist/{daemon,voice-loop,agent}.ts
OPENAI_API_KEY=sk-... bun run run voice     # starts the voice daemon
```

The provider is OpenAI by default; switch with the `voice.provider:` field
in `crewhaus.yaml` (`openai`, `elevenlabs`, etc.).

See [`walkthroughs/09-voice-agent.md`](../../walkthroughs/09-voice-agent.md) for the
push-to-talk vs. always-on modes, VAD configuration, and how the runtime
interleaves audio with tool calls.
