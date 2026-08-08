# Alcohol Label Verification

A TTB (Alcohol and Tobacco Tax and Trade Bureau) compliance assistant: upload a
photo of a beverage alcohol label and compare what's actually printed on it —
brand name, class/type, ABV, net contents, bottler address, country of
origin, and the statutory Government Warning — against what the application
says it should be. Claude reads the label as a vision task; deterministic
comparison logic (not the model) decides match/mismatch/variance, so grading
is auditable and repeatable rather than left to free-form model judgment.

Built from the product spec in [`src/imports/pasted_text/compliance-app-spec.md`](src/imports/pasted_text/compliance-app-spec.md).

## Screens

- **Queue** (`Dashboard`) — the list of pending applications waiting on a label check.
- **Label Review** — the single-application view: upload/view a label photo, run the check, see a field-by-field verdict, and record an approve/reject/flag decision.
- **Batch Upload** — two tools in one screen:
  - *Custom Test Mode*: check one ad hoc label against manually-entered expected values, without needing a queued application.
  - *Batch*: drop dozens–hundreds of label photos at once and get a graded result for each, no expected values required (each label is checked against itself: known-format fields like ABV and the Government Warning are validated on their own terms).

## Setup

Requires Node 22.x and pnpm 10.34.3 (pinned in `.mise.toml` / `package.json#packageManager`).

```bash
pnpm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY — required, the app does not run without it
pnpm dev                # starts Vite (frontend + API) on http://localhost:8443
```

Extraction runs on Claude Haiku 4.5 as a vision task, returning a structured
(Zod-validated) read of the label; the comparison/grading logic in
`server/compare.ts` is ordinary application code, not something the model
decides.

Other scripts:

```bash
pnpm build      # production build (Vite) — also what Vercel runs
pnpm preview    # serve the production build locally
pnpm format     # oxfmt
```

## Deployment (Vercel)

```bash
vercel        # link + deploy a preview
vercel --prod # promote to production
```

The app is a static Vite build (`vercel build`'s default framework
detection) plus one serverless function, `api/[...path].ts`, which is a
catch-all that delegates to the same request handler
(`handleApiRequest` in `server/api.ts`) used by the local dev server —
so there's one implementation of every route, not two that can drift apart.
`vercel.json` raises that function's `maxDuration` to 60s (the max on the
Hobby plan) since label extraction is a multi-second Claude vision call.

**`ANTHROPIC_API_KEY` must be set in the Vercel project's Environment
Variables** — the app has no fallback mode and every extraction call fails
without it.

## Approach, tools, and assumptions

- **Extraction vs. grading are deliberately separate.** Claude's only job is
  to read what's on the label (`server/extract.ts`) and return it as
  structured data (Zod schema, so a malformed response fails loudly instead
  of silently). Every match/mismatch/variance verdict is then computed by
  plain comparison code (`server/compare.ts`) — tiered matching that
  tolerates whitespace/punctuation/case differences and near-miss typos
  (Levenshtein-based) before calling something a real mismatch, with the
  Government Warning held to a stricter, closer-to-verbatim check than
  free-text fields like the bottler address, per the product spec.
- **Image quality is surfaced, not hidden.** The extractor reports its own
  confidence (`imageQuality: 'clear' | 'poor'`); a field that's genuinely
  missing from the label is graded as a real compliance problem, while one
  that's just unreadable in a blurry photo is graded as "needs a better
  photo," not treated the same as a confirmed error.
- **Server state is in-memory, by design, for this prototype.** `server/db.ts`
  and `server/batch.ts` keep applications and batch jobs in a `Map`, which
  resets whenever the process restarts. Locally that's just "restart the
  dev server = fresh demo data." On Vercel it's a real limitation worth
  calling out explicitly: each serverless function instance is
  short-lived and stateless between cold starts, so queue/job state
  persists only for as long as an instance happens to stay warm (typically
  minutes). A production version of this app would move that state to
  something durable (Vercel KV/Postgres, etc.) — deliberately out of scope
  here to keep the prototype's surface area matched to the assignment.
- **Batch uploads are chunked client-side to respect Vercel's request-body
  limit.** Vercel serverless functions hard-cap request bodies at 4.5MB —
  a platform limit, not something app config can raise. A handful of
  full-resolution phone photos in one multipart request would blow past
  that instantly, so `BatchUpload.tsx` splits a staged batch into several
  uploads that each stay under the cap, each starting its own job
  server-side; the UI polls and merges them back into one progress bar and
  results list, so this is invisible to the user. A single photo larger
  than the cap on its own isn't fixable by chunking and will still fail —
  a real deployment would add client-side image compression/resizing
  before upload to avoid this entirely (not implemented here).
- **Background batch work survives the serverless response cycle** via
  `waitUntil()` (`@vercel/functions`) — without it, Vercel can freeze a
  function's execution the instant its HTTP response flushes, which would
  silently kill batch processing after the 202 response went out. It's a
  documented no-op outside the Vercel runtime, so local dev is unaffected.
- **Concurrency is capped, not unlimited.** Batch analysis runs 6 files at a
  time (`runPool` in `server/batch.ts`) rather than firing hundreds of
  simultaneous Claude calls at once.
- **Every route that spends Claude API credits is rate-limited per client
  IP** (`server/rateLimit.ts`) — 20 requests per 10 minutes, in-memory,
  returning `429` with `Retry-After` once exceeded. See
  [`SECURITY.md`](SECURITY.md) for the honest limits of this (per-instance,
  not distributed).

## Known limitations

- In-memory state does not survive a Vercel cold start or redeploy (see above).
- A single label photo over ~4.5MB will fail to upload on Vercel (platform
  request-body limit); this is not currently mitigated with client-side
  compression.
- No authentication — this is a prototype for internal review/testing, not
  a multi-tenant production system.

See [`SECURITY.md`](SECURITY.md) for the full threat model — what's
protected, what's explicitly accepted risk for a prototype at this stage,
and why.
