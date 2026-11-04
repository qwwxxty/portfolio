# assets/videos

Footage for the three scene slots goes here: `hero`, `scrub`, `export` (`.mp4` + `.webm` each).

1. Encode with `../../encode.sh <slot> <source>` (see `VIDEOS.md` in the repo root).
2. Set `ready: true` for that slot in `VIDEO_SLOTS` at the top of `script.js`.

Until a slot is marked ready, the page never requests its file and shows code-drawn graphics instead.
