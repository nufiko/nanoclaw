# Vilicus Background Coding Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every coding task Vilicus performs against the minas-team-ai repo runs as a background process, keeping WhatsApp immediately responsive, with start/end notifications and single-task concurrency enforcement.

**Architecture:** Four host-side changes (snapshot fields, DB helper, IPC guard, restart NanoClaw) followed by a container MCP tool update (rebuild required), then a CLAUDE.md behavioral update. Host-side changes must be deployed before the container rebuild because the MCP tool reads `current_tasks.json` which is written by the host.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, vitest, MCP SDK (`@modelcontextprotocol/sdk`), zod

---

## File Map

| File | Change |
|------|--------|
| `src/container-runner.ts` | Extend `writeTasksSnapshot` signature to include `run_mode` and `last_result` |
| `src/task-scheduler.ts` | Add `run_mode` and `last_result` to the mapped object passed to `writeTasksSnapshot` |
| `src/db.ts` | Add `getActiveBackgroundTasksForGroup(groupFolder)` query |
| `src/ipc.ts` | Add background task duplicate guard in `processTaskIpc` `schedule_task` case |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `run_mode` param to `schedule_task`; add duplicate check; update `list_tasks` output |
| `groups/whatsapp_main/CLAUDE.md` | Add Background Coding Tasks workflow section; fix mount description |
| `src/db.test.ts` | Tests for `getActiveBackgroundTasksForGroup` |
| `src/ipc-auth.test.ts` | Tests for background task duplicate guard |

---

## Task 1: Extend tasks snapshot with `run_mode` and `last_result`

**Spec:** Section 1 — deploy before MCP changes.

**Files:**
- Modify: `src/container-runner.ts:694-718` (`writeTasksSnapshot` function)
- Modify: `src/task-scheduler.ts:142-153` (call site that maps task fields)

**Background:** `writeTasksSnapshot` writes `current_tasks.json` into the container's IPC directory so agents can call `list_tasks`. The function currently accepts a typed array of 7 fields. The call site in `task-scheduler.ts` maps `getAllTasks()` results to that shape, explicitly dropping `run_mode` and `last_result`. Both need updating together — the function signature and the call site.

- [ ] **Step 1: Update `writeTasksSnapshot` signature in `src/container-runner.ts`**

Find the function at line 694. Replace the `tasks` parameter type to add the two new fields:

```ts
export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
    run_mode: string;
    last_result: string | null;
  }>,
): void {
```

The function body does not need changes — it serialises the array as-is.

- [ ] **Step 2: Update the call site in `src/task-scheduler.ts`**

Find the `tasks.map(...)` block around line 145. Add `run_mode` and `last_result`:

```ts
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
})),
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts src/task-scheduler.ts
git commit -m "feat: include run_mode and last_result in tasks snapshot"
```

---

## Task 2: Add `getActiveBackgroundTasksForGroup` DB helper

**Spec:** Section 2 — used by the IPC guard in Task 3.

**Files:**
- Modify: `src/db.ts` (add function after `getTasksForGroup` at line ~404)
- Modify: `src/db.test.ts` (new describe block)

- [ ] **Step 1: Write failing tests in `src/db.test.ts`**

Add this describe block. The test file already imports `_initTestDatabase` and `createTask` — add `getActiveBackgroundTasksForGroup` to the import list too.

