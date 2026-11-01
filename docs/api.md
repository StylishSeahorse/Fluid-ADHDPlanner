# REST API (v1)

A small JSON API for scripts and other tools: read your boards, add and change
cards, move them, tick them off, and plan them into a day. It calls the same
code the app does, so it can do exactly what you can do in the app — no more.

Base URL: `<APP_URL>/api/v1`, for example `https://fluid.example.com/api/v1`.

## Authentication

Make a **personal access token** in **Settings → API tokens**. It is shown once.
Send it with every request:

```
Authorization: Bearer fluid_pat_…
```

- **Scopes.** A token can be *read only* or *read & write*. Without write,
  every `POST`, `PATCH` and `DELETE` answers `403`.
- **Expiry.** 30 days, 90 days (the default), a year, or never.
- **Revoking** a token in Settings stops it at once.
- **Session cookies are not accepted here.** Being signed in to the app in the
  same browser does not authorise an API call. That keeps the API out of reach
  of any web page you happen to visit.

Only a digest of each token is stored, like a password; nobody can read a token
back out of the database. Tokens start with `fluid_pat_` so secret scanners
recognise a leaked one.

## Limits

300 requests a minute per token. Every response carries `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset` (seconds). Over the limit you get
`429` with `Retry-After`.

## Errors

Errors are [problem documents](https://www.rfc-editor.org/rfc/rfc9457)
(`Content-Type: application/problem+json`):

```json
{
  "type": "about:blank",
  "title": "Bad request",
  "status": 400,
  "detail": "The request body is not valid.",
  "errors": [{ "path": ["title"], "message": "String must contain at least 1 character(s)" }]
}
```

| Status | Means |
|---|---|
| 400 | The body is not valid JSON, or fails validation. `errors` says which field. Unknown fields are rejected, so a typo does not silently do nothing |
| 401 | No token, or it is unknown, revoked or expired |
| 403 | The token lacks the scope this needs |
| 404 | No such board or card — or it is not yours |
| 409 | The change conflicts with the board's state (for example a WIP limit) |
| 415 | A body was sent that is not `application/json` |
| 429 | Too many requests |

## Dates

- Instants (`completedAt`, `createdAt`, …) are ISO 8601 in UTC.
- Days you send (`deadline`, `day`) are `YYYY-MM-DD` in **your** time zone, as
  set in Settings.
- `deadline: "2026-11-06"` means "due by the end of Friday", and is stored and
  returned as the instant that day ends — `2026-11-07T00:00:00Z` if your zone
  is UTC. This is the same rule the app uses everywhere.

## Endpoints

| Method | Path | Scope | Does |
|---|---|---|---|
| `GET` | `/me` | read | Who the token acts as |
| `GET` | `/boards` | read | Every board, with its columns |
| `GET` | `/boards/:id?q=` | read | One board, its columns and their cards. `q` filters |
| `GET` | `/cards?q=&limit=` | read | Cards from every board. No `q` means every open card. `limit` 1–500, default 200 |
| `POST` | `/cards` | write | Add a card to a column → `201` with the card |
| `GET` | `/cards/:id` | read | One card in full |
| `PATCH` | `/cards/:id` | write | Change title, notes, priority, estimate or deadline |
| `DELETE` | `/cards/:id` | write | Move to the board's *Recently deleted* (restorable for 30 days) → `204` |
| `POST` | `/cards/:id/move` | write | Move to a column, optionally next to a card |
| `POST` | `/cards/:id/complete` | write | Mark done (moves it to the board's Done column) |
| `POST` | `/cards/:id/uncomplete` | write | Put a finished card back |
| `POST` | `/cards/:id/comments` | write | Add a comment → `201` |
| `POST` | `/cards/:id/checklist` | write | Add a checklist item → `201` |
| `POST` | `/cards/:id/plan` | write | Plan for a day, or `null` to unplan |

Every write that changes a card answers with the card as `GET /cards/:id`
returns it, so you never need a second request. Open tabs of the app refresh
on their own after an API write.

### The search grammar

`q` takes the same filters as every search box in the app:

```
label:client  due:week  due:overdue  -status:done  status:done
planned:today  planned:none  priority:>=high  "exact words"
```

### Bodies

**Create a card** — `columnId` and `title` are required; the rest are optional.

```json
{ "columnId": "…", "title": "Send the invoice", "priority": "HIGH",
  "estimateMinutes": 30, "deadline": "2026-11-06", "notes": "Net 30" }
```

**Change a card** — any subset:

```json
{ "title": "…", "notes": "… or null", "priority": "LOW|MEDIUM|HIGH|URGENT",
  "estimateMinutes": 45, "deadline": "2026-11-06 or null" }
```

**Move** — `afterId` puts it directly below that card, `beforeId` directly
above. Leave both out to put it at the bottom. The column may be on another
board.

```json
{ "columnId": "…", "afterId": "…" }
```

**Plan:** `{ "day": "2026-11-03" }` or `{ "day": null }`.
**Comment:** `{ "body": "…" }`. **Checklist item:** `{ "text": "…" }`.

### Card shapes

In lists (`/cards`, `/boards/:id`):

```json
{
  "id": "…", "title": "Kick-off call", "status": "READY", "priority": "MEDIUM",
  "estimateMinutes": 60, "deadline": null, "plannedFor": null, "completedAt": null,
  "boardId": "…", "columnId": "…", "boardName": "Acme", "columnName": "To do",
  "labels": [{ "id": "…", "name": "client", "color": "sky" }],
  "checklist": { "done": 1, "total": 4 },
  "commentCount": 0, "attachmentCount": 2, "subtaskCount": 0, "blocked": false
}
```

`boardName` and `columnName` appear in `/cards` results. In full (`/cards/:id`
and every write) the card also has `notes`, `createdAt`, `updatedAt`, `board`,
`column`, `project`, the `checklist` items, `comments`, `attachments` (each with
a `url` you can fetch while signed in to the app), `subtasks` and `blockedBy`.

## Examples

```bash
TOKEN=fluid_pat_…
API=https://fluid.example.com/api/v1

# Which columns does each board have?
curl -s -H "Authorization: Bearer $TOKEN" $API/boards

# Everything due this week, across every board
curl -s -H "Authorization: Bearer $TOKEN" "$API/cards?q=due:week"

# Add a card and plan it for tomorrow
CARD=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"columnId":"<column id>","title":"Renew the domain","estimateMinutes":15}' \
  $API/cards | jq -r .id)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"day":"2026-11-02"}' $API/cards/$CARD/plan

# Tick it off
curl -s -X POST -H "Authorization: Bearer $TOKEN" $API/cards/$CARD/complete
```

## Not in v1

Columns, labels and boards are read only here: change them in the app.
Attachments cannot be uploaded through the API yet. Webhooks (Fluid calling
*you* when something changes) are not built.
