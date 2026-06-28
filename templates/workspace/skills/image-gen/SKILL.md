---
name: image-gen
description: Generate and edit images with Google's "nano banana" (Gemini Image) models via the `image_generate` tool, plus prompt craft for getting good results. Use when drawing, illustrating, or editing an original image.
---

# Image Generation Workflow

**Purpose:** Create a new image from a text prompt, or edit/compose existing images, using Google's Gemini "nano banana" models. One call produces one image, saved into the workspace; you then deliver it with `send_message`.

## Quick Reference

Generate:

```json
{
  "prompt": "A cozy reading nook by a rain-streaked window, warm lamplight, a cat asleep on a stack of books, painterly style",
  "aspect_ratio": "3:2",
  "image_size": "2K"
}
```

Generate fast/cheap (flash model):

```json
{ "prompt": "a minimalist logo of a fox, flat vector, two colors", "model": "flash" }
```

Edit one image (the prompt is the instruction):

```json
{
  "prompt": "Make it nighttime with a starry sky; keep the building and the people unchanged",
  "images": ["generated-images/street.jpg"]
}
```

Compose from several references:

```json
{
  "prompt": "Place the character from the first image into the background of the second",
  "images": ["refs/character.png", "refs/landscape.jpg"]
}
```

## Models

- **`pro`** (default — *nano banana pro*, `gemini-3-pro-image`): best quality, follows complex instructions, and is **much better at rendering legible text** (signs, posters, infographics, UI). Slower (~15–20s). Use it for anything with text, fine detail, or multi-part instructions.
- **`flash`** (`gemini-3.1-flash-image`): faster and cheaper, great for simple or casual images. Supports the extra `image_size: "512"`. Use it when speed matters more than polish.

## Parameters

- `prompt` (required): the scene to generate, or — when `images` is set — the edit instruction.
- `images` (optional, 1–6): workspace-relative paths or http(s) URLs. **Any reference image switches the tool to edit mode.**
- `model`: `"pro"` (default) or `"flash"`.
- `aspect_ratio`: `1:1` (default), `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`.
- `image_size`: `1K`, `2K`, `4K` (longer-edge hint, loosely honored); `512` is **flash-only**.
- `filename`: optional output name hint.

## Prompt Craft

Nano banana rewards **descriptive, narrative prompts** over keyword lists.

- **Describe a scene, don't list tags.** "A weathered fisherman mending a net on a misty dock at dawn, soft backlight, shallow depth of field" beats "fisherman, dock, fog, morning, bokeh".
- **Name the look:** medium (photo, oil painting, 3D render, watercolor, pixel art), lighting (golden hour, neon, studio softbox), camera (wide shot, macro, low angle), and mood.
- **Rendering text:** quote the **exact** words in double quotes and say where they go — e.g. `a poster that reads "GRAND OPENING" in bold condensed sans-serif across the top`. Use `pro` for anything text-heavy; pick a non-square ratio and `2K`+ for posters/infographics.
- **Faces, hands, counts:** state quantities explicitly ("exactly three people"), and describe key features rather than leaving them to chance.

## Editing Craft

- **Say what changes AND what to preserve:** "Recolor the car to red; keep the background, lighting, and reflections identical." Without a "keep" clause the model may redraw more than you wanted.
- **Reference images by role** when composing: "use the *first* image's character and the *second* image's background."
- For local fixes, name the region: "only change the sky; leave the foreground untouched."
- Editing inherits the reference image's framing — if you need a different aspect ratio, say so.

## Delivery — IMPORTANT

The tool **saves the image and shows it to you inline, but does not post it to the chat.** After a successful call you will get back a workspace path (e.g. `./generated-images/image-ab12cd.jpg`). To actually send it:

```
send_message  with  media: "./generated-images/image-ab12cd.jpg"  and a short caption
```

If the result looks wrong, just call `image_generate` again with a refined prompt before sending — nothing is posted until you call `send_message`.

## Content limits — SFW only

Nano banana runs every generation through a safety classifier and **will not produce NSFW images** — explicit/sexual content comes back as a refusal (typically "no image returned" with a safety `finishReason`, not a usable picture). Don't try to slip it past with euphemisms or retries; the classifier, not the prompt wording, is the wall.

- If a request is *adjacent* to NSFW, adapt it into a tasteful SFW version of the same idea and run that instead.
- If it genuinely can't be done SFW, just say so: nano banana is the only image model available here and it doesn't support NSFW. Keep it brief and matter-of-fact — no lecture.

## Notes

- All generated images carry an invisible **SynthID watermark** (Google's provenance mark). This is normal and unavoidable.
- One image per call. For variations, call again (optionally tweaking the prompt).
- If a call comes back with "no image returned (finishReason=MAX_TOKENS)", that's a backend hiccup — retry; if it persists, tell the operator.