```ts
import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getActiveBackgroundTasksForGroup,  // add this
  getMessagesSince,
  getNewMessages,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

// ... existing tests ...

describe('getActiveBackgroundTasksForGroup', () => {
  function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
    const base = {
      id: `task-${Math.random().toString(36).slice(2)}`,
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'do something',
      schedule_type: 'once' as const,
      schedule_value: '2026-03-23T14:00:00',
      context_mode: 'isolated' as const,
      run_mode: 'background' as const,
      next_run: '2026-03-23T14:00:00.000Z',
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    return { ...base, ...overrides };
  }

  it('returns active background tasks for the group', () => {
    createTask(makeTask({ id: 'bg-1' }));
    const result = getActiveBackgroundTasksForGroup('whatsapp_main');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bg-1');
  });

  it('does not return foreground tasks', () => {
    createTask(makeTask({ id: 'fg-1', run_mode: 'foreground' }));
    const result = getActiveBackgroundTasksForGroup('whatsapp_main');
    expect(result).toHaveLength(0);
  });

  it('does not return paused background tasks', () => {
    createTask(makeTask({ id: 'bg-paused', status: 'paused' }));
    const result = getActiveBackgroundTasksForGroup('whatsapp_main');
    expect(result).toHaveLength(0);
  });

  it('does not return background tasks for other groups', () => {
    createTask(makeTask({ id: 'bg-other', group_folder: 'other-group' }));
    const result = getActiveBackgroundTasksForGroup('whatsapp_main');
    expect(result).toHaveLength(0);
  });

  it('returns multiple active background tasks if they exist', () => {
    createTask(makeTask({ id: 'bg-2' }));
    createTask(makeTask({ id: 'bg-3' }));
    const result = getActiveBackgroundTasksForGroup('whatsapp_main');
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/db.test.ts
```

Expected: failures mentioning `getActiveBackgroundTasksForGroup` is not exported / not a function.

- [ ] **Step 3: Implement the function in `src/db.ts`**

Add after `getTasksForGroup` (around line 410):

