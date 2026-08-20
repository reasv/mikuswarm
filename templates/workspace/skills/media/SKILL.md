---
name: media
description: Work with media beyond the automatic captions — download/probe an attachment or URL (`media`), look at an image directly with your own vision (`read_image`), or fetch a YouTube video's metadata/subtitles/segments (`youtube_fetch`). Load when a caption isn't enough or media needs processing.
tools:
  - media
  - read_image
  - youtube_fetch
---

# Media Handling

Attachments and links in chat are already captioned automatically — most of the
time you need nothing. Load this skill when you must go beyond the caption.

## `read_image`
Puts the actual pixels of an in-chat image in front of you (when your model has
vision). Use when the caption is ambiguous or the question hinges on visual
detail ("what does the sign say?", "which character is this?").

## `media`
Fetch/inspect a media file — download a URL or attachment into the workspace,
probe formats/dimensions/duration. Use for processing tasks (re-sending a file,
handing it to another tool, checking what something actually is).

## `youtube_fetch`
Structured YouTube access: metadata, subtitles/transcript, or a bounded
video/audio segment. Prefer the transcript for "what does this video say";
fetch segments only when the actual footage matters and keep them short.
