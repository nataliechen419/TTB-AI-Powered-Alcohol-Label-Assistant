// A minimal in-memory, per-IP, fixed-window rate limiter for the routes that
// spend real Anthropic API credits (label extraction/analysis). Same
// durability caveat as every other in-memory store in this app (server/db.ts,
// server/batch.ts): state lives in one warm serverless instance and resets on
// cold start/redeploy — see README's "Known limitations". That's an accepted
// tradeoff here: the goal is raising the cost of casual/scripted abuse against
// a single instance, not building a distributed rate limiter for a prototype.
import type { IncomingMessage, ServerResponse } from 'node:http'

type Window = { count: number; resetAt: number }

const windows = new Map<string, Window>()

/** Returns true if `key` is still within `max` hits per `windowMs`,
 * incrementing its counter as a side effect. Fixed-window (not sliding), so
 * it's not exact at window boundaries — fine for "stop obvious abuse", not a
 * billing-grade guarantee. */
export function checkRateLimit(key: string, max: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now()
  const existing = windows.get(key)

  if (!existing || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (existing.count >= max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) }
  }

  existing.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

/** Best-effort client identity for rate-limiting purposes only — not an
 * auth mechanism. x-forwarded-for is attacker-controlled (any client can set
 * it), but Vercel's edge overwrites it with the real connecting IP before a
 * function sees it, so it's trustworthy in that deployment; the raw socket
 * address is the fallback for local dev, where there's no proxy in front. */
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (first) return first.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

const ANALYSIS_MAX_REQUESTS = 20
const ANALYSIS_WINDOW_MS = 10 * 60 * 1000

/** Gate for every route that triggers a Claude vision call. Writes a 429 and
 * returns false if the caller should stop; returns true otherwise. */
export function enforceAnalysisRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = getClientIp(req)
  const { allowed, retryAfterSeconds } = checkRateLimit(`analysis:${ip}`, ANALYSIS_MAX_REQUESTS, ANALYSIS_WINDOW_MS)
  if (!allowed) {
    res.statusCode = 429
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Retry-After', String(retryAfterSeconds))
    res.end(JSON.stringify({ error: 'Too many analysis requests from this client. Please wait before trying again.' }))
    return false
  }
  return true
}