```ts
export function getActiveBackgroundTasksForGroup(
  groupFolder: string,
): ScheduledTask[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE group_folder = ? AND run_mode = 'background' AND status = 'active'
       ORDER BY created_at DESC`,
    )
    .all(groupFolder) as ScheduledTask[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/db.test.ts
```

Expected: all tests pass including the new describe block.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add getActiveBackgroundTasksForGroup DB helper"
```

---

## Task 3: Add background task duplicate guard in IPC

**Spec:** Section 3 — host safety net that fires when the MCP-level check is bypassed.

**Files:**
- Modify: `src/ipc.ts` (`processTaskIpc`, `schedule_task` case, around line 264)
- Modify: `src/ipc-auth.test.ts` (new tests)

**Background:** `processTaskIpc` handles IPC files written by agents. The `schedule_task` case already validates the prompt/schedule fields and creates the task. We need to add a check: if `runMode === 'background'` and an active background task already exists for the target group, drop the new task and send a WhatsApp warning instead. `deps.sendMessage` is already on `IpcDeps`.

- [ ] **Step 1: Add the import in `src/ipc.ts`**

At the top of `src/ipc.ts`, add `getActiveBackgroundTasksForGroup` to the `db` imports:

```ts
import { createTask, deleteTask, getTaskById, updateTask, getActiveBackgroundTasksForGroup } from './db.js';
```

- [ ] **Step 2: Write failing tests in `src/ipc-auth.test.ts`**

The existing test file sets up `deps` with `sendMessage: async () => {}`. Add a new describe block that spies on `sendMessage` and verifies the guard behaviour. Add this after the existing test groups:

```ts
describe('schedule_task background duplicate guard', () => {
  function makeScheduleData(overrides: Record<string, unknown> = {}) {
    return {
      type: 'schedule_task',
      prompt: 'implement feature X',
      schedule_type: 'once',
      schedule_value: '2026-03-23T14:00:00',
      context_mode: 'isolated',
      run_mode: 'background',
      targetJid: 'main@g.us',
      ...overrides,
    };
  }

  it('creates the task when no active background task exists', async () => {
    await processTaskIpc(makeScheduleData(), 'whatsapp_main', true, deps);
    const tasks = getAllTasks();
    expect(tasks.some((t) => t.run_mode === 'background')).toBe(true);
  });

  it('blocks a second background task and calls sendMessage with warning', async () => {
    const messages: Array<[string, string]> = [];
    const guardDeps: IpcDeps = {
      ...deps,
      sendMessage: async (jid, text) => { messages.push([jid, text]); },
    };

    // Create first background task
    await processTaskIpc(makeScheduleData({ prompt: 'first task' }), 'whatsapp_main', true, guardDeps);
    const countAfterFirst = getAllTasks().filter(t => t.run_mode === 'background').length;
    expect(countAfterFirst).toBe(1);

    // Attempt second background task
    await processTaskIpc(makeScheduleData({ prompt: 'second task' }), 'whatsapp_main', true, guardDeps);
    const countAfterSecond = getAllTasks().filter(t => t.run_mode === 'background').length;
    expect(countAfterSecond).toBe(1); // still 1, second was blocked

    expect(messages).toHaveLength(1);
    expect(messages[0][0]).toBe('main@g.us');
    expect(messages[0][1]).toMatch(/background task already running/i);
  });

  it('allows a new background task after existing one is paused', async () => {
    // Create and then pause the first
    await processTaskIpc(makeScheduleData({ prompt: 'first' }), 'whatsapp_main', true, deps);
    const [firstTask] = getAllTasks().filter(t => t.run_mode === 'background');
    updateTask(firstTask.id, { status: 'paused' });

    // Now schedule a new one — should succeed
    await processTaskIpc(makeScheduleData({ prompt: 'second' }), 'whatsapp_main', true, deps);
    const active = getAllTasks().filter(t => t.run_mode === 'background' && t.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].prompt).toBe('second');
  });
});
```

Note: `getAllTasks` and `updateTask` need to be imported in the test file if not already. Add them:
```ts
import { _initTestDatabase, createTask, getAllTasks, getRegisteredGroup, getTaskById, setRegisteredGroup, updateTask } from './db.js';
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run src/ipc-auth.test.ts
```

Expected: the new tests fail (guard logic not yet implemented).

- [ ] **Step 4: Implement the guard in `src/ipc.ts`**

In the `schedule_task` case, after the authorization check (after the `if (!isMain && targetFolder !== sourceGroup)` block, around line 264) and before the `createTask` call, insert:

```ts
// Background task duplicate guard (safety net — primary check is in MCP tool)
if (runMode === 'background') {
  const existing = getActiveBackgroundTasksForGroup(targetFolder);
  if (existing.length > 0) {
    logger.warn(
      { sourceGroup, targetFolder, existingTaskId: existing[0].id },
      'Background task duplicate blocked by host guard',
    );
    await deps.sendMessage(
      targetJid,
      `⚠️ Background task already running (${existing[0].id}). Cancel it first or wait for it to finish.`,
    );
    break;
  }
}
```

Place this block immediately before the `createTask(...)` call.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/ipc-auth.test.ts
```

Expected: all tests pass including the new describe block.

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit and restart NanoClaw**

```bash
git add src/ipc.ts src/ipc-auth.test.ts
git commit -m "feat: add host-side background task duplicate guard"
```

Then restart to pick up all host-side changes:

```bash
systemctl --user restart nanoclaw
```

---

## Task 4: MCP tool changes (container rebuild required)

**Spec:** Section 4 — deploy after host-side changes are live.

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Background:** The MCP server runs inside the container as a subprocess. It reads `/workspace/ipc/current_tasks.json` (written by the host). The agent calls `schedule_task` with `run_mode: 'background'`; the tool checks for duplicates in the snapshot and returns an error to the agent if one is found — so the agent can present cancel-or-wait to the user before any IPC file is written.

No unit tests exist for the MCP server (it's container-internal). Changes are verified by typecheck + manual test after rebuild.

### Sub-task 4a: Add `run_mode` param and duplicate check to `schedule_task`

- [ ] **Step 1: Add `run_mode` to the `schedule_task` tool definition**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, find the `schedule_task` tool definition. Add `run_mode` to the schema object (alongside `prompt`, `schedule_type`, etc.):

```ts
run_mode: z.enum(['foreground', 'background']).default('foreground').describe(
  'foreground=runs in the group queue (blocks WhatsApp), background=runs in a separate queue (WhatsApp stays responsive). Use background for long coding tasks.'
),
```

- [ ] **Step 2: Add the duplicate check logic inside the tool handler**

After the existing `schedule_value` validation block and before the `targetJid` resolution, add:

```ts
// Background duplicate check: read current_tasks.json and block if one is already active
if (args.run_mode === 'background') {
  const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
  let existingBgTask: { id: string; prompt: string } | null = null;
  try {
    if (fs.existsSync(tasksFile)) {
      const all = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
        id: string;
        prompt: string;
        run_mode?: string;
        status?: string;
      }>;
      const found = all.find(
        (t) => t.run_mode === 'background' && t.status === 'active',
      );
      if (found) existingBgTask = { id: found.id, prompt: found.prompt };
    }
  } catch {
    // If we can't read the snapshot, proceed (host guard will catch duplicates)
  }

  if (existingBgTask) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `A background task is already running: ${existingBgTask.id} — "${existingBgTask.prompt.slice(0, 60)}..."\nCancel it with cancel_task("${existingBgTask.id}") then retry, or wait for it to finish.`,
        },
      ],
      isError: true,
    };
  }
}
```

- [ ] **Step 3: Include `run_mode` in the IPC file payload**

In the `data` object written to the IPC file (around line 135), add `run_mode`:

```ts
const data = {
  type: 'schedule_task',
  taskId,
  prompt: args.prompt,
  schedule_type: args.schedule_type,
  schedule_value: args.schedule_value,
  context_mode: args.context_mode || 'group',
  run_mode: args.run_mode || 'foreground',  // add this line
  targetJid,
  createdBy: groupFolder,
  timestamp: new Date().toISOString(),
};
```

### Sub-task 4b: Update `list_tasks` to show `run_mode` and `last_result`

- [ ] **Step 4: Update the `list_tasks` formatted output**

Find the `formatted` string in `list_tasks` (around line 178). Replace the `.map(...)` lambda:

```ts
const formatted = tasks
  .map(
    (t: {
      id: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      status: string;
      next_run: string | null;
      run_mode?: string;
      last_result?: string | null;
    }) => {
      const lastResult = t.last_result
        ? t.last_result.slice(0, 150)
        : '(none yet)';
      const runMode = t.run_mode ?? 'foreground';
      return `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) — ${runMode}, ${t.status}, last: ${lastResult}, next: ${t.next_run || 'N/A'}`;
    },
  )
  .join('\n');
