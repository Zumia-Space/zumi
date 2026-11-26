#!/bin/sh
# Regenerates the 20 T58 clips from sentences.tsv with the TTS already on this PC (nothing is downloaded):
#   vi-*  Piper vi_VN-vais1000-medium (PIPER and VOICE name its program and model), then ffmpeg to 16 kHz mono 16-bit
#   en-*  Windows SAPI (System.Speech), written at 16 kHz mono 16-bit by make-en.ps1
# Synthesized, not a microphone. Runs below normal priority, one process at a time, one thread each.
#   sh make-fixtures.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
PIPER="${PIPER:?set PIPER to the piper executable}"
VOICE="${VOICE:?set VOICE to the vi_VN-vais1000-medium.onnx model}"
FFMPEG="${FFMPEG:-ffmpeg}"
tmp="$here/.tmp"
mkdir -p "$tmp"
while IFS="$(printf '\t')" read -r id lang text; do
  [ "$lang" = vi ] || continue
  printf '%s\n' "$text" > "$tmp/$id.txt"
  "$PIPER" -m "$VOICE" -i "$tmp/$id.txt" -f "$tmp/$id.raw.wav" > /dev/null
  "$FFMPEG" -y -loglevel error -threads 1 -i "$tmp/$id.raw.wav" -ar 16000 -ac 1 -sample_fmt s16 "$here/$id.wav"
  rm -f "$tmp/$id.txt" "$tmp/$id.raw.wav"
done < "$here/sentences.tsv"
powershell -NoProfile -ExecutionPolicy Bypass -File "$here/make-en.ps1" -Tsv "$here/sentences.tsv" -Out "$here"
rmdir "$tmp"
ls "$here"/*.wav | wc -l
