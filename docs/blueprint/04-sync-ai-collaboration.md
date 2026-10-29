# Calendar Sync, AI Assistant, Collaboration and Automation

Sections 14–16 of the blueprint. Builds on the existing `CalendarAdapter` contract
(`packages/calendar/src/adapter.ts`), the reconcile rules
(`packages/core/src/sync/reconcile.ts`) and the AI action validator
(`packages/core/src/actions`) [F5][F6].

---

## 14. Calendar integration and synchronisation

### 14.1 Provider capability matrix

Facts are cited. Anything marked **verify** must be confirmed against the provider's
current reference docs before implementation. This session could not open those
pages directly ([README §2](README.md#method)).

| Capability | Google Calendar | Microsoft 365 (Graph) | CalDAV (generic) | Nextcloud Calendar | Apple iCloud |
|---|---|---|---|---|---|
| Auth | OAuth 2.0 (offline access → refresh token) [K] | OAuth 2.0 (Entra ID, `offline_access`, `Calendars.ReadWrite`) [K] | HTTP Basic/Digest or app password [C9] | App password (Basic) via CalDAV [K] | **App-specific password**. 2FA is required for third-party access. Up to 25 active app passwords. All are revoked when the Apple ID password changes [C7][C8] |
| Discovery | Calendar list API [K] | `/me/calendars` [K] | `current-user-principal` → `calendar-home-set` (RFC 4791) [C9] | Same, at `/remote.php/dav` [K] | Same, via `caldav.icloud.com` [C8] |
| Incremental sync | `syncToken`. **410 Gone** (`fullSyncRequired`) invalidates the token and requires a full resync. `nextSyncToken` appears only on the last page [C5] | Delta query on `calendarView` / events (`deltaLink`) [K, verify] | `sync-collection` REPORT (RFC 6578) where supported, else `getctag` + ETag comparison [C9] | `sync-collection` supported [K, verify] | `sync-collection` supported (tsdav wraps it for iCloud) [C8] |
| Push | `events.watch` channels with an expiration. They must be re-created before expiry and are a "something changed" signal only [C10, verify expiry limits] | Change-notification subscriptions. **Outlook event subscriptions max 10,080 min (< 7 days)**; renew via PATCH before expiry. Lifecycle notifications (`reauthorizationRequired`, `subscriptionRemoved`, `missed`) [C1][C2][C3] | None standard. Poll | None. Poll (Nextcloud `notify_push` is for Files, not CalDAV [K, verify]) | None. Poll [C8] |
| ETag / precondition | ETag + `If-Match` [K] | `@odata.etag` / `If-Match` [K] | ETag + `If-Match` (RFC 4791) [C9] | Yes | Yes |
| Idempotent create | Client-supplied `id` (constrained charset), or lookup by `iCalUID` via `events.list?iCalUID=` [C6]. Our approach: deterministic iCalUID + lookup | `transactionId` on create [K, verify], plus lookup by an `singleValueExtendedProperties` marker [K, verify] | PUT to `<uid>.ics` with `If-None-Match: *`. A 412 means it already exists, so adopt it [C9] | Same | Same |
| App-private metadata | `extendedProperties.private` (per calendar+event, searchable via `privateExtendedProperty`) [C4] | Open or single-value extended properties [K, verify] | `X-` properties in the VEVENT (`X-FLUID-BLOCK-ID`) [C9]. Servers usually preserve them, but **verify per server** | Preserved [K, verify] | Preserved [K, verify] |
| Free/busy | `freebusy.query` [K] | `getSchedule` [K] | `free-busy-query` REPORT (RFC 4791 §7.10) [C9] | Supported | Limited [K, verify] |
| Recurrence | RRULE on master; instances have distinct ids and share the iCalUID [C6] | `recurrence` pattern object (not RRULE) [K] | RRULE / RDATE / EXDATE / RECURRENCE-ID [C9] | Same | Same |
| Transparency | `transparency: opaque/transparent` [K] | `showAs: free/tentative/busy/oof/workingElsewhere` [K] | `TRANSP` + `STATUS` [C9] | Same | Same |
| Rate limits | Per-project and per-user quotas [K, verify] | Throttling with 429 + `Retry-After` [K] | Server-dependent | Server-dependent | Undocumented. Back off conservatively |
| Read-only calendars | `accessRole` | `canEdit` | `current-user-privilege-set` | Same | Shared/subscribed calendars are read-only |

**Fluid status:** the CalDAV adapter exists and passes the contract suite in a
"no push, no ETags, no delta" shape (per F1). Google has an interface only, and
Microsoft has nothing.

### 14.2 Identity and ownership model **[exists]**

| Concept | Rule |
|---|---|
| `Event.origin = EXTERNAL` | Provider is the authority. Read-only to the engine and AI. A user may edit one deliberately in-app (ETag precondition, 412 → merge prompt) |
| `Event.origin = APP_BLOCK` | Fluid is the authority. Mirrors exactly one `ScheduledBlock` |
| Immutable origin | DB trigger (exists). Prevents the "relabel then edit" loophole |
| Mirror identity | `iCalUID = fluid-<blockId>@fluid.local` (exists). **[new]** Google: also set `extendedProperties.private.fluidBlockId = <blockId>` and `fluidVersion = <block.version>` [C4]. CalDAV: `X-FLUID-BLOCK-ID`, `X-FLUID-VERSION`. Graph: single-value extended property (**verify**) |
| Task ↔ event | `task 1─* scheduled_block 0..1─1 event`. A task never maps to an event directly. Deadlines are **not** written as events (they'd be noise in others' calendars). Optional per-user ICS feed for deadlines (REQ-CAL-NC) |
| Write target | Exactly one calendar per user receives blocks (partial unique index, exists). Must have `canWrite` |

### 14.3 Credential management

- OAuth tokens and app passwords are envelope-encrypted, AAD-bound to (user, purpose) (exists: `packages/crypto/envelope.ts`).
- Access tokens are refreshed ahead of `accessTokenExpiresAt − 5 min` by the worker.
- **Revocation / expiry**: `invalid_grant` (Google), `AADSTS700082`-class errors (Graph, **verify** codes), or a 401 on CalDAV. Then:
  1. Connection → `NEEDS_ATTENTION` with `statusDetail` set to the human-readable reason.
  2. Outbox ops for it are paused (not failed).
  3. The engine keeps planning on the last known busy data and labels it stale (§13.D).
  4. Hybrid/Automatic downgrade to Assisted.
  5. Banner with a [Reconnect] button.
- An iCloud Apple-ID password change revokes all app passwords [C8]. The UI copy for iCloud says so explicitly.
- Scopes are minimal. Google: `calendar.events` plus `calendar.readonly` for the list (**verify** the least-privilege combination). Graph: `Calendars.ReadWrite`, `offline_access`.

### 14.4 Calendar selection and visibility

Per calendar: `isSelected` (counts as busy), `canWrite` (from the provider),
`isWriteTarget` (one), and **[new]** `allDayBlocks` (default false → all-day events are
treated as free, R-06), plus **[new]** `tentativeIsBusy` (default true). Unselected
calendars are not displayed or used, and their events are not stored beyond
metadata. Read-only calendars can never be write targets.

### 14.5 Inbound sync (provider → Fluid)

```text
trigger: push notification (Google/Graph) | poll tick (CalDAV: 2 min while app open, 10 min otherwise;
         Google/Graph safety poll 30 min) | manual refresh
job "pull:<calendarId>" (deduped):
    result = adapter.pull(conn, cal, cal.syncCursor)          // resumable, idempotent
    tx:
        decisions = reconcile(local, result)                   // pure; ABSENCE IS NOT DELETION
        if decisions.massDeletion: trip circuit breaker → connection NEEDS_ATTENTION; abort
        for change in decisions:
            if change.origin == EXTERNAL: upsert event (tombstone on explicit delete)
            if change.origin == APP_BLOCK:
                if equalsLastPushed(change): no-op               // our own echo (version/etag match)
                elif change.timeChanged: block.startsAt/endsAt = remote; block.isPinned = true;
                                         conflict(ACCEPTED_AS_INTENT)  // the user dragged it in Google
                elif change.deleted: block.state = SKIPPED? → see 14.8
        cal.syncCursor = result.cursor                         // same transaction as the batch
    emit event.synced(affectedOwners, changedIntervals)        // may trigger a replan (§13.C)
```

The 410 / invalid-cursor case sets `needsFullResync`. The full snapshot runs under
the circuit breaker, and deletions are inferred only for events *inside the snapshot's
window* (exists).

### 14.6 Outbound sync (Fluid → provider) **[exists: outbox model]**

- Every block change in an applied plan writes a `pending_remote_ops` row in the same transaction: `idempotencyKey = <blockId>:<blockVersion>:<CREATE|UPDATE|DELETE>`, unique.
- The outbox worker processes rows in order per calendar. CREATE runs `adapter.createEvent`, which is idempotent on iCalUID. UPDATE and DELETE send `If-Match: etag`.
- **Coalescing [new]:** before sending, collapse a sequence of pending ops for the same block into its net effect (CREATE + UPDATE → CREATE with final times; CREATE + DELETE → nothing).
- **Retry policy:** exponential backoff with full jitter, base 5 s, cap 15 min, max 12 attempts, then DEAD_LETTER and surface in the sync log. 429 / `Retry-After` honoured. 5xx and network errors retry. 4xx (other than 409/412/429) dead-letter immediately with the provider message.
- **412 Precondition Failed on an APP_BLOCK:** someone edited our block externally since the last pull. Do not overwrite. Pull first, and treat the remote edit as intent (pin) per 14.5.
- **Per-connection circuit breaker:** 5 consecutive failures pause the connection for 10 min (fields exist on the connection).

### 14.7 Board move → schedule update, safely

**A card moving on a board never touches the calendar directly.** It emits
`task.updated`. The replan (§13.C) decides block changes. Only the block changes
produce outbox ops. Consequences:

- A card moved to BACKLOG releases its *unpinned* blocks. DELETE ops are issued only for `APP_BLOCK` events whose `scheduled_block.task_id` is that task. The repository has no function that can delete an `EXTERNAL` event, and a DB trigger rejects it (exists). **Meetings cannot be deleted by this path.**
- A card moved between boards changes nothing in the calendar unless eligibility changes.
- Duplicate prevention: blocks are identified by `(taskId, chunkIndex)` within a plan apply, and updated in place rather than delete+create when the time changes. The mirror event is updated, not replaced, and its iCalUID never changes.

### 14.8 External edits propagating back

| External action on… | Fluid response |
|---|---|
| An `APP_BLOCK` time changed | Accept and pin (intent). Replan others if needed. Activity "Moved in Google Calendar" |
| An `APP_BLOCK` deleted | Treat as *the user removing that session*: block → `REMOVED_EXTERNALLY`, not re-created. Task remaining time unchanged. Next replan (Assisted: proposal) may place a new session. **[new]** If the same task's mirror is deleted externally twice in 7 days, stop auto-placing it and ask ("You keep deleting this from your calendar — unschedule it?") |
| An `APP_BLOCK` title edited | Ignored for the task (the title belongs to the card). The next update overwrites it, logged |
| An `EXTERNAL` event created, moved or deleted | Busy time updated. Triggers a replan if it overlaps sessions or changes today's free time by > 15 min |
| An `EXTERNAL` event deleted while a session was pinned next to it | Nothing moves. Freed time is available to the next replan |
| An event moved across a DST boundary | Stored instants are UTC. Display uses the event's IANA zone (exists). No special handling |

### 14.9 Recurring events

- External recurring events are expanded within the horizon for busy calculation. The master's RRULE is stored **verbatim** and never re-emitted (exists).
- Overrides (`RECURRENCE-ID` / Google instance ids / Graph exceptions) are stored as separate rows linked to the master.
- Fluid never creates recurring *mirror* events. Each session is a single event, which avoids scope-editing hazards (`assertScopeSupported` exists for user edits).

### 14.10 Time zones and DST

- Instants are stored as `timestamptz` plus the authoring IANA zone (exists).
- Working hours and protected time are wall-clock rules expanded per local date (exists).
- All-day events are date-only, compared in the user's zone.
- A user travelling: `users.time_zone` is authoritative. The UI offers "You're in America/New_York — switch?" when the browser zone differs for > 24 h. Switching rebuilds wall-clock rules without moving pinned sessions or external events (they're instants).
- DST gap: a session is never placed across a non-existent local time. In the overlap hour, granularity alignment uses UTC instants, so no duplicate slot is created.

### 14.11 Offline and reconciliation

The server is the source of truth. Client offline ops never write to calendars
directly. They become server mutations on reconnect, then replans, then outbox ops.
If a provider was unreachable for hours, the outbox drains in order, and stale UPDATEs
for blocks since deleted are coalesced away.

### 14.12 Observability

`sync_logs` per pull and push (exists): counts, outcome, duration, cursor age.
Metrics: pull latency, outbox depth per connection, dead letters, 412 rate, circuit
trips, push-channel expiry lead time. Per-user "Sync health" page: last successful
pull per calendar, pending ops, recent errors in plain language, [Retry now].

### 14.13 Subscription lifecycle **[new for Google/Graph]**

- Google channels: store `watchChannelId`, `watchResourceId` and `watchExpiresAt` (fields exist). A renewal job runs hourly and re-creates channels expiring within 24 h (create new, then stop old). Webhooks are validated by channel id and a token digest (exists). The notification body is never trusted; re-pull instead.
- Graph subscriptions: expiry ≤ 10,080 min [C1]. Renew at 75% of lifetime via PATCH. Handle the lifecycle `reauthorizationRequired` (renew), `subscriptionRemoved` (re-create + full pull) and `missed` (full pull) events [C2]. Validate `clientState`.

---

## 15. AI assistant specification

### 15.1 Scope and principle

The assistant translates natural language into **structured, typed operations** that
pass through the same validator, permission checks and plan gate as UI actions. It
never writes to the database or a calendar directly (exists for calendar actions,
F2 §6). It never enforces invariants. Deterministic code does.

### 15.2 LLM vs ordinary code

| Needs an LLM | Ordinary code (never an LLM) |
|---|---|
| Parsing free-form requests into intents + parameters | Search and filtering (`due:overdue` grammar) |
| Breaking a goal or project into tasks with estimates (proposal) | Scheduling, slot finding, capacity, conflict detection |
| Summaries in prose ("summarise my week") over computed facts | Computing the facts in those summaries (counts, minutes, lists) |
| Translating preferences into structured rules | Deadline-risk detection (engine output) |
| Explaining a plan conversationally, from the engine's explanation records | Permission checks, validation, undo, audit |
| Drafting card descriptions or checklists | Recurrence expansion, date parsing (use a deterministic parser such as chrono-node first; the LLM only as fallback) |

### 15.3 Architecture

```
User text ─▶ Intent router (LLM tool-calling, temperature n/a; effort low)
              │ tools = typed operations below; context = retrieved, redacted data
              ▼
         Proposed operations (JSON, schema-validated)
              ▼
         Resolver: opaque refs → real ids (unknown ref ⇒ fail closed)       [exists: opaque refs]
              ▼
         Permission check (actor = the user; RBAC §16)
              ▼
         Validator (packages/core/src/actions): ALLOW / NEEDS_CONFIRMATION / REFUSE   [exists for calendar]
              ▼
         Dry run: apply to an in-memory copy → engine plan → diff
              ▼
         Confirmation UI (if required by verdict or mode) ─▶ Apply (same mutation path as UI)
              ▼
         ai_operation_logs (prompt hash, tools called, ops, verdicts, diff, applied ids, revert handle)
```

### 15.4 Tool catalogue (typed operations)

| Tool | Effect | Default verdict |
|---|---|---|
| `search_tasks(query)` | Read, using the §12.6 grammar | ALLOW (read) |
| `get_schedule(range)` | Read sessions, events and capacity | ALLOW |
| `find_free_time(minutes, range, constraints)` | Engine query, no writes | ALLOW |
| `create_task(fields, board?, column?)` | Create a card | ALLOW (≤ 5 per request; more → NEEDS_CONFIRMATION) |
| `update_task(id, patch)` | Edit fields | ALLOW for priority, estimate, labels. NEEDS_CONFIRMATION for deadline, owner |
| `move_task(id, board, column)` | Move a card | ALLOW |
| `plan_for_day(ids, day)` | Set day commitments | NEEDS_CONFIRMATION (a commitment is the user's decision, F2 §8) |
| `schedule_task(id, minutes?, before?, range?)` | Engine places sessions (proposal) | Mode-gated, as for any plan |
| `replan(scope, constraints)` | Engine replan with constraints such as "don't move fixed" | Mode-gated |
| `defer_tasks(filter, to)` | Bulk move day commitments | NEEDS_CONFIRMATION |
| `create_board_from_outline(name, columns, cards)` | New board | NEEDS_CONFIRMATION (preview) |
| `break_down(taskId \| goal)` | Proposed subtasks | NEEDS_CONFIRMATION |
| `summarise(range, scope)` | Prose over computed stats | ALLOW |
| `delete_*`, `archive_*` | Destructive | NEEDS_CONFIRMATION, always |
| Anything touching EXTERNAL events, other users' calendars, pinned sessions or protected time | — | **REFUSE** (exists) |

### 15.5 Example requests → operations

| Request | Operations | Notes |
|---|---|---|
| "Plan my day around my existing meetings." | `get_schedule(today)` → `search_tasks("planned:today owner:me")` → if empty, `search_tasks("due:<=+3d -status:done")` and propose `plan_for_day` → `replan(today)` | Commitment needs confirmation. Times come from the engine |
| "Move non-urgent work out of tomorrow." | `search_tasks("planned:tomorrow priority:<=medium -due:tomorrow")` → `defer_tasks(…, to: next working day with capacity)` | Shows list + new days before applying |
| "Show me tasks likely to miss their deadlines." | `search_tasks("is:atrisk")` (engine-computed) | No LLM judgement of risk. The LLM only phrases it |
| "Create a project board for this initiative." | `create_board_from_outline` with template columns + proposed cards | Preview, then confirm |
| "Break this project into actionable tasks." | `break_down(projectId)` → cards with estimates (flagged "AI estimate") | Estimates shown beside the coach's estimate |
| "Schedule two hours for this task before Friday." | `update_task(estimate=120 if smaller)` → `schedule_task(id, 120, before=Fri 17:00 local)` | If infeasible, returns the engine's reason and options |
| "Find overdue cards across all boards." | `search_tasks("due:overdue -status:done")` | Pure search |
| "Summarise my progress this week." | Stats query → `summarise` | Numbers from code, prose from the LLM |
| "Reschedule unfinished work without moving my fixed appointments." | `replan(scope=today+horizon, constraints={keepPinned:true})` | Fixed appointments can't move anyway. The assistant says so rather than pretending it honoured a request |
| "Find the next available time for a focus session." | `find_free_time(50, next 7d, {energy: HIGH})` → offer → `schedule_task` on accept | |

### 15.6 Context retrieval and privacy

- Retrieval is via the same query layer, scoped by RBAC, top-N by relevance and recency, and capped by token budget.
- **Redaction (exists):** by default the model sees opaque refs, durations, relative deadlines and locally derived categories. Titles and notes are sent only where the user enabled `shareTaskText` per feature (exists: per-feature consent in `AiSetting`).
- Calendar event text from others is **untrusted input**. It is wrapped and labelled as data, never placed in system instructions. Injection containment is structural: the model can only emit typed operations, and the validator ignores any times it suggests (F2 §3).
- **Provider abstraction (exists):** a registry with Anthropic plus OpenAI-compatible providers, a CLI adapter, and per-user keys. Self-hosters can use a local model (Ollama).
- **Data handling:** log prompt hashes and tool calls, not full prompts, unless the user enables debug logging. Respect the provider's zero-retention options where available (**verify** per provider). The workspace admin can disable AI entirely or restrict providers (P5).

### 15.7 Failure behaviour

| Situation | Behaviour |
|---|---|
| Ambiguous request | Ask one clarifying question with options ("Which 'report'? Quarterly report (Finance) / Report bug (Website)") |
| Infeasible request | Return the engine's explanation and the actionable options. Never fake success |
| Validator REFUSE | Say what was refused and why (refusals are shown, F2 §6) |
| Provider down or timeout | "The assistant is unavailable; here's the equivalent: [Schedule my day]." Deterministic paths unaffected |
| Partial success in a batch | All-or-nothing per confirmation. Show which ops failed validation before anything is applied |

### 15.8 Auditability

`ai_operation_logs`: id, actor, workspace, request hash, model/provider, tools
invoked, proposed ops (JSON), validator verdicts, confirmation (who/when), applied
entity ids, linked `plan_version_id`, revert handle, latency, token counts. Every
applied op also appears in the card's activity with `source=AI`.

---

## 16. Collaboration and automation specification

### 16.1 Workspaces, membership and roles

| Role | Workspace scope |
|---|---|
| **Owner** | Billing (managed), delete workspace, everything an Admin can do |
| **Admin** | Manage members, roles, integrations policy, AI policy, all boards |
| **Member** | Create projects and boards; access boards per board ACL (default: all workspace boards visible) |
| **Guest** | Only boards explicitly shared; cannot see workspace member list beyond those boards |

**Board ACL (Deck-style, D3):** per board, grants of `READ`, `COMMENT`, `EDIT`,
`MANAGE` to a user, a group (P5+) or `workspace-members`. Effective permission = the
explicit user grant if present, else the max over groups (Deck's rule [D2]). Private
boards: visible only to their grants and admins.

**Invitations:** email invite → signed single-use token (exists: opaque token
primitives), 7-day expiry. The invite specifies role and optional board grants.
Accepting creates the membership. Self-hosted instances can disable open signup and
allow invite-only.

### 16.2 Assignment, delegation and team scheduling

- `owner_id` (single, scheduled) plus `task_members` (collaborators, notified, not scheduled) (D8).
- Changing the owner (journey J7):
  - Old owner's future unpinned sessions are deleted.
  - Pinned sessions are flagged to the old owner for keep/release.
  - `planned_for` is cleared.
  - The new owner is notified, and their engine is triggered (their mode applies).
- **Assigning to someone else's calendar is always-ask** for *that* person in Hybrid/Automatic modes, unless they opted in to "accept assignments automatically".
- **Cross-person dependencies:** a dependant's earliest start = the prerequisite owner's planned end (13.B.6). If the prerequisite owner's plan slips, the dependant's owner gets a "waiting on Ana: now Thu" notice (debounced daily).
- **Team workload view (P5):** per member per day, available vs scheduled vs committed, from each member's engine snapshot. Members choose visibility: *full* (titles), *busy-only* (minutes) or *hidden*. Defaults to busy-only. Never a ranking.
- **Handover:** "Hand over all my open cards in project X to Ben" is a bulk owner change, which triggers one replan per affected person.

### 16.3 Comments, mentions, notifications, activity

- Comments: markdown, edit and delete by author (soft delete, "deleted" placeholder), `@mention` resolves to members with access. A mention of someone without access asks "share board?" instead of leaking content.
- **Notification types:** assigned, mentioned, comment on a card you own or follow, deadline approaching (owner, configurable per board like Deck's per-board due notification setting [D4 #2430]), plan proposals, auto-applied plan summaries, sync problems, recovery proposals, automation failures.
- **Channels:** in-app (always), email (digest default), web push (opt-in). Quiet hours are respected (prefs exist). Each type has per-user channel toggles.
- **Activity feed:** board, project and workspace feeds read from `activity_events`, filtered by permissions.

### 16.4 Approval workflows (P5, minimal)

A column can be marked `requires_approval_by` (role or user). Moving a card *out* of
it records an approval activity, and only permitted users may do so. No multi-step
approval engine. If needed, that is expressed as columns.

### 16.5 Rule-based automation **[new, P4]**

**Model (Butler-shaped [T4], scheduler-aware):**

```ts
interface AutomationRule {
  id; workspaceId; boardId | null; name; enabled; createdBy;
  trigger: Trigger;          // what happened
  conditions: Condition[];   // filter grammar §12.6 over the affected card + trigger payload
  actions: Action[];         // ordered; each is a typed operation (same catalogue as §15.4)
  runAs: 'creator' | 'workspace-bot';   // permission principal
  limits: { maxRunsPerHour: number };
}
type Trigger =
  | { kind: 'card.moved'; toColumn?: Id; fromColumn?: Id }
  | { kind: 'card.created' } | { kind: 'card.completed' } | { kind: 'card.assigned' }
  | { kind: 'field.changed'; field: 'deadline' | 'priority' | 'estimate' | 'label' | string }
  | { kind: 'due.approaching'; minutesBefore: number } | { kind: 'card.overdue' }
  | { kind: 'card.blocked' } | { kind: 'card.unblocked' }
  | { kind: 'schedule'; rrule: string }               // calendar command
  | { kind: 'button'; scope: 'card' | 'board' };      // card/board buttons
```

**Examples from the brief, expressed as rules:**

| Rule | Trigger | Conditions | Actions |
|---|---|---|---|
| When a card moves to "Ready", schedule it if capacity permits | `card.moved{toColumn: Ready}` | `owner:any estimate:any` | `schedule_task(card)` (mode-gated: becomes a proposal in Assisted). Capacity check is the engine's job |
| When a deadline changes, recalculate the schedule | `field.changed{deadline}` | — | Built in, not a rule (§13.C triggers) |
| When a task is completed, evaluate its dependants | `card.completed` | — | Built in: dependants re-enter eligibility. A rule may add `notify(owner of dependants)` |
| When overdue, alert the owner and propose a recovery plan | `card.overdue` | `-status:done` | `notify(owner)`, `replan(owner, focus=card)` → proposal |
| When assigned to someone else, recalculate using their availability | `card.assigned` | — | Built in (16.2) |
| When blocked, remove from the active schedule and consider replacement work | `card.blocked` | — | Built in: blocked cards are ineligible, and the replan fills the freed time per mode |

Principle: **anything about scheduling correctness is built in, not a rule**, so it
can't be misconfigured or disabled by accident. Rules add workflow (moves, labels,
assignments, notifications, comments, creating checklist items, scheduling requests).

**Execution:**
1. Domain events go to the `automations` queue. The matching rules are found (indexed by trigger kind and board).
2. Each rule run gets an `automation_runs` row: input event id, rule version, status, actions taken, error.
3. Actions run through the **same mutation path** with `actor = runAs`, so permissions, validator and activity (`source=AUTOMATION, ruleId`) all apply.
4. **Loop protection:**
   - Events caused by automation carry a `causationChain` (rule ids). A rule never fires on an event whose chain already contains it.
   - Maximum chain depth is 3.
   - Each rule is capped at `maxRunsPerHour` (default 100) and each workspace at 1,000 per hour.
   - When a cap is hit, the rule auto-disables with a notification.
5. **Failure handling:** an action failing validation or permission stops that run (earlier actions in the run are kept, with a compensating note). The run is marked failed and the rule owner is notified (deduped daily). Transient errors are retried 3× with backoff.
6. **Dry-run:** "Test rule" evaluates against the last 20 matching events and shows what would have happened, without applying anything.

### 16.6 Templates and recurring workflows

- **Board template:** columns, labels, rules, and optional cards with relative offsets (`deadline = instantiation + 5 working days`). Motion's workflow templates with stage dates [M10] map to column due offsets (P2).
- **Recurring workflow:** a template plus an RRULE, e.g. "every month instantiate the 'Month-end close' board". Implemented as a `schedule` trigger with an `instantiate_template` action.

### 16.7 Webhooks and external integrations

Outbound webhooks are defined in [05-data-and-architecture.md §19](05-data-and-architecture.md#194-outbound-webhooks). Inbound
integrations (e.g. a notetaker or a form) POST to the REST API using an API token
scoped to a board, which creates cards in a chosen column.