```

- [ ] **Step 5: Typecheck the container agent-runner**

```bash
cd container/agent-runner && npx tsc --noEmit && cd ../..
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add run_mode to schedule_task MCP tool with background duplicate check"
```

- [ ] **Step 7: Rebuild the container**

```bash
./container/build.sh
```

Expected: build completes successfully. This picks up both the MCP tool changes and any prior container changes.

---

## Task 5: Update Vilicus CLAUDE.md

**Spec:** Section 5 — behavioral instructions for the agent.

**Files:**
- Modify: `groups/whatsapp_main/CLAUDE.md`

No automated tests. Verified manually by sending a coding request to Vilicus after restart.

- [ ] **Step 1: Fix the mount description**

In `groups/whatsapp_main/CLAUDE.md`, find the Mounted Repositories table. Change both entries from `(read-only)` to `(read-write)`:

```markdown
| `/workspace/extra/minas-team-ai` | `C:\git\minas-team-ai` (read-write) |
| `/workspace/extra/vouchercloud` | `C:\git\minas-team-ai\vouchercloud` (read-write) |
```

- [ ] **Step 2: Add the Background Coding Tasks section**

Append this section at the end of `groups/whatsapp_main/CLAUDE.md`:

```markdown
## Background Coding Tasks

All coding work against the minas-team-ai repo must run as background tasks so WhatsApp stays responsive.

