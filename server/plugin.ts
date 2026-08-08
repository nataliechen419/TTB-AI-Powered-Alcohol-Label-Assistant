import type { Plugin, Connect } from 'vite'
import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import multer from 'multer'
import { applications, getApplication, listApplications } from './db'
import { extractLabelFields } from './extract'
import { compareToApplication, compareFlexible } from './compare'
import { getBatchJob, startBatchJob, statusFromFields, createCompletedJob, setResultDecision } from './batch'
import { isMockMode } from './mock'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

function readJsonBody(req: Connect.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// multer's types target Express's Request/Response, but at runtime it only
// needs the plain Node IncomingMessage/ServerResponse that Connect already
// provides — Express's req/res are themselves built on top of these.
type LooseHandler = (req: unknown, res: unknown, cb: (err?: unknown) => void) => void

function runMulter(mw: LooseHandler, req: Connect.IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    mw(req, res, (err?: unknown) => (err ? reject(err) : resolve()))
  })
}

function describeAnthropicError(err: unknown): { status: number; message: string } {
  if (err instanceof Anthropic.RateLimitError) return { status: 429, message: 'The analysis service is rate limited right now. Please try again shortly.' }
  if (err instanceof Anthropic.AuthenticationError) return { status: 500, message: 'The analysis service is not configured correctly.' }
  if (err instanceof Anthropic.APIError) return { status: 502, message: `Analysis service error: ${err.message}` }
  return { status: 500, message: err instanceof Error ? err.message : 'Unexpected error during analysis.' }
}

const SUPPORTED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const EXT_MIME: Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
}

/** Seed applications ship with a pre-loaded label image referenced as a
 * plain static path (e.g. "/labels/barefoot-cellars.jpg", served from
 * /public by Vite) rather than the base64 data: URL that a live upload
 * produces — keeps db.ts free of giant embedded strings. This resolves
 * either form to the {base64, mediaType} pair extraction needs. */
async function loadImageForAnalysis(labelImageDataUrl: string): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }> {
  const dataUrlMatch = labelImageDataUrl.match(/^data:([^;]+);base64,(.*)$/s)
  if (dataUrlMatch) {
    const mediaType = dataUrlMatch[1]
    if (!SUPPORTED_IMAGE_MIME.has(mediaType)) throw new Error(`Unsupported stored image type: ${mediaType}`)
    return { base64: dataUrlMatch[2], mediaType: mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }
  }

  const ext = nodePath.extname(labelImageDataUrl).toLowerCase()
  const mediaType = EXT_MIME[ext]
  if (!mediaType) throw new Error(`Unsupported stored image type: ${labelImageDataUrl}`)

  const diskPath = nodePath.join(process.cwd(), 'public', labelImageDataUrl)
  const buffer = await readFile(diskPath)
  return { base64: buffer.toString('base64'), mediaType }
}

/** Handles a single /api/* request end-to-end: matches the path+method
 * against every route below and writes a response if one matches. Shared
 * verbatim between two hosts so the API behaves identically in both:
 *  - locally, labelVerificationApi() below wires this in as Vite dev-server
 *    middleware (see that function's doc comment for why);
 *  - deployed, api/[...path].ts at the project root wires this in as a
 *    Vercel serverless function, since a `vite build` alone ships only the
 *    static frontend — the Vite plugin API below never runs outside `vite
 *    dev`/`vite serve`.
 * Callers distinguish "a route matched and a response was written" from
 * "nothing matched" by checking `res.writableEnded` after this resolves,
 * rather than this function returning a sentinel — that keeps every
 * individual route's early-return (`return sendJson(...)`) exactly as
 * readable as it was before this was split out of a single inline handler. */
