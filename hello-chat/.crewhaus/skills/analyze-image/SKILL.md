---
name: analyze-image
description: |
  Structured image description protocol. Use when the user asks about
  an image — what's in it, what's wrong with it, what it depicts.
  Vision-first description with named layers.
triggers:
  - "describe this image"
  - "what's in this picture"
  - "analyze this screenshot"
  - "what do you see"
  - "is anything wrong with this"
---

# analyze-image — structured image description

When given an image, describe it in named layers. Don't free-associate;
walk the layers in order. Skip a layer only if it genuinely doesn't
apply.

## 1. Type

What kind of image is this?
- Photograph, screenshot, scanned document, diagram, chart, illustration,
  AI-generated, meme, comic, infographic, logo, UI mockup, …
- This shapes everything below.

## 2. Subject

What's the focal point? Describe in one sentence as if explaining to a
blind reader: who/what is the subject, doing what, where.

## 3. Setting / context

- Where: indoor / outdoor, specific location if identifiable
- When: time of day, season, era, era-specific markers
- What's around the subject — background elements that matter

## 4. Composition

For photos / illustrations:
- Framing (close-up / wide / aerial / Dutch angle / …)
- Lighting (natural / artificial / harsh / soft / direction)
- Color palette (dominant 2-3 colors, mood implied)

For UI / diagrams / charts:
- Layout grid
- Visual hierarchy — what does the eye land on first
- What's the chart actually showing (axes, units, scale)

## 5. Notable details

3-5 specific observations a casual viewer would miss. Be concrete.

## 6. Inferred purpose

What is this image FOR? Who made it, who's the audience, what's the
intended takeaway. Be honest about uncertainty.

## 7. Concerns (skip if none)

- Adversarial content, harmful imagery, watermarks
- Signs of compositing, AI generation, manipulation
- For UI/design: accessibility issues, hierarchy problems
- For charts: misleading axes, cherry-picked scales

## Output style

Don't number the headings in the actual response — use the layer names
as inline bolded labels. Be specific and concise; padding kills
believability.
