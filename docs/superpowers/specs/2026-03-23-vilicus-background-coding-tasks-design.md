# Vilicus Background Coding Tasks

**Date:** 2026-03-23
**Status:** Approved

## Goal

Every coding task Vilicus performs against the minas-team-ai repo runs as a background process, keeping WhatsApp responsive at all times. Vilicus acknowledges on WhatsApp what it is about to work on, the background agent reports when it starts and finishes, and users can query status at any point. Only one background task may run at a time; if one is already running when a new coding request arrives, Vilicus asks the user whether to cancel it or wait.

## Prerequisites

The minas-team-ai repo is mounted with `readonly: false` in Vilicus's `containerConfig` (confirmed in DB). The CLAUDE.md description of the mount as "read-only" is inaccurate and should be corrected as part of this work.

## Scope

Changes touch five areas:

1. `src/container-runner.ts` — tasks snapshot fields (**must deploy before Section 3 MCP change**)
2. `src/db.ts` — new DB helper function
3. `src/ipc.ts` — host-side safety net
4. `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP tool changes
5. `groups/whatsapp_main/CLAUDE.md` — Vilicus agent workflow

No new files. Sections 1–3 are host-side and can be deployed by restarting NanoClaw. Section 4 requires a container rebuild (`./container/build.sh`).

**Deployment order:** Section 1 (snapshot fields) must be live before Section 4 (MCP tool), because the MCP-level duplicate check reads `current_tasks.json` and filters on `run_mode`. If the snapshot omits `run_mode`, the filter silently returns zero matches, disabling the duplicate check.

## Architecture

```
User sends coding request
        │
        ▼
Vilicus foreground container (short-lived)
  1. Classifies request as coding vs question
  2. Calls list_tasks → checks for running bg task
  3a. Bg task exists → sends one WhatsApp message presenting cancel-or-wait choice;
      exits and waits for user's next message to act on their choice
  3b. No bg task → calls schedule_task(run_mode='background', once, immediate+5s)
  4. Sends WhatsApp acknowledgment: summary + task ID (parsed from MCP response)
  5. Exits (WhatsApp queue freed immediately)
        │
        ▼
Scheduler picks up the once/background task (within one poll interval, default 30s)
        │
        ▼
Background container (long-lived, separate queue slot bg:jid:taskId)
  1. send_message("Starting: <one-line summary>")
  2. Does coding work (write/edit/commit against /workspace/extra/minas-team-ai)
  3. send_message("Done: <result summary, PRs created, etc.>")
     or send_message("Failed: <reason>") on error
  4. Exits
```

When user asks for status, a new short foreground container runs, calls `list_tasks`, and reports active background tasks and their `last_result`.

**Note on `last_result` timing:** `last_result` in the DB is populated by `updateTaskAfterRun` only after the background container exits. It will be `null` while the task is running. `send_message("Starting: ...")` delivers the start notification to WhatsApp immediately but does not appear in `last_result`. A status query mid-run will show the task as active with `last_result: null`.

**Note on scheduler lag:** A `once` task scheduled for "now" will be picked up within one `SCHEDULER_POLL_INTERVAL` (default 30 seconds). This delay should be communicated to the user if needed.

## Section 1: Tasks Snapshot (deploy first)

**File:** `src/container-runner.ts` → `writeTasksSnapshot`
**Also:** `src/task-scheduler.ts` — the call site that maps task fields before passing to `writeTasksSnapshot`

Add `run_mode` and `last_result` to the mapped object at both the function signature and the call site in `task-scheduler.ts` (lines ~143–154). Currently both fields are explicitly dropped at the call site, so even though `getAllTasks()` returns them, they never reach the snapshot.

```ts
// Before (task-scheduler.ts call site)
tasks.map((t) => ({
  id: t.id,
  groupFolder: t.group_folder,
  prompt: t.prompt,
  schedule_type: t.schedule_type,
  schedule_value: t.schedule_value,
  status: t.status,
  next_run: t.next_run,
}))