### What counts as a coding task

A request is a **coding task** if it involves writing, editing, refactoring, or committing code (e.g. "implement X", "fix bug Y", "add feature Z", "create a PR for…", "update the tests for…"). For compound requests ("explain X and then fix it"), treat the whole request as a coding task if any part involves code changes.

Questions, explanations, and status checks are handled directly — no background task needed.

### Coding task flow

1. Call `list_tasks` to check for an existing background task (`run_mode: background`, `status: active`).
2. **If one is running:** send a single WhatsApp message offering the choice, then exit:
   > "I'm currently working on [brief description]. Should I:
   > *1.* Cancel it and start this new task
   > *2.* Wait until it finishes"
   On the user's next message, act on their choice (cancel via `cancel_task` then schedule, or acknowledge and exit).
3. **If none is running:** call `schedule_task` with:
   - `run_mode: 'background'`
   - `schedule_type: 'once'`
   - `schedule_value`: current local time plus 5 seconds, formatted as `YYYY-MM-DDTHH:MM:SS` with no timezone suffix (e.g. `2026-03-23T14:05:05`)
   - `context_mode: 'isolated'`
   - `prompt`: self-contained — include the full request, relevant file paths, target branch, and the send_message instructions below
4. Parse the task ID from the `schedule_task` response (format: `Task task-xxxxxxxx scheduled: ...`).
5. Send a WhatsApp message: "On it — [one-line summary] (task `task-xxxxxxxx`). I'll update you when it starts and finishes. There may be up to 30 seconds before it begins."
6. Exit.

### Status queries

When asked "what are you working on?", "any updates?", or similar:

1. Call `list_tasks`.
2. Report active background tasks and their `last_result`.
3. If `last_result` shows `(none yet)`, the task is still running — say so: "Still running — I'll message you when it's done."
4. If no background tasks are active, say so.

### Background task prompt template

Every background coding task prompt must begin with:

```
You are working on the minas-team-ai codebase at /workspace/extra/minas-team-ai.

First: call send_message with a one-line summary of exactly what you are about to do.

[the actual coding instructions — include file paths, branch name, and any specific requirements]

When finished: call send_message with a clear summary of what was done, any PRs or branches created.
If you hit a blocking error you cannot resolve, call send_message immediately to explain the problem rather than retrying indefinitely.
```
```

- [ ] **Step 3: Commit**

```bash
git add groups/whatsapp_main/CLAUDE.md
git commit -m "feat: add background coding task workflow to Vilicus CLAUDE.md"
```

---

## Task 6: Manual verification

No automated tests cover end-to-end flow. Verify these scenarios manually after the container is rebuilt and NanoClaw is running.

- [ ] **Scenario 1 — coding request goes background:**
  Send "@Vilicus implement a small test change in vouchercloud". Verify:
  - Vilicus responds quickly with "On it — ... (task `task-xxx`)"
  - A `send_message("Starting: ...")` arrives within 30 seconds
  - WhatsApp accepts a new unrelated message while the task runs
  - A `send_message("Done: ...")` arrives when the task completes

- [ ] **Scenario 2 — second coding request while first is running:**
  While Scenario 1 task is still running, send another coding request. Verify:
  - Vilicus responds with the cancel-or-wait choice
  - Only one background task exists in `list_tasks`

- [ ] **Scenario 3 — status query:**
  While a task is running, send "what are you working on?". Verify:
  - Vilicus calls `list_tasks` and reports the running task
  - Reports "still running — no result yet"

- [ ] **Scenario 4 — cancel and restart:**
  Reply "cancel it and start the new one". Verify:
  - Vilicus cancels the old task and schedules the new one
  - WhatsApp acknowledgment includes the new task ID
