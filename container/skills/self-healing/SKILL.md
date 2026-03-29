---
name: self-healing
description: Detect system issues (stuck tasks, failed agents, errors) and auto-delegate fixes to the responsible agent via CMDCenter. Never escalate to Manoj unless genuinely unresolvable.
---

# Self-Healing System

When you detect a problem — whether during a health check or while executing a task — **do not create a task for Manoj**. Instead, delegate it immediately to the responsible agent via CMDCenter.

---

## Issue → Responsible Agent Map

| Issue Type | Assign To | Priority |
|-----------|-----------|----------|
| Task stuck in `in_progress` > 2 hours | `PM Agent` | high |
| Task retries exhausted (`retry_count >= max_retries`) | `CTO Agent` | high |
| CMDCenter API returning errors (5xx) | `CMDCenter DevBot` | critical |
| Dispatcher re-sending completed tasks | `CTO Agent` | high |
| Duplicate tasks for same agent+title | `CMDCenter DevBot` | medium |
| NanoClaw service down / container failures | `SYS Agent` | critical |
| QA/Review agent not picking up tasks | `PM Agent` | high |
| Agent returning wrong status transitions | `CTO Agent` | high |
| Code bug found during task execution | `Dev Agent` | high |
| Architecture / design issue | `Architect Agent` | medium |
| Budget / cost overrun detected | `CFO Agent` | high |

---

## How to Delegate a Fix

```bash
curl -s -X POST "https://cmdcenterapi.pillaiinfotech.com/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -H "X-Bot-Key: nc_bot_pillai2026" \
  -d '{
    "title": "AUTO-FIX: {short description of the issue}",
    "description": "Detected automatically by health monitor.\n\n{full details: what was detected, task IDs affected, error messages, timestamps}\n\n## Expected Fix\n{what the fix should do}\n\n## Acceptance Criteria\n- [ ] Issue resolved and verified\n- [ ] No recurrence in next 2 hours",
    "assigned_agent": "{agent from table above}",
    "priority": "{priority from table above}",
    "project_id": 1
  }'
```

---

## Handling Stuck Tasks

When a task has been `in_progress` for more than 2 hours with no update:

```bash
# 1. Reset task to pending so it gets re-picked
curl -s -X PUT "https://cmdcenterapi.pillaiinfotech.com/api/v1/tasks/{id}" \
  -H "Content-Type: application/json" \
  -H "X-Bot-Key: nc_bot_pillai2026" \
  -d '{"status": "pending", "notes": "Auto-reset by health monitor: task stuck in in_progress > 2h. retry_count incremented."}'

# 2. Notify PMBot by creating a task
curl -s -X POST "https://cmdcenterapi.pillaiinfotech.com/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -H "X-Bot-Key: nc_bot_pillai2026" \
  -d '{
    "title": "AUTO-FIX: Task #{id} stuck — reset to pending",
    "description": "Task #{id} ({title}) assigned to {agent} was stuck in in_progress for {hours}h. Auto-reset to pending. Investigate if it recurs.",
    "assigned_agent": "PM Agent",
    "priority": "high",
    "project_id": 1
  }'
```

---

## Escalate to Manoj Only When

- Issue has recurred 3+ times after auto-fix attempts
- Data loss or irreversible action is at risk
- A permanent agent needs to be removed or added
- Financial anomaly > $50 detected

In these cases, use the standard `ACTION REQUIRED:` task format assigned to `Manoj Pillai`.

---

## Health Check Script (for scheduled tasks)

Use this bash script as the `script` field when scheduling health monitors. It runs first — agent only wakes if issues are found.

```bash
#!/bin/bash
CMDCENTER_API="https://cmdcenterapi.pillaiinfotech.com/api/v1"
BOT_KEY="nc_bot_pillai2026"

result=$(python3 -c "
import urllib.request, json
from datetime import datetime, timezone

headers = {'X-Bot-Key': '$BOT_KEY'}

def fetch(url):
    req = urllib.request.Request(url, headers=headers)
    return json.loads(urllib.request.urlopen(req, timeout=10).read())

issues = []

# Stuck in_progress tasks (> 2 hours)
try:
    d = fetch('$CMDCENTER_API/tasks?status=in_progress&limit=50')
    now = datetime.now(timezone.utc)
    for t in (d.get('data') or []):
        s = t.get('started_at')
        if s:
            try:
                dt = datetime.fromisoformat(s.replace(' ', 'T') + '+00:00' if '+' not in s and 'Z' not in s else s.replace('Z', '+00:00'))
                hours = (now - dt).total_seconds() / 3600
                if hours > 2:
                    issues.append({'type': 'stuck_task', 'task_id': t['id'], 'title': t['title'], 'agent': t.get('assigned_agent'), 'hours': round(hours, 1)})
            except: pass
except Exception as e:
    issues.append({'type': 'api_error', 'detail': str(e)})

# Exhausted retries
try:
    d = fetch('$CMDCENTER_API/tasks?status=pending&limit=50')
    for t in (d.get('data') or []):
        rc = t.get('retry_count') or 0
        mr = t.get('max_retries') or 3
        if rc >= mr:
            issues.append({'type': 'retries_exhausted', 'task_id': t['id'], 'title': t['title'], 'agent': t.get('assigned_agent'), 'retries': rc})
except: pass

wake = len(issues) > 0
print(json.dumps({'wakeAgent': wake, 'data': {'issues': issues}}))
")

echo "$result"
```
