#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source="$root/native/macos/audio-capture.swift"
binary="$root/dist/native/audio-capture"
if ! /usr/bin/xcrun --find swiftc >/dev/null 2>&1; then
  echo 'audio-capture: Swift compiler missing; install Xcode Command Line Tools' >&2
  exit 1
fi
mkdir -p "$(dirname -- "$binary")"
if [ ! -x "$binary" ] || [ "$source" -nt "$binary" ]; then
  /usr/bin/xcrun swiftc "$source" -o "$binary"
fi
