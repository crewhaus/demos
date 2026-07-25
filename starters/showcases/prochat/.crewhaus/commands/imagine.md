---
description: Generate an image from a text prompt (DALL-E by default).
argument-hint: "<image description>"
---
Generate an image for: **$ARGUMENTS**

1. Call `ImageGenerate({ prompt: "$ARGUMENTS" })`.
   - Default size is 1024×1024, vivid style — change via params if the
     user asked for something specific (portrait → 1024×1792, etc.).
   - `ImageGenerate` requires `OPENAI_API_KEY`. There is no automatic
     offline fallback: with no key it throws "OPENAI_API_KEY is not
     set — required for provider=openai". Relay that error verbatim
     and stop — do not claim an image was produced. (An operator can
     start the agent with `CREWHAUS_IMAGE_PROVIDER=mock` to get a
     text stub instead; that is a launch-time choice, not a default.)

2. After the tool returns:
   - If the result is a URL, write it in markdown image syntax so
     terminals with image-rendering (iTerm2, WezTerm) can preview:
     `![generated](URL)`
   - Then add a one-line description of what you generated and which
     parameters you used (size / style).

3. Don't editorialize beyond the image and a one-line caption. The
   user will tell you if they want to iterate.
