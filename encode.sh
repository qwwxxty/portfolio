#!/usr/bin/env bash
# Encode footage for the three video slots of the site (see VIDEOS.md).
#
#   ./encode.sh hero   path/to/source.mov    → assets/videos/hero.mp4   + hero.webm
#   ./encode.sh scrub  path/to/source.mov    → assets/videos/scrub.mp4  + scrub.webm
#   ./encode.sh export path/to/source.mov    → assets/videos/export.mp4 + export.webm
#
# Every file: no audio, at most 1080p (scrub: 720p), H.264 MP4 + VP9 WebM, at most 4 MB.
# The bitrate is computed from the clip length and encoded in two passes, so the size
# lands just under the limit. "scrub" gets a keyframe on EVERY frame (all-intra):
# the page sets currentTime on each scroll step, and without it seeking stutters.
#
# After encoding, set `ready: true` for the slot in VIDEO_SLOTS at the top of script.js.
# Needs ffmpeg + ffprobe with libx264 and libvpx-vp9.

set -euo pipefail

usage() { echo "usage: $0 hero|scrub|export <input-video> [max-seconds]" >&2; exit 1; }
[[ $# -ge 2 ]] || usage
SLOT="$1"; IN="$2"
case "$SLOT" in
  hero|export) MAXW=1920; MAXH=1080; DEFAULT_MAX=12; GOP=48 ;;
  scrub)       MAXW=1280; MAXH=720;  DEFAULT_MAX=6;  GOP=1 ;;
  *) usage ;;
esac
MAXSEC="${3:-$DEFAULT_MAX}"
[[ -f "$IN" ]] || { echo "no such file: $IN" >&2; exit 1; }
IN="$(cd "$(dirname "$IN")" && pwd)/$(basename "$IN")"   # absolute: ffmpeg runs from a temp dir
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "ffmpeg and ffprobe are required" >&2; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)/assets/videos"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

LIMIT_BYTES=4000000   # 4 MB, decimal
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")"
DUR="$(awk -v d="$DUR" -v m="$MAXSEC" 'BEGIN { if (d > m) d = m; printf "%.3f", d }')"

# 92 % of the budget for the video stream leaves room for the container.
KBPS="$(awk -v d="$DUR" -v b="$LIMIT_BYTES" 'BEGIN { printf "%d", (b * 8 * 0.92) / d / 1000 }')"
# Fit inside MAXW x MAXH, keep the aspect ratio, even dimensions, 24 fps, 8-bit 4:2:0.
VF="scale=w='min(${MAXW},iw)':h='min(${MAXH},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24,format=yuv420p"

echo "slot=$SLOT  length=${DUR}s  target=${KBPS} kb/s  gop=$GOP"

encode_mp4() {
  local kbps="$1" out="$DIR/$SLOT.mp4"
  local x264="keyint=${GOP}:min-keyint=${GOP}:scenecut=0"
  (cd "$TMP" && ffmpeg -hide_banner -loglevel error -y -i "$IN" -t "$DUR" -an -vf "$VF" \
      -c:v libx264 -preset slow -profile:v high -b:v "${kbps}k" -x264-params "$x264" -pass 1 -f mp4 /dev/null)
  (cd "$TMP" && ffmpeg -hide_banner -loglevel error -y -i "$IN" -t "$DUR" -an -vf "$VF" \
      -c:v libx264 -preset slow -profile:v high -b:v "${kbps}k" -maxrate "$((kbps * 3 / 2))k" -bufsize "$((kbps * 2))k" \
      -x264-params "$x264" -pass 2 -movflags +faststart "$out")
}

encode_webm() {
  local kbps="$1" out="$DIR/$SLOT.webm"
  (cd "$TMP" && ffmpeg -hide_banner -loglevel error -y -i "$IN" -t "$DUR" -an -vf "$VF" \
      -c:v libvpx-vp9 -b:v "${kbps}k" -g "$GOP" -keyint_min "$GOP" -row-mt 1 -deadline good -cpu-used 2 -pass 1 -f webm /dev/null)
  (cd "$TMP" && ffmpeg -hide_banner -loglevel error -y -i "$IN" -t "$DUR" -an -vf "$VF" \
      -c:v libvpx-vp9 -b:v "${kbps}k" -maxrate "$((kbps * 3 / 2))k" -g "$GOP" -keyint_min "$GOP" -row-mt 1 -deadline good -cpu-used 2 -pass 2 "$out")
}

size_of() { wc -c < "$1" | tr -d ' '; }

# Encode, and if a file still ends up over 4 MB, retry it at 80 % of the bitrate.
for kind in mp4 webm; do
  kbps="$KBPS"
  for attempt in 1 2 3; do
    "encode_$kind" "$kbps"
    size="$(size_of "$DIR/$SLOT.$kind")"
    if (( size <= LIMIT_BYTES )); then break; fi
    echo "  $SLOT.$kind is $((size / 1024)) KB, over 4 MB; retrying at lower bitrate"
    kbps=$((kbps * 4 / 5))
  done
  printf '  %-12s %6d KB  %s\n' "$SLOT.$kind" "$(( $(size_of "$DIR/$SLOT.$kind") / 1024 ))" \
    "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 "$DIR/$SLOT.$kind")"
done

if [[ "$SLOT" == "scrub" ]]; then
  frames="$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$DIR/scrub.mp4")"
  keys="$(ffprobe -v error -select_streams v:0 -skip_frame nokey -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$DIR/scrub.mp4")"
  echo "  scrub.mp4 keyframes: $keys of $frames frames"
fi

echo "Done. Now set VIDEO_SLOTS.$SLOT.ready = true in script.js."
