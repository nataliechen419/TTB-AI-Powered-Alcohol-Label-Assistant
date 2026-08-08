// Vercel serverless entry point for every /api/* route. Locally, Vite's dev
// plugin (server/plugin.ts's labelVerificationApi) serves these same routes
// via a middleware hook that only exists in dev mode — a plain `vite build`
// produces a static frontend with no backend at all. This file is what makes
// the built app work once deployed: Vercel maps any request under /api/**
// to this one catch-all function (the [...path] filename is Vercel's
// catch-all dynamic route syntax) and it delegates to the exact same
// handleApiRequest used locally, so the two hosts share one implementation
// instead of drifting apart.
//
// One real behavior difference to be aware of: Vercel Node functions are
// stateless and short-lived, so the in-memory `applications`/job maps in
// server/db.ts and server/batch.ts only persist for as long as a given
// Lambda instance stays warm (commonly minutes between requests, reset on
// cold start or redeploy) — see README's "Known limitations" section. Batch
// jobs specifically are additionally kept alive past the HTTP response via
// waitUntil() in server/batch.ts, since Vercel can otherwise freeze the
// function the instant the response flushes.
// maxDuration is configured in vercel.json (not via an in-file `config`
// export — that convention is specific to Next.js's app/api routes; plain
// /api functions like this one are configured through vercel.json instead).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleApiRequest } from '../server/plugin'

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await handleApiRequest(req, res)
    if (!res.writableEnded) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  } catch (err) {
    if (!res.writableEnded) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }))
    }
  }
}
