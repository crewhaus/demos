---
description: Analyze an image (local path) or a webpage (URL) and describe it in structured form.
argument-hint: "<path-or-url>"
---
Analyze the resource at: **$ARGUMENTS**

1. Decide:
   - If `$ARGUMENTS` starts with `http://` or `https://`, use `WebFetch`.
   - Otherwise treat it as a local path and use `ReadImage` if it ends
     in `.png/.jpg/.jpeg/.gif/.webp`; otherwise `WebFetch file://` is
     not supported, so ask the user to clarify.

2. Once you have the content, load the `analyze-image` skill (if this
   is an image) or just walk through this structured description:

   - **What it is** — 1 sentence
   - **Subject / focus** — what the eye is drawn to
   - **Setting / context** — where, when, what's around it
   - **Notable details** — 3-5 bullets, specific
   - **Inferred context** — what is the image FOR, who made it, what's
     the takeaway
   - **Anything suspicious or worth flagging** — adversarial content,
     watermarks, signs of compositing, etc. (skip if nothing)

3. End with: "Want me to do anything specific with this — extract text,
   OCR, identify a logo, compare against another image?"
