# Security & Threat Model

This document describes the app's trust boundaries, what data it handles,
and the threats considered against it — plus what's deliberately out of
scope for a prototype at this stage. It follows a standard
[STRIDE](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)-style
threat model (Spoofing, Tampering, Repudiation, Information Disclosure,
Denial of Service, Elevation of Privilege), scoped to how this specific app
is actually built, rather than a generic checklist.

## System overview

```
Browser (React SPA)
   │  fetch("/api/...")  — same-origin, no auth token
   ▼
Vercel serverless function (api/[...path].ts → server/api.ts)
   │  in-memory Maps: applications, batch jobs (server/db.ts, server/batch.ts)
   │
   ├──▶ Anthropic API (Claude Haiku 4.5) — label image + prompt sent out
   │     for vision extraction, response returned as structured JSON
   │
   └──▶ /public/labels/*.jpg — seed label images bundled with the app
```

There is exactly one trust boundary that matters here: **the browser is
untrusted**. Anything a client sends — file uploads, form fields, decision
comments, path segments — is handled as attacker-controlled input. The
Anthropic API is treated as a trusted third-party processor for the one
piece of data it receives (the label image + a text prompt).

## Assets and data classification

| Asset | Sensitivity | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | High (credential) | Server-side only; never sent to the client. Verified: nothing under `src/` references it, and it isn't `VITE_`-prefixed, so Vite can't accidentally inline it into the client bundle. |
| Uploaded label photos | Low–Medium | Product packaging photos, not personal data — but they do leave the system boundary to Anthropic's API for extraction, which is worth disclosing even though it's the app's core function, not a bug. |
| Application/queue data (brand, ABV, addresses, decisions) | Low | Business data about label submissions, not user PII. Held in-memory only (see Known limitations). |
| Reviewer decisions/comments | Low | Free-text comments are stored and redisplayed verbatim — see XSS note below. |

Nothing in this app currently handles secrets, payment data, or personal
information about the people using it (there's no user accounts at all —
see Elevation of Privilege below).

## Threats considered

### Spoofing / Elevation of Privilege — no authentication
**Everything under `/api/*` is unauthenticated.** Anyone with the deployed
URL can list applications, upload/analyze a label (which spends Claude API
credits), and record approve/reject/flag decisions. There's no session,
role, or reviewer identity — a decision doesn't even know *who* made it,
only *when* and *what*.

- **Accepted for this prototype.** The assignment scope is a working
  demo/reviewer tool, not a multi-tenant production system, and it's
  deployed as a public preview URL for exactly that purpose.
- **What a production version would need:** an actual auth layer (e.g.
  Vercel's own auth integrations, or a simple SSO gate) in front of every
  route, plus attributing each decision to an authenticated reviewer
  instead of an anonymous `comment` string.

### Tampering — input validation
- File uploads are restricted to an explicit image MIME allowlist
  (`image/jpeg|png|webp|gif`) in `server/api.ts`, rejected with `415`
  otherwise — not inferred from filename/extension, which would be
  spoofable.
- Extraction results from Claude are parsed through a Zod schema
  (`server/extract.ts`); a malformed/unexpected response shape fails
  loudly instead of silently propagating bad data into the comparison
  logic.
- `decision.action` is validated against an exact enum
  (`approve | reject | flag`) server-side, not trusted from the client
  beyond that check.
- **Stored image path handling is safe by construction, not just by
  convention:** `loadImageForAnalysis` in `server/api.ts` joins a path onto
  `public/` on disk, which would be a path-traversal risk if it were ever
  fed attacker-controlled input. It isn't reachable that way today —
  `labelImageDataUrl` is only ever set to one of ~10 hardcoded seed paths
  (`server/db.ts`) or a freshly-built `data:` URL from an actual upload
  (`server/api.ts`), never from a raw client-supplied string — but this is
  the kind of invariant that's easy to accidentally break in a future
  change, so it's called out explicitly here rather than left implicit.

### Repudiation
Decisions are timestamped (`decision.at`) but not attributed to an
identity, since there is none yet (see Spoofing above). Anyone with the URL
could, in principle, later dispute "I didn't approve that" — moot for a
prototype with no auth, but the first thing that breaks once real reviewer
accountability matters.

### Information Disclosure
- Error responses return curated messages (`err.message` from known error
  types, or a generic fallback), not raw stack traces — see
  `describeAnthropicError` in `server/api.ts`.
- `.env`/`.env.*` are gitignored (with an explicit carve-out so
  `.env.example`, the *template*, stays tracked) — verified no secret ever
  landed in git history for this repo.
- Standard hardening headers (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, a restrictive
  `Permissions-Policy`) are set in `vercel.json` for every response — cheap
  insurance against clickjacking/MIME-sniffing that costs nothing to add.
- **Stored XSS surface, currently low-risk:** reviewer decision comments
  (`Decision.comment`) are free text, stored server-side and rendered back
  in the React UI. React escapes text content by default (no
  `dangerouslySetInnerHTML` is used anywhere in `src/`, confirmed by
  search), so this isn't currently exploitable — but it's worth stating
  explicitly *why* it's safe rather than leaving it to accident, same as
  the path-traversal note above.

### Denial of Service / cost abuse
This is the most realistic risk for this app in practice:
- **No rate limiting exists.** Any client can call `/api/applications/:id/analyze`
  or `/api/test-label` repeatedly, each call spending real Anthropic API
  credits — this is a cost-DoS risk, not just an availability one.
- Batch upload concurrency is capped (6 files in flight at a time,
  `runPool` in `server/batch.ts`) and multer caps individual file size
  (25MB) and batch file count (300) — these bound *one request's* resource
  use, but nothing stops many requests in sequence.
- Client-side batch chunking (added to work around Vercel's 4.5MB
  request-body limit — see README) is a UX/compatibility fix, not a
  security control, and doesn't change any of the above.
- **Accepted for this prototype**, same reasoning as the auth gap: fixing
  this properly means rate limiting or auth-gating expensive routes (e.g.
  Vercel's Firewall/rate-limit rules, or a simple per-IP token bucket),
  deliberately out of scope here.

## Known limitations (carried over from README, security-relevant subset)
- No authentication on any route.
- No rate limiting — cost-abuse is possible against Claude-calling endpoints.
- State is in-memory only; a redeploy or cold start clears it. Not a
  confidentiality issue (nothing sensitive is stored), but worth noting
  that "delete" isn't a real operation here — data just doesn't persist.

## What was intentionally *not* done
No code changes were made purely to look secure without addressing a real,
reachable issue in this app (e.g., no login system was bolted on, since
there's no user data to protect behind one yet). The two concrete changes
made alongside this document are the security response headers in
`vercel.json` and this write-up itself — both low-risk, additive, and
verified not to break the file-upload/camera-capture flow the app depends on.