// After
tasks.map((t) => ({
  id: t.id,
  groupFolder: t.group_folder,
  prompt: t.prompt,
  schedule_type: t.schedule_type,
  schedule_value: t.schedule_value,
  status: t.status,
  next_run: t.next_run,
  run_mode: t.run_mode ?? 'foreground',
  last_result: t.last_result ?? null,
}))
```

The `writeTasksSnapshot` function signature and the type it expects must be updated to accept these two new fields.

`last_result` is written as-is (not truncated) in the snapshot. Truncation to 150 chars is applied at display time inside `list_tasks` formatting, not at snapshot write time.

## Section 2: DB Helper

**File:** `src/db.ts`

Add a new exported function:

```ts
export function getActiveBackgroundTasksForGroup(groupFolder: string): ScheduledTask[]
```

Implementation: a single `SELECT` on `scheduled_tasks` filtered by `group_folder = ?`, `run_mode = 'background'`, `status = 'active'`. The `next_run IS NOT NULL` filter is intentionally omitted — a running task (currently executing in a container) will have `next_run IS NOT NULL` until `updateTaskAfterRun` clears it after the container exits, so both pending and executing tasks are correctly detected by `status = 'active'` alone.

## Section 3: Host Safety Net

**File:** `src/ipc.ts` → `processTaskIpc`, `schedule_task` case

After existing validation, before calling `createTask`, when `runMode === 'background'`:

1. Call `getActiveBackgroundTasksForGroup(targetFolder)`.
2. If any tasks returned, do **not** create the new task. Call `deps.sendMessage(targetJid, ...)` with:
   ```
   ⚠️ Background task already running ([task-id]). Cancel it first or wait for it to finish.
   ```
3. Log a warning and break.

`targetJid` is available as `data.targetJid` at this point (already validated in the enclosing `if` block). `deps.sendMessage` is already on `IpcDeps`.

This guard fires only if the MCP-level check (Section 4) was bypassed — typically a race condition where two IPC files were written before either was processed. It is the last line of defence, not the primary flow. Note that this guard does not close the running container; it only blocks the new task from being created.

## Section 4: MCP Tool Changes (deploy after Section 1)

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

### `schedule_task` — add `run_mode` parameter

Add an optional `run_mode: z.enum(['foreground', 'background']).default('foreground')` parameter.

When `run_mode === 'background'`:

1. Read `/workspace/ipc/current_tasks.json`. If the file does not exist, treat as empty.
2. Filter entries where `run_mode === 'background'` and `status === 'active'`.
3. If any exist, **return an error response** (do not write an IPC file):
   ```
   A background task is already running: [task-id] — "[first 60 chars of prompt]..."
   Cancel it with cancel_task("[task-id]") then retry, or wait for it to finish.
   ```
4. If none exist, write the IPC file as normal, including `run_mode: 'background'` in the payload.

The task ID is returned in the success response text (`Task ${taskId} scheduled: ...`). Vilicus must read this value from the MCP tool response to include in the WhatsApp acknowledgment.

**Race condition note:** The MCP check and the host guard both operate on eventually-consistent data (snapshot file and DB respectively). In the narrow window between two IPC files being written and one being processed, both may pass the MCP check. The host guard handles this case.

### `list_tasks` — expose `run_mode` and `last_result`

Include `run_mode` and `last_result` (truncated to 150 chars) in formatted output. Example:

```
- [task-abc123] Implement feature X... (once: 2026-03-23T14:05:00) — background, active, last: (none yet)
- [task-def456] Daily standup summary (cron: 0 9 * * *) — foreground, active, last: Sent standup for Mon 24 Mar
```

`last_result` will be `null` while a background task is mid-run (see architecture note above). Display as "(none yet)" in that case.

## Section 5: Vilicus CLAUDE.md

**File:** `groups/whatsapp_main/CLAUDE.md`

**Also fix:** correct the mount description — minas-team-ai is mounted read-write (`readonly: false` in containerConfig), not read-only as currently stated.

Add a "Background Coding Tasks" section:

### Classification

A request is a **coding task** if it requires writing, editing, refactoring, or committing code to the minas-team-ai repo (e.g., "implement X", "fix bug Y", "add feature Z", "create a PR for…"). For compound requests ("explain X and then fix it"), treat the whole request as a coding task if any part involves code changes.

Questions, explanations, and status checks are handled directly in the foreground — no background task needed.

### Coding Task Flow

1. Call `list_tasks` to check for an existing background task (`run_mode: background`, `status: active`).
2. **If one exists:** send a single WhatsApp message presenting the choice:
   > "I'm currently working on [brief description of running task]. Should I:
   > 1. Cancel it and start the new task
   > 2. Wait until it finishes"
   Then exit. When the user replies, handle their choice in the next foreground turn.
   - If user says cancel: call `cancel_task(task_id)`, then proceed to step 3.
   - If user says wait: acknowledge and exit.
3. **If none exists (or after cancel):** call `schedule_task` with:
   - `run_mode: 'background'`
   - `schedule_type: 'once'`
   - `schedule_value`: current local time plus 5 seconds, formatted as `YYYY-MM-DDTHH:MM:SS` with **no timezone suffix** (e.g., `2026-03-23T14:05:05`). Adding 5 seconds ensures the scheduler does not miss it on the current poll.
   - `context_mode: 'isolated'`
   - `prompt`: a self-contained prompt — include the full coding request, relevant file paths, branch to work on, and the send_message instructions below
4. Parse the task ID from the MCP tool response (format: `Task task-xxxxxxxx scheduled: ...`).
5. Call `send_message`: "On it — [one-line summary] (task `[task-id]`). I'll update you when it starts and finishes. There may be up to 30 seconds before it begins."
6. Exit.

### Status Query Flow

When the user asks what is being worked on, for a status update, or asks about task progress:

1. Call `list_tasks`.
2. Report active background tasks. If `last_result` is null (task is mid-run), say so explicitly: "It's still running — no result yet. You'll get a message when it finishes."
3. If no background tasks are running, say so and offer to start one if relevant.

### Background Task Prompt Template

Every background task prompt must include these instructions verbatim:

```
You are working on the minas-team-ai codebase at /workspace/extra/minas-team-ai.

