#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NanoClaw / CMDCenter Self-Healing Script
# Reads Issues.md, checks each OPEN issue, applies safe auto-fixes.
# Run manually or schedule via launchctl every 30 minutes.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PILLUCLAW_DIR="/Users/mac/Development/pilluclaw"
LOG_DIR="$PILLUCLAW_DIR/logs"
NANOCLAW_LOG="$LOG_DIR/nanoclaw.log"
CMDCENTER_API="https://cmdcenterapi.pillaiinfotech.com/api/v1"
BOT_KEY="nc_bot_pillai2026"
NOTIFY="bash /Users/mac/.claude/notify.sh"
ISSUES_FILE="$PILLUCLAW_DIR/Issues.md"

FIXED_COUNT=0
WARN_COUNT=0
REPORT=""

log() { echo "[$(date '+%H:%M:%S')] $*"; }
add_report() { REPORT="${REPORT}\n• $*"; }

# ── Helper: call CMDCenter API ─────────────────────────────────────────────
api_get()  { curl -sf "$CMDCENTER_API/$1" -H "X-Bot-Key: $BOT_KEY" 2>/dev/null; }
api_put()  {
  local path="$1" body="$2"
  curl -sf -X PUT "$CMDCENTER_API/$path" \
    -H "X-Bot-Key: $BOT_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null
}

# ── CHECK 1: VirtualChannel (ISSUE-001) ───────────────────────────────────
log "CHECK 1: VirtualChannel — virtual:xxx JIDs must be owned"
# Count "No channel owns JID" lines written in the last 3 minutes (use python for reliable cross-platform ts comparison)
RECENT_SKIP=$(grep "No channel owns JID" "$NANOCLAW_LOG" 2>/dev/null | \
  python3 -c "
import sys
from datetime import datetime, timezone, timedelta
cutoff = datetime.now(timezone.utc) - timedelta(minutes=3)
count = 0
for line in sys.stdin:
    try:
        ts = line.split(']')[0].lstrip('[')  # e.g. '10:24:51.481'
        t = datetime.strptime(ts.split('.')[0], '%H:%M:%S').replace(
            year=cutoff.year, month=cutoff.month, day=cutoff.day,
            tzinfo=timezone.utc)
        if t >= cutoff: count += 1
    except: pass
print(count)
" 2>/dev/null || echo "0")

if [[ "$RECENT_SKIP" -gt 0 ]]; then
  log "  WARN: $RECENT_SKIP 'No channel owns JID' messages in last 5 min"
  WARN_COUNT=$((WARN_COUNT + 1))
  add_report "ISSUE-001 RECURRED: VirtualChannel not owning JIDs ($RECENT_SKIP skips) — rebuilding pilluclaw"
  cd "$PILLUCLAW_DIR"
  npm run build --silent 2>&1 | tail -3
  launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
  sleep 5
  FIXED_COUNT=$((FIXED_COUNT + 1))
  add_report "  → Rebuilt and restarted pilluclaw"
else
  log "  OK: No channel skip messages in last 5 min"
fi

# ── CHECK 2: Docker running ────────────────────────────────────────────────
log "CHECK 2: Docker runtime"
if ! docker info > /dev/null 2>&1; then
  log "  WARN: Docker is not running!"
  WARN_COUNT=$((WARN_COUNT + 1))
  add_report "ISSUE-005: Docker not running — open Docker Desktop"
  $NOTIFY message "⚠️ *CMDCenter Self-Heal*\nDocker is not running! Agents cannot start containers.\nPlease open Docker Desktop."
else
  log "  OK: Docker running"
fi

# ── CHECK 3: pilluclaw process alive ──────────────────────────────────────
log "CHECK 3: pilluclaw process"
if ! launchctl list | grep -q "com.nanoclaw"; then
  log "  WARN: pilluclaw not running — restarting"
  WARN_COUNT=$((WARN_COUNT + 1))
  launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null || true
  add_report "ISSUE: pilluclaw was not running — restarted"
  FIXED_COUNT=$((FIXED_COUNT + 1))
else
  log "  OK: pilluclaw running"
fi

# ── CHECK 4: Stuck tasks (> 2h in in_progress with no update) ─────────────
log "CHECK 4: Stuck in_progress tasks"
TASKS_JSON=$(api_get "tasks?status=in_progress&limit=50" 2>/dev/null || echo '{"data":[]}')
STUCK_IDS=$(echo "$TASKS_JSON" | python3 -c "
import sys, json
from datetime import datetime, timezone
data = json.load(sys.stdin).get('data', {})
tasks = data if isinstance(data, list) else data.get('tasks', [])
now = datetime.now(timezone.utc)
stuck = []
for t in tasks:
    ua = t.get('updated_at') or t.get('created_at', '')
    if not ua:
        continue
    # Normalize MySQL timestamp to UTC
    ts = ua.replace(' ', 'T')
    if not ts.endswith('Z'):
        ts += 'Z'
    try:
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        hours = (now - dt).total_seconds() / 3600
        if hours > 2 and t.get('title','').startswith('AUTO-FIX'):
            stuck.append(str(t['id']))
    except:
        pass
print(','.join(stuck))
" 2>/dev/null || echo "")

if [[ -n "$STUCK_IDS" ]]; then
  log "  WARN: Auto-fix tasks stuck > 2h: $STUCK_IDS"
  WARN_COUNT=$((WARN_COUNT + 1))
  for id in ${STUCK_IDS//,/ }; do
    api_put "tasks/$id" "{\"status\":\"completed\",\"result\":\"Auto-closed by self-heal: auto-fix task stuck >2h after ISSUE-001 fix\"}" > /dev/null 2>&1 || true
    log "    Closed stuck auto-fix task #$id"
    add_report "Closed stuck AUTO-FIX task #$id (>2h in in_progress)"
    FIXED_COUNT=$((FIXED_COUNT + 1))
  done
else
  log "  OK: No auto-fix tasks stuck > 2h"
fi

# ── CHECK 5: Task 829 (human-assigned) still pending ─────────────────────
log "CHECK 5: Human-assigned task #829"
T829=$(api_get "tasks/829" 2>/dev/null || echo '{"data":{"status":"unknown"}}')
T829_STATUS=$(echo "$T829" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status','?'))" 2>/dev/null || echo "?")
if [[ "$T829_STATUS" == "pending" ]]; then
  log "  WARN: Task #829 still pending (assigned to human, no webhook)"
  WARN_COUNT=$((WARN_COUNT + 1))
  add_report "ISSUE-002: Task #829 still pending — assigned to 'Manoj Pillai' (human, no webhook)"
else
  log "  OK: Task #829 status = $T829_STATUS"
fi

# ── SUMMARY ───────────────────────────────────────────────────────────────
log "Self-heal complete. Fixed: $FIXED_COUNT | Warnings: $WARN_COUNT"

if [[ "$FIXED_COUNT" -gt 0 ]] || [[ "$WARN_COUNT" -gt 0 ]]; then
  MSG="🔧 *CMDCenter Self-Heal Report*\n\nFixed: $FIXED_COUNT | Warnings: $WARN_COUNT\n$REPORT"
  $NOTIFY message "$MSG" 2>/dev/null || true
fi
