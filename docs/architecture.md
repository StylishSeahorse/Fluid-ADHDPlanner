# Architecture

The nine decisions that shape this codebase, and why each went the way it did.
Split out of the README so that document can stay about *using* Fluid — nothing
here has been reworded, only moved.

If you are picking this project up, read decisions 2, 3 and 8 first. They are
the ones that will bite you if you assume the obvious implementation.

---

# The nine decisions worth knowing

## 1. Ownership decides who may write an event — not timestamps

Two-way calendar sync usually resolves conflicts with last-write-wins. That is unsafe:
clocks skew across providers, and the loser is destroyed silently. Instead every event
carries an immutable `origin`:

- **`EXTERNAL`** — the provider is authority. We write only on a deliberate user edit,
  with an ETag precondition; a 412 surfaces a merge prompt instead of overwriting.
- **`APP_BLOCK`** — we are authority. If the user drags one of our blocks in Google
  Calendar, that is read as *intent*: we accept the new time and pin the block so the
  scheduler won't move it again.

Every conflict stores **both** versions, so whatever wins, the other is recoverable.

## 2. The scheduler physically cannot touch a real meeting

Three layers enforce one rule, because a bug that deletes someone's meetings ends the
product's usefulness permanently — even after the bug is fixed:

1. `packages/db/src/repositories/events.ts` gives the scheduler no vocabulary for it —
   its only write functions are `*AppBlock`.
2. A runtime origin check, for callers reached through a queue payload the types
   didn't cover.
3. Database triggers (`packages/db/prisma/migrations/*/migration.sql`) that hold even
   if someone bypasses the repository entirely.

