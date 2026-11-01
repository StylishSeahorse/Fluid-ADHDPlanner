# 0003 — Finishing Phase 1: files, tables, templates, live updates, REST

Status: accepted, 1 November 2026. Context: [roadmap Phase 1](../blueprint/06-delivery.md#phase-1--workspace-and-board-platform).
Microsoft 365 / Outlook was dropped from scope at the owner's request.

## What was built

- **Attachments.** Files on cards, stored on disk under `STORAGE_DIR`, with
  image previews in the card and a paperclip count on the card face. They go
  to the trash and come back with their card; purging the trash deletes the
  files.
- **Table view.** Any board as a sortable table (`?view=table&sort=-priority`),
  and every card on every board as one table on the Boards page.
- **Saved views.** A filter plus a layout, saved by name per board or across
  boards. They live in the URL, so a saved view is just a named link.
- **Board templates.** Five built in (Simple, Client project, Content pipeline,
  Life admin, Software sprint). Any board can be saved as a template, with or
  without its open cards as starter cards.
- **Live updates.** A change in one tab — or from the API, the calendar sync
  or another person in the workspace — refreshes every other open tab within
  about half a second.
- **REST API v1** with personal access tokens. See [docs/api.md](../api.md).

## Decisions

1. **Files on local disk, behind one small storage module.** The blueprint
   allowed fs or S3. Self-hosting is the main way this app runs, and a Docker
   volume is the simplest thing that keeps files safe there. Every read and
   write goes through `services/storage.ts` (put, read, remove by key), so an
   S3 backend is one file, not a refactor. Keys are generated, never derived
   from the filename, and every resolved path is checked to stay inside the
   storage root.

2. **Uploads go through a route handler, not a server action.** Server
   actions are capped at 1 MB, on purpose, to keep that attack surface small.
   Raising the cap for every action to allow files would undo that. The upload
   route streams to disk and stops at `MAX_UPLOAD_MB` without buffering the
   file in memory.

3. **Only raster images are shown inline; everything else downloads.** An
   uploaded HTML or SVG file opened in the app's origin would run with the
   user's session. So downloads carry `Content-Disposition: attachment`,
   `nosniff`, and their own sandboxed CSP (`default-src 'none'; sandbox`).
   SVG is not on the inline list, since it can carry script. The app-wide CSP
   in `next.config.ts` is now scoped to skip `/api/attachments/`, because two
   CSP headers do not override each other and Next kept the looser one.

4. **Live updates are "refresh" signals over SSE, not data.** Every page is a
   server component reading through the same tRPC procedures. Pushing data
   would mean a second, client-side model of every page. Instead a write
   publishes "board N changed" on Redis; each open tab's `/api/live` stream
   relays it and the tab calls `router.refresh()`. Next re-renders only what
   changed, and permission checks are re-applied on the refresh. One Redis
   subscriber per server process serves every tab. Refreshes are debounced and
   held while a tab is hidden. If Redis is down the app still works; tabs just
   stop updating each other.

5. **The REST API is a thin skin over the tRPC procedures.** Each route builds
   a caller for the token's owner and calls the same procedure the app uses.
   Ownership checks, validation and side effects (activity log, completion
   moving a card to Done, notifications) are therefore identical. It returns
   its own DTOs, not raw procedure output, so internal refactors do not break
   integrations. tRPC's own HTTP endpoint stays private to the app.

6. **Tokens are bearer-only; cookies are refused on `/api/v1`.** Accepting the
   session cookie would make the API callable from any website the user
   visits. Tokens are stored as SHA-256 digests (256 random bits need no slow
   KDF), have a `fluid_pat_` prefix for secret scanners, and carry `read` or
   `read`+`write`. They can only be made and revoked from a signed-in session;
   no API route touches them.

7. **Rate limiting fails open.** 300 requests a minute per token, counted in
   Redis. If Redis is unreachable requests are allowed: the limit protects
   the database from a runaway script, and locking every integration out
   during a Redis outage would be the worse failure.

## Verified

- Unit: token format and scopes, table sorting, template validation (the
  built-ins included). 455 tests.
- End to end in a browser against the real database: create a board from a
  built-in template; upload an image, a PDF and an HTML file; check
  content types, disposition, CSP and that a signed-out request gets 401;
  delete a card and restore it with its attachments; save a board as a
  template and create a board from it; sort the table; save a filtered view
  and open it again; see a card added in one tab appear in another; make a
  token and confirm it is not shown again.
- The API with curl: every endpoint, validation and JSON errors, 415, 404,
  read-only token refused writes (403), revoked token (401), the rate limit
  (429 after 300).
- Production build.

## Not done

- Row-level security (planned with sharing, Phase 5).
- Uploading attachments through the API; outgoing webhooks.
- Attachment storage on S3 (the seam is there).
- The table on a single board shows the 30 most recent done cards, like the
  board itself; the all-cards table shows the first 200 matches.