First: call send_message with a one-line summary of exactly what you are about to do.

[... the actual coding instructions ...]

When finished: call send_message with a clear summary — what was done, any PRs or branches created, or if it failed, why it failed and what the user should do next.
If you encounter a blocking error you cannot resolve, call send_message immediately rather than retrying indefinitely.
```

## Error Handling

| Scenario | Handling |
|---|---|
| `schedule_task` MCP finds existing bg task | Returns structured error to agent; agent sends cancel-or-wait message and exits |
| Host IPC guard fires (race condition) | Drops duplicate task; sends WhatsApp warning to group |
| Background agent errors mid-run | Agent calls `send_message("Failed: [reason]")` and exits |
| Background agent crashes (no send_message) | User receives no WhatsApp notification; `last_result` set to container error after exit. User can detect via status query ("It's still running" → then task disappears). Consider a future watchdog to detect stale active tasks. |
| User cancels running bg task | Task deleted from DB; new task can be scheduled immediately on next message |
| Two coding requests race (both pass MCP check) | Host guard drops second; sends WhatsApp warning |

## Testing

- Send a coding request → verify Vilicus exits quickly and WhatsApp processes next message without waiting for the coding work
- Query status mid-task → verify `list_tasks` shows `run_mode: background`, `last_result: (none yet)`
- Background task completes → verify two send_message calls received (start + end)
- Send second coding request while first is running → verify Vilicus presents cancel-or-wait (not a second background task)
- Race condition (manually write two IPC files before processing) → verify host guard fires and only one task is created
- Schedule task with `next_run` 5 seconds ahead → verify it runs within 30 seconds of scheduling