export async function handleApiRequest(req: Connect.IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname
    const method = req.method || 'GET'

    if (path === '/api/status' && method === 'GET') {
      return sendJson(res, 200, { mockMode: isMockMode() })
    }

    if (path === '/api/applications' && method === 'GET') {
      const apps = listApplications().map(({ labelImageDataUrl: _labelImageDataUrl, ...rest }) => rest)
      return sendJson(res, 200, apps)
    }

    const singleMatch = path.match(/^\/api\/applications\/([^/]+)$/)
    if (singleMatch && method === 'GET') {
      const app = getApplication(decodeURIComponent(singleMatch[1]))
      if (!app) return sendJson(res, 404, { error: 'Application not found' })
      return sendJson(res, 200, app)
    }

    const labelMatch = path.match(/^\/api\/applications\/([^/]+)\/label$/)
    if (labelMatch && method === 'POST') {
      const app = getApplication(decodeURIComponent(labelMatch[1]))
      if (!app) return sendJson(res, 404, { error: 'Application not found' })

      await runMulter(upload.single('image') as unknown as LooseHandler, req, res)
      const file = (req as Connect.IncomingMessage & { file?: Express.Multer.File }).file
      if (!file) return sendJson(res, 400, { error: 'No image file was uploaded (expected field "image").' })

      if (!SUPPORTED_IMAGE_MIME.has(file.mimetype)) {
        return sendJson(res, 415, { error: 'Unsupported file type. Please upload a JPG, PNG, WEBP, or GIF image.' })
      }

      const mediaType = file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
      const base64 = file.buffer.toString('base64')

      let extraction
      try {
        extraction = await extractLabelFields(base64, mediaType, { applicationData: app.applicationData })
      } catch (err) {
        const { status, message } = describeAnthropicError(err)
        return sendJson(res, status, { error: message })
      }

      const fields = compareToApplication(app.applicationData, extraction.data)
      app.labelImageDataUrl = `data:${mediaType};base64,${base64}`
      app.review = {
        fields,
        imageQuality: extraction.data.imageQuality,
        qualityNote: extraction.data.qualityNote,
        reviewedAt: new Date().toISOString(),
        mockMode: extraction.mockMode,
        durationMs: extraction.durationMs,
      }
      app.flagged = fields.filter(f => f.status === 'mismatch' || f.status === 'missing' || f.status === 'unreadable').length
      applications.set(app.id, app)

      return sendJson(res, 200, app)
    }

    const analyzeMatch = path.match(/^\/api\/applications\/([^/]+)\/analyze$/)
    if (analyzeMatch && method === 'POST') {
      const app = getApplication(decodeURIComponent(analyzeMatch[1]))
      if (!app) return sendJson(res, 404, { error: 'Application not found' })
      if (!app.labelImageDataUrl) return sendJson(res, 400, { error: 'No label image is available to analyze. Upload one first.' })

      let base64: string
      let mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
      try {
        ({ base64, mediaType } = await loadImageForAnalysis(app.labelImageDataUrl))
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : 'Could not load the stored label image.' })
      }

      let extraction
      try {
        extraction = await extractLabelFields(base64, mediaType, { applicationData: app.applicationData })
      } catch (err) {
        const { status, message } = describeAnthropicError(err)
        return sendJson(res, status, { error: message })
      }

      const fields = compareToApplication(app.applicationData, extraction.data)
      app.review = {
        fields,
        imageQuality: extraction.data.imageQuality,
        qualityNote: extraction.data.qualityNote,
        reviewedAt: new Date().toISOString(),
        mockMode: extraction.mockMode,
        durationMs: extraction.durationMs,
      }
      app.flagged = fields.filter(f => f.status === 'mismatch' || f.status === 'missing' || f.status === 'unreadable').length
      applications.set(app.id, app)

      return sendJson(res, 200, app)
    }

    const decisionMatch = path.match(/^\/api\/applications\/([^/]+)\/decision$/)
    if (decisionMatch && method === 'POST') {
      const app = getApplication(decodeURIComponent(decisionMatch[1]))
      if (!app) return sendJson(res, 404, { error: 'Application not found' })

      const body = await readJsonBody(req)
      const action = body.action
      const comment = typeof body.comment === 'string' ? body.comment : ''

      if (action !== 'approve' && action !== 'reject' && action !== 'flag') {
        return sendJson(res, 400, { error: 'action must be one of approve, reject, flag' })
      }

      app.decision = { action, comment, at: new Date().toISOString() }
      app.status = action === 'approve' ? 'Approved' : action === 'reject' ? 'Flagged' : 'Needs Review'
      applications.set(app.id, app)

      return sendJson(res, 200, app)
    }

    if (path === '/api/test-label' && method === 'POST') {
      await runMulter(upload.single('image') as unknown as LooseHandler, req, res)
      const file = (req as Connect.IncomingMessage & { file?: Express.Multer.File }).file
      const body = (req as Connect.IncomingMessage & { body?: Record<string, string> }).body ?? {}

      const brandName = (body.brandName ?? '').trim()
      if (!brandName) return sendJson(res, 400, { error: 'Brand name is required.' })
      if (!file) return sendJson(res, 400, { error: 'No image file was uploaded (expected field "image").' })
      if (!SUPPORTED_IMAGE_MIME.has(file.mimetype)) {
        return sendJson(res, 415, { error: 'Unsupported file type. Please upload a JPG, PNG, WEBP, or GIF image.' })
      }

      const mediaType = file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
      const base64 = file.buffer.toString('base64')

      let extraction
      try {
        extraction = await extractLabelFields(base64, mediaType, { fileName: file.originalname })
      } catch (err) {
        const { status, message } = describeAnthropicError(err)
        return sendJson(res, status, { error: message })
      }

      const fields = compareFlexible(
        {
          brandName,
          beverageType: body.beverageType,
          classType: body.classType,
          abv: body.abv,
          netContents: body.netContents,
          bottlerAddress: body.bottlerAddress,
          countryOfOrigin: body.countryOfOrigin,
        },
        extraction.data,
      )
      const { status, flagged } = statusFromFields(fields)

      const job = createCompletedJob({
        id: randomUUID(),
        name: file.originalname,
        brand: brandName,
        flagged,
        status,
        fields,
        durationMs: extraction.durationMs,
        imageQuality: extraction.data.imageQuality,
        qualityNote: extraction.data.qualityNote,
        labelImageDataUrl: `data:${mediaType};base64,${base64}`,
      }, extraction.mockMode)

      return sendJson(res, 200, job)
    }

    if (path === '/api/batch' && method === 'POST') {
      await runMulter(upload.array('files', 300) as unknown as LooseHandler, req, res)
      const files = (req as Connect.IncomingMessage & { files?: Express.Multer.File[] }).files ?? []
      if (files.length === 0) return sendJson(res, 400, { error: 'No files were uploaded (expected field "files").' })

      const job = startBatchJob(files.map(f => ({ name: f.originalname, buffer: f.buffer, mimetype: f.mimetype })))
      return sendJson(res, 202, { jobId: job.id, total: job.total })
    }

    const batchStatusMatch = path.match(/^\/api\/batch\/([^/]+)$/)
    if (batchStatusMatch && method === 'GET') {
      const job = getBatchJob(batchStatusMatch[1])
      if (!job) return sendJson(res, 404, { error: 'Batch job not found' })
      return sendJson(res, 200, job)
    }

    const batchDecisionMatch = path.match(/^\/api\/batch\/([^/]+)\/results\/([^/]+)\/decision$/)
    if (batchDecisionMatch && method === 'POST') {
      const [, jobId, resultId] = batchDecisionMatch
      const body = await readJsonBody(req)
      const action = body.action
      const comment = typeof body.comment === 'string' ? body.comment : ''

      if (action !== 'approve' && action !== 'reject' && action !== 'flag') {
        return sendJson(res, 400, { error: 'action must be one of approve, reject, flag' })
      }

      const result = setResultDecision(decodeURIComponent(jobId), decodeURIComponent(resultId), { action, comment, at: new Date().toISOString() })
      if (!result) return sendJson(res, 404, { error: 'Batch result not found' })
      return sendJson(res, 200, result)
    }

    // Nothing matched — leave the response unwritten. Callers check
    // res.writableEnded to tell "no route matched" apart from "a route
    // matched and already responded" (see this function's doc comment).
  } catch (err) {
    if (err instanceof multer.MulterError) {
      return sendJson(res, 400, { error: err.message })
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
}

/** Adds /api/* label-verification routes as Vite dev-server middleware,
 * following the same configureServer + middlewares.use pattern as the
 * other plugins in this config — only one port is exposed, so the backend
 * lives alongside the frontend dev server rather than as a separate process.
 * Thin wrapper around handleApiRequest (see its doc comment) — this is the
 * dev-only host for it; api/[...path].ts at the project root is the other. */
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