Verified, not assumed — see [Verifying the guarantees](../README.md#verifying-the-guarantees)
in the README for the script that proves it.

## 3. The deterministic scheduler is primary; the AI advises

`plan()` in `packages/core/src/scheduler/plan.ts` is the engine. The AI proposes an
*ordering*; `validateScheduleSuggestion` extracts only that, and the scheduler applies
every hard constraint. Deliberately discarded: the model's suggested times.

This single design does three jobs. The app works with AI disabled, unreachable, or
declined by the user. And it contains prompt injection — **anyone who can send you a
meeting invite can put text into the model's input**, so the worst a successful
injection achieves is a bad suggestion the user sees in the diff and rejects.

Constraint priority: protected/hyperfocus time (inviolable) → no overlap with busy →
working hours → dependencies and earliest-start → deadlines (earliest-deadline-first)
→ energy match → chunk sizes and buffers → **minimize churn**.

That last one is last in precedence and does the most for the user. A schedule that
reshuffles wholesale stops working as the external structure someone is relying on to
counter time blindness. The stability pass keeps every block that is still legal and
moves only what genuinely has to.

## 4. The AI sees durations, not diaries

`redactTask` sends opaque refs, durations, relative deadlines, and a locally-derived
category. Titles and notes go only where the user has opted in, per feature. So
"Write the resignation letter" is categorized as `writing` **without the words leaving
the machine**.

Opaque refs also make the system fail closed: a hallucinated or injected `task_999`
resolves to nothing rather than addressing some arbitrary row.

## 5. Auth deviates from the plan — deliberately

The plan specified Auth.js v5. It is still beta, and for credentials-only login its
JWT-session defaults are weaker than DB-backed sessions. `packages/crypto` therefore
provides the primitives for a small, auditable session system: 256-bit opaque tokens,
SHA-256 digests at rest (a database dump can't be replayed as live logins), Argon2id
via `@node-rs/argon2` (prebuilt binaries — no node-gyp on Windows), and `fakeVerify()`
to keep login timing uniform for non-existent accounts.

The login flow, session table and per-page `requireUser()` guard are built on top of
those primitives.


## 6. The AI acts on the calendar, but only through a gate

The AI can create, move, resize and remove work blocks directly — but it never
writes. It proposes `CalendarAction`s, `packages/core/src/actions` rules on each
one, and only `apps/web/src/server/services/calendar-agent.ts` applies the
survivors. There is no path from a model response to a provider adapter that
skips the validator.

Three verdicts, and the distinction between the first two matters:

- **REFUSE** — outside the AI's authority at *any* autonomy level: protected and
  hyperfocus time, events it did not create, blocks the user pinned by hand, and
  anything outside the pass's scope.
- **NEEDS_CONFIRMATION** — a hard boundary: deleting outright, scheduling outside
  working hours, double-booking. **`FULL_AUTO` does not override these.** That is
  the line the setting must not cross, and a test asserts it.
- **ALLOW** — applied according to the user's autonomy level.

Refusal is not a stricter confirmation. Confirmation means "ask the user";
refusal means the action is outside the AI's authority entirely, and offering it
as a prompt would train people to click through the one dialog that should never
appear.

Autonomy is the user's choice — `FULL_AUTO`, `AUTO_WITH_UNDO` (the default), or
`PROPOSE_THEN_CONFIRM` — and a per-pass cap bounds the blast radius so a bad plan
cannot quietly rewrite a month.

Every action, applied or proposed or refused, lands in the `AiAction` log with a
plain-language reason and its own revert. Per-entry, not a stack: undoing one
change from an hour ago must not unwind the four good ones after it. Refusals are
shown too — a guardrail that works silently is indistinguishable from one that
isn't there.


## 7. Any model provider, one adapter

OpenAI, OpenRouter, CometAPI, Gemini, Groq, DeepSeek, Together, Mistral, Ollama and any
self-hosted server all speak the same OpenAI chat-completions format. So this is not nine
adapters — it is one adapter plus a catalog in `packages/ai/src/registry.ts`. Adding a
provider is a registry entry: no migration, no new adapter, no branch in calling code.
Anthropic keeps its own adapter because its wire format genuinely differs.

`AiSetting.providerId` is a string keyed to that catalog rather than an enum, precisely so
a new provider never needs a schema change.

**No model IDs are hardcoded anywhere.** Vendors add and retire models weekly, and a stale
baked-in list is worse than none — it sends people to a model that 404s. Providers exposing
`GET /models` are queried live, and the field stays free text so a model works the day it
ships.

Letting someone type an endpoint URL is also the most dangerous input in the product: on a
cloud host it is a direct line to the instance metadata service.
`packages/ai/src/net/safe-url.ts` is the guard — https-only outside localhost,
private/link-local/metadata ranges refused, DNS resolved and pinned to defeat rebinding,
redirects never followed. 17 tests, including the IPv4-mapped-IPv6 bypass
(`::ffff:169.254.169.254`).

Keys are envelope-encrypted per user and **write-only**: there is no read path back to the
browser, and the settings screen only ever reports whether a key is stored.

## 8. A day is a commitment, and the user makes it — the AI only says when

Motion auto-schedules everything and decides for you. Sunsama makes you choose a
day for each task and leaves the timing to you. Both halves are load-bearing, and
this app runs them together rather than picking one.

`Task.plannedFor` is the seam. It is the line between *this exists* and *I am doing
this*, and it is set by exactly one kind of gesture: a person putting a card on a
day, on the board or in the morning ritual. Nothing infers it, and committing to a
day never edits the estimate, deadline or priority of the thing being committed —
a planning gesture that quietly rewrites its subject is how a board loses trust.

The scheduler then treats that day as a window (`SchedulableTask.committedTo`) and
orders committed work ahead of everything else. It is deliberately a **soft**
constraint, relaxed in a fixed order: the chosen day first, then the deadline.
Energy is relaxed before either, inside `findSlot`.

Refusing to schedule work that overflows its day would be the easy call and the
wrong one — it punishes someone for a plan that was slightly optimistic, which is
the guilt loop the product exists to interrupt. So the work is placed anyway and
the spill is *reported*: `Plan.spilled`, and on the board a card that could not be
honoured shows `→ Mon` instead of a time. Silently relocating it — Motion's
behaviour and its most-cited ADHD complaint — is the one option not on the table.

Three consequences fall out, and each has a test:

- **Day commitment outranks priority.** Priority is the scheduler's opinion; a day
  is the user's decision, and the second wins. It costs little in practice, because
  work committed to Friday can only be placed on Friday anyway.
- **Stability yields to a new commitment.** The churn-minimizing pass normally keeps
  any block that is still legal — which would silently undo every drag, since the
  old block is still perfectly legal. A retained block outside `committedTo` is
  released.
- **Protected time still wins.** A commitment is a preference. Protected and
  hyperfocus time are not, and the ordering in decision 3 is unchanged.

The day columns report load as *blocks actually booked on that day* plus *committed
work with no time yet*. Summing card estimates alone would show a comfortable Friday
with three hours of overflow sitting on it; using only booked minutes would leave the
bar motionless at the exact moment a card is dropped on it and the number is being
consulted.

## 9. Not all time belongs to the same ledger

An `Area` is a context one level above a project — Work, Personal, the band —
and it carries exactly one behavioural flag: `countsTowardCapacity`.

The obvious implementation of "exclude personal work from my work capacity" is
to drop it from the arithmetic. That is wrong, and wrong in the direction that
matters: a dentist appointment at 11am genuinely removes eleven o'clock from the
working day, so excluding it reports free time that does not exist — the exact
failure the capacity meter is built to prevent.

So personal time is treated the way meetings already are. It reduces
`capacityMinutes`; it is *not* counted in `committedMinutes`. The day gets
smaller, and what the day owes stays honest. `computeCapacity` charges each
minute once: personal time already covered by a meeting or a routine is not a
third deduction.

The same split has to hold everywhere the ledger is visible, or the screens
start contradicting each other. Three places had to be brought into line:

- The board's day columns count *booked* minutes plus *committed-but-unplaced*
  estimates — and the unplaced half filters by the same flag, or the bar would
  jump the moment the scheduler ran.
- Daily highlights key their groups on `(project, countsTowardCapacity)` rather
  than project alone. An "Admin" project holding a client invoice *and* a
  dentist appointment must not report the appointment as work delivered.
- The area lives on the **task**, seeded from its project at creation and owned
  by the task thereafter — so re-filing a project later never silently
  reclassifies work that has already been scheduled and counted.

Deleting an area is `SetNull` on both foreign keys. Losing a label must never be
a way to lose the thing it was labelling.

---

# Security controls in place

| Control | Where |
|---|---|
| Envelope encryption, AAD-bound to user + purpose | `packages/crypto/src/envelope.ts` |
| Secrets can't reach the client bundle | ESLint `no-restricted-syntax` + `import 'server-only'` + `scripts/check-bundle-secrets.mjs` |
| Prompt-injection containment | `packages/ai/src/validate.ts` (structural) + `redaction.ts` (defence in depth) |
| Scheduler can't touch external events | Repository + DB triggers |
| Immutable event origin | DB trigger — closes the relabel-then-grab loophole |

The AAD binding is what makes the crypto worth more than plain column encryption: an
attacker with **database write access** cannot transplant one user's Google refresh
token onto another user's row, because the GCM tag check fails.
