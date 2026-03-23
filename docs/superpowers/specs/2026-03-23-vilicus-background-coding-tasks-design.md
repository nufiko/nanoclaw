# Vilicus Background Coding Tasks

**Date:** 2026-03-23
**Status:** Approved

## Goal

Every coding task Vilicus performs against the minas-team-ai repo runs as a background process, keeping WhatsApp responsive at all times. Vilicus acknowledges on WhatsApp what it is about to work on, the background agent reports when it starts and finishes, and users can query status at any point. Only one background task may run at a time; if one is already running when a new coding request arrives, Vilicus asks the user whether to cancel it or wait.

## Scope

Changes touch four areas:

1. `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP tool changes
2. `src/container-runner.ts` — tasks snapshot fields
3. `src/ipc.ts` — host-side safety net
4. `groups/whatsapp_main/CLAUDE.md` — Vilicus agent workflow

No new files, no schema migrations beyond what already exists (`run_mode` column is already present in `scheduled_tasks`).

## Architecture

```
User sends coding request
        │
        ▼
Vilicus foreground container (short-lived)
  1. Classifies request as coding vs question
  2. Calls list_tasks → checks for running bg task
  3a. Bg task exists → asks user: cancel or wait
  3b. No bg task → calls schedule_task(run_mode='background', once, immediate)
  4. Sends WhatsApp acknowledgment with task summary + task ID
  5. Exits (WhatsApp queue freed)
        │
        ▼
Scheduler picks up the once/background task
        │
        ▼
Background container (long-lived, separate queue slot bg:jid:taskId)
  1. send_message("Starting: <summary>")
  2. Does coding work
  3. send_message("Done: <result>" or "Failed: <error>")
  4. Exits
```

When user asks for status, a new short foreground container runs, calls `list_tasks`, and reports what is running plus the last result.

## Section 1: MCP Tool Changes

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

### `schedule_task` — add `run_mode` parameter

Add an optional `run_mode: z.enum(['foreground', 'background']).default('foreground')` parameter.

When `run_mode === 'background'`:

1. Read `/workspace/ipc/current_tasks.json`
2. Filter tasks where `run_mode === 'background'` and `status === 'active'`
3. If any exist, **return an error** (not an IPC file) to the agent:
   ```
   A background task is already running: [task-id] — "[prompt preview]"
   Cancel it with cancel_task(task_id) then retry, or wait for it to finish.
   ```
4. If none exist, write IPC file as normal, including `run_mode: 'background'` in the payload.

The error return prevents the IPC file from being written. The agent receives the structured error and can present cancel-or-wait options to the user in natural language.

### `list_tasks` — expose `run_mode` and `last_result`

The formatted task lines must include `run_mode` and `last_result` (truncated to 150 chars). Example output:

```
- [task-abc123] Implement feature X... (once: 2026-03-23T14:05:00) — background, active, last: Starting: implementing auth flow
```

## Section 2: Tasks Snapshot

**File:** `src/container-runner.ts` → `writeTasksSnapshot`

Add `run_mode` and `last_result` to the object mapped over tasks before writing `current_tasks.json`. Currently both fields are omitted, so `list_tasks` inside the container cannot see them.

```ts
// Before
{ id, groupFolder, prompt, schedule_type, schedule_value, status, next_run }

// After
{ id, groupFolder, prompt, schedule_type, schedule_value, status, next_run, run_mode, last_result }
```

## Section 3: Host Safety Net

**File:** `src/ipc.ts` → `processTaskIpc`, `schedule_task` case

After existing validation, before calling `createTask`, when `runMode === 'background'`:

1. Query the DB for any task where `group_folder = targetFolder`, `run_mode = 'background'`, `status = 'active'`, and `next_run IS NOT NULL`.
2. If found, do **not** create the task. Instead call `deps.sendMessage` to the `targetJid`:
   ```
   ⚠️ Background task already running ([task-id]). Cancel it first or wait for it to finish.
   ```
3. Log a warning and break.

This guard only fires if the MCP-level check (Section 1) was bypassed — e.g., due to a stale snapshot or race condition. It is not the primary enforcement mechanism.

The `IpcDeps` interface already has `sendMessage`. A new DB helper `getActiveBackgroundTasksForGroup(groupFolder: string): ScheduledTask[]` is needed in `src/db.ts` — a single `SELECT` filtering on `group_folder`, `run_mode`, `status`, and `next_run IS NOT NULL`.

## Section 4: Vilicus CLAUDE.md

**File:** `groups/whatsapp_main/CLAUDE.md`

Add a "Background Coding Tasks" section:

### Classification

A request is a **coding task** if it involves writing, editing, refactoring, or committing code to the minas-team-ai repo (e.g., "implement X", "fix bug Y", "add feature Z", "create a PR for…"). Everything else (questions, status checks, explanations) is handled directly in the foreground.

### Coding Task Flow

1. Call `list_tasks` to check for an existing background task (`run_mode: background`, `status: active`).
2. **If one exists:** present the user with a clear choice:
   - "Cancel current task ([brief description]) and start this one"
   - "Wait — I'll tackle this after the current task finishes"
   - If user says cancel: call `cancel_task(task_id)`, then proceed to step 3.
   - If user says wait: acknowledge and exit.
3. **If none exists (or after cancel):** call `schedule_task` with:
   - `run_mode: 'background'`
   - `schedule_type: 'once'`
   - `schedule_value`: the current local time (immediate execution)
   - `context_mode: 'isolated'`
   - `prompt`: a self-contained prompt including the full coding request, relevant file paths, and the instruction to `send_message` on start and completion (see Background Task Prompt below)
4. Call `send_message` to WhatsApp: "On it — [one-line summary of what will be done] (task `[task-id]`). I'll update you when it's done."
5. Exit.

### Status Query Flow

When the user asks what Vilicus is working on, for an update, or for task status:

1. Call `list_tasks`.
2. Report active background tasks and their `last_result` if available.
3. If no background tasks are running, say so.

### Background Task Prompt Template

Every background task prompt must begin with:

```
You are working on the minas-team-ai codebase.

Start by calling send_message with a one-line summary of what you are about to do.

[... the actual coding instructions ...]

When finished, call send_message with a summary of what was done, any PRs created, or errors encountered. If the task failed, explain why clearly.
```

## Error Handling

| Scenario | Handling |
|---|---|
| `schedule_task` MCP finds existing bg task | Returns error to agent; agent presents cancel-or-wait to user |
| Host IPC guard triggers (race condition) | Sends WhatsApp warning; drops duplicate task silently |
| Background task errors mid-run | Background agent sends `send_message("Failed: [reason]")` |
| Background agent crashes without send_message | `last_result` in DB will be the error; user can query via status flow |
| User cancels bg task via cancel_task | Task deleted from DB; new one can be scheduled immediately |

## Testing

- Schedule a background task → verify WhatsApp immediately freed (new message processed without waiting)
- Schedule second background task while first is active → verify agent receives error and presents cancel-or-wait
- Race condition: write two IPC files simultaneously → verify host guard fires and second task is dropped
- Status query mid-task → verify `list_tasks` returns `run_mode`, `last_result`
- Background task completes → verify `send_message` delivered to WhatsApp
