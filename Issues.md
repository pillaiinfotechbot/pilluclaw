# NanoClaw / CMDCenter Issues Log

This file is read by the self-healing mechanism (`scripts/self-heal.sh`) to track
and resolve recurring errors. Update entries as issues are found and fixed.

---

## Format

```
### [STATUS] ISSUE-NNN — Short title
- **Detected:** YYYY-MM-DD HH:MM IST
- **Fixed:** YYYY-MM-DD HH:MM IST (or "OPEN")
- **Root cause:** ...
- **Fix applied:** ...
- **Recurrence check:** command to verify fix is still working
```

---

## Current Issues

### [FIXED] ISSUE-001 — VirtualChannel missing: agents never processed tasks
- **Detected:** 2026-03-31 09:51 IST
- **Fixed:** 2026-03-31 10:31 IST
- **Root cause:** `processGroupMessages()` in `index.ts` requires a `Channel` that
  `ownsJid()` returns true for the incoming JID. `virtual:xxx` JIDs (used by the
  CMDCenter poller for Docker agent containers) had no registered Channel. So every
  task injection was silently skipped with "No channel owns JID, skipping messages".
  All 12 in-progress tasks were stuck; 22 agents showed no heartbeat.
- **Fix applied:** Created `src/channels/virtual.ts` — a VirtualChannel that owns
  any `virtual:xxx` JID, is always connected, and is a no-op for sendMessage
  (agent output flows back to CMDCenter via API, not via chat). Registered in
  `src/channels/index.ts`. Built and restarted pilluclaw.
- **Recurrence check:**
  ```bash
  grep "No channel owns JID" /Users/mac/Development/pilluclaw/logs/nanoclaw.log | tail -5
  # Should return 0 results after the fix date
  ```

### [OPEN] ISSUE-002 — Task 829 (Manoj Pillai) has no webhook
- **Detected:** 2026-03-31 09:56 IST
- **Fixed:** OPEN
- **Root cause:** Task #829 ("ACTION REQUIRED: Push aichatbot Stage 2") is assigned
  to "Manoj Pillai" (a human). The heartbeat tries to dispatch it but no webhook
  is configured. Dispatching fails silently every cycle.
- **Fix needed:** Either reassign task #829 to an agent, or mark it completed/in-review
  manually. Human-assigned tasks should be filtered from the dispatch loop.
- **Recurrence check:**
  ```bash
  curl -s "https://cmdcenterapi.pillaiinfotech.com/api/v1/tasks/829" \
    -H "X-Bot-Key: nc_bot_pillai2026" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['status'], d['data']['assigned_agent'])"
  ```

### [OPEN] ISSUE-003 — 3 agents missing webhook URLs (DevOps Agent, LocalAI, Browser Agent)
- **Detected:** 2026-03-31 09:56 IST
- **Fixed:** OPEN
- **Root cause:** Agents "DevOps Agent", "LocalAI", "Browser Agent" exist in CMDCenter
  but have no `webhook_url` set in the integrations table. Heartbeat reports
  "missing webhook URLs" every cycle.
- **Fix needed:** Either add virtual JIDs to these agents' integrations rows, or
  mark them inactive if not yet implemented.
- **Recurrence check:**
  ```bash
  grep "missing webhook URLs" /Users/mac/Development/pilluclaw/logs/nanoclaw.log | tail -3
  ```

### [OPEN] ISSUE-004 — Auto-fix tasks clogging the pipeline
- **Detected:** 2026-03-31 10:16 IST
- **Fixed:** OPEN
- **Root cause:** The CMDCenter heartbeat auto-generated 6+ AUTO-FIX and ESCALATION
  tasks (#824–#831) because it detected stuck agents. These tasks are now also
  stuck in `in_progress` waiting for agents. This creates a self-reinforcing loop:
  stuck agents → auto-fix tasks → more stuck tasks.
- **Fix needed:** After ISSUE-001 fix, agents should clear these auto-fix tasks.
  If they don't within 1h, bulk-close them via API:
  ```bash
  for id in 824 825 826 827 828 830 831; do
    curl -s -X PUT "https://cmdcenterapi.pillaiinfotech.com/api/v1/tasks/$id" \
      -H "X-Bot-Key: nc_bot_pillai2026" \
      -H "Content-Type: application/json" \
      -d '{"status":"completed","result":"Auto-closed: resolved by ISSUE-001 fix (VirtualChannel)"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success'), d.get('message',''))"
  done
  ```

### [OPEN] ISSUE-005 — Docker container startup errors in error log (historical)
- **Detected:** 2026-03-30 (before 10:16 IST)
- **Fixed:** OPEN (Docker is running now — errors are from past boot attempts)
- **Root cause:** `nanoclaw.error.log` shows repeated "FATAL: Container runtime failed
  to start" messages. These occurred when pilluclaw started before Docker Desktop was
  fully initialised.
- **Fix needed:** Increase the retry window in `container-runtime.ts` or add a launchctl
  dependency on Docker. Low priority — Docker is running and agents now process tasks.
- **Recurrence check:**
  ```bash
  docker info 2>&1 | head -3
  tail -5 /Users/mac/Development/pilluclaw/logs/nanoclaw.error.log
  ```

---

## Self-Healing Script

Run manually or via cron (`scripts/self-heal.sh`):

```bash
bash /Users/mac/Development/pilluclaw/scripts/self-heal.sh
```

The script checks each OPEN issue's recurrence command and applies known fixes
automatically where safe. It sends a Telegram summary when done.

---

## Resolved Issues Archive

| ID | Title | Fixed |
|----|-------|-------|
| ISSUE-001 | VirtualChannel missing | 2026-03-31 |
