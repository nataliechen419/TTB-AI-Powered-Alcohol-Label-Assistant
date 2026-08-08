import type { Plugin } from 'vite'
import { handleApiRequest } from './api'

/** Adds /api/* label-verification routes as Vite dev-server middleware,
 * following the same configureServer + middlewares.use pattern as the
 * other plugins in this config — only one port is exposed, so the backend
 * lives alongside the frontend dev server rather than as a separate process.
 * Thin wrapper around handleApiRequest (see server/api.ts's doc comment on
 * it) — this is the dev-only host for it; api/[...path].ts at the project
 * root is the other, and deliberately imports handleApiRequest from
 * server/api.ts directly rather than from this file, so the production
 * serverless bundle never pulls in `vite`'s types (or this file) at all. */
export function labelVerificationApi(): Plugin {
  return {
    name: 'label-verification-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          await handleApiRequest(req, res)
          if (!res.writableEnded) next()
        } catch (err) {
          next(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
  }
}
