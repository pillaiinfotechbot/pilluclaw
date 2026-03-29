#!/bin/bash
# Rotate nanoclaw log files when they exceed 50MB
# Keeps 5 rotated copies. Run daily via launchd.

rotate() {
  local file="$1"
  local max_kb="${2:-51200}"   # 50MB default
  local keep="${3:-5}"

  [ -f "$file" ] || return
  local size_kb
  size_kb=$(du -k "$file" | cut -f1)
  [ "$size_kb" -lt "$max_kb" ] && return

  # Shift existing rotations
  for i in $(seq $((keep-1)) -1 1); do
    [ -f "${file}.${i}.gz" ] && mv "${file}.${i}.gz" "${file}.$((i+1)).gz"
  done
  [ -f "${file}.0" ] && gzip -f "${file}.0"

  # Move current log to .0 (process keeps writing to original fd, launchd reopens)
  cp "$file" "${file}.0"
  : > "$file"
  gzip -f "${file}.0"
  echo "[$(date)] Rotated: $file (was ${size_kb}KB)"
}

rotate ~/Development/pilluclaw/logs/nanoclaw.log        51200 5
rotate ~/Development/pilluclaw/logs/nanoclaw.error.log  10240 3
rotate ~/Development/maddyclaw/logs/nanoclaw.log        51200 5
rotate ~/Development/maddyclaw/logs/nanoclaw.error.log  10240 3
rotate ~/Development/nanoclaw/logs/nanoclaw.log         51200 5
rotate ~/Development/nanoclaw/logs/nanoclaw.error.log   10240 3
rotate ~/.nanoclaw/sysbridge/bridge.log                 10240 3
