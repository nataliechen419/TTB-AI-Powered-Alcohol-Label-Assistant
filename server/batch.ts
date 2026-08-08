import { randomUUID } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { extractLabelFields } from './extract'
import { validateStandalone } from './compare'
import type { Decision, FieldResult } from './db'

export type BatchFileStatus = 'Approved' | 'Needs Review' | 'Flagged' | 'Error'

export interface BatchResult {
  id: string
  name: string
  brand: string
  flagged: number
  status: BatchFileStatus
  error?: string
  fields?: FieldResult[]
  /** How long the extraction call itself took, in ms — mirrors the
   * single-review flow's durationMs so batch results are just as
   * transparent about analysis speed. Absent for Error results. */
  durationMs?: number
  /** Present whenever the extraction ran (absent for Error results) —
   * surfaced so a poor-quality photo can be flagged in the UI the same way
   * it is for a single-application review. */
  imageQuality?: 'clear' | 'poor'
  qualityNote?: string
  /** Set only for Custom Test Mode's single-file check (see
   * createCompletedJob) so its result card can show the photo — omitted for
   * ordinary multi-file batch runs to avoid holding hundreds of images (up
   * to 300 files) in memory at once for a view that never displays them. */
  labelImageDataUrl?: string
  /** A reviewer's approve/reject/flag call on this specific file, set via
   * setResultDecision — same shape as an Application's decision, so a batch
   * or Custom Test result can be judged (and that judgment reviewed later)
   * the same way a queued application can, without needing its own
   * application record. */
  decision?: Decision
}

export interface BatchJob {
  id: string
  total: number
  done: number
  results: BatchResult[]
  finished: boolean
}

const jobs = new Map<string, BatchJob>()

export function getBatchJob(id: string): BatchJob | undefined {
  return jobs.get(id)
}

/** Wraps an already-computed result (Custom Test Mode's single-file check,
 * which is awaited synchronously in the route handler rather than run
 * through runPool) into a 1-file, already-finished job — reusing the same
 * job store as multi-file batches gives Custom Test Mode the same
 * decision-setting and later-retrieval behavior (GET /api/batch/:id) for
 * free, instead of needing a parallel storage mechanism. */
export function createCompletedJob(result: BatchResult): BatchJob {
  const job: BatchJob = { id: randomUUID(), total: 1, done: 1, results: [result], finished: true }
  jobs.set(job.id, job)
  return job
}

/** Records a reviewer's decision on one file within a job — used by both the
 * multi-file batch results list and Custom Test Mode's single result (which,
 * per createCompletedJob above, is just a 1-file job). Returns the updated
 * result, or undefined if the job/result id doesn't exist. */
export function setResultDecision(jobId: string, resultId: string, decision: Decision): BatchResult | undefined {
  const job = jobs.get(jobId)
  if (!job) return undefined
  const result = job.results.find(r => r.id === resultId)
  if (!result) return undefined
  result.decision = decision
  return result
}

const SUPPORTED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** Shared with the Custom Test Mode single-label endpoint in plugin.ts, so a
 * one-off ad hoc check and a batch file get graded by the same rule. */
export function statusFromFields(fields: FieldResult[]): { status: BatchFileStatus; flagged: number } {
  const flagged = fields.filter(f => f.status !== 'match' && f.status !== 'onLabel').length
  // A field that's genuinely missing from the label is graded as seriously as
  // a confirmed wrong value — both are real compliance problems the label
  // itself needs to fix, unlike 'unreadable', which is often just a photo
  // quality issue fixable by re-uploading a clearer image.
  const hasMismatch = fields.some(f => f.status === 'mismatch' || f.status === 'missing')
  const hasUnreadable = fields.some(f => f.status === 'unreadable')

  if (hasMismatch) return { status: 'Flagged', flagged }
  if (hasUnreadable) return { status: 'Needs Review', flagged }
  return { status: 'Approved', flagged }
}

/** Runs `worker` over `items` with at most `concurrency` in flight at once —
 * batches of 200-300 files must not fire that many requests simultaneously. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function runNext(): Promise<void> {
    const i = next++
    if (i >= items.length) return
    await worker(items[i])
    await runNext()
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()))
}

export function startBatchJob(files: { name: string; buffer: Buffer; mimetype: string }[]): BatchJob {
  const job: BatchJob = { id: randomUUID(), total: files.length, done: 0, results: [], finished: false }
  jobs.set(job.id, job)

  // The route handler responds with 202 + jobId immediately and the caller
  // polls GET /api/batch/:id for progress — this work keeps running after
  // that response is sent. That's a given on a long-lived Node process (the
  // local dev server), but on Vercel's serverless runtime the function's
  // execution can be frozen the moment the response flushes unless the
  // platform is explicitly told to keep it alive. waitUntil() does exactly
  // that (and is a documented no-op/safe passthrough outside the Vercel
  // runtime, so this doesn't change local-dev behavior at all).
  const backgroundWork = runPool(files, 6, async file => {
    const resultId = randomUUID()
    try {
      if (!SUPPORTED_IMAGE_MIME.has(file.mimetype)) {
        job.results.push({ id: resultId, name: file.name, brand: '—', flagged: 0, status: 'Error', error: 'Unsupported file type for automated analysis (JPG, PNG, WEBP, and GIF are supported).' })
        return
      }

      const extraction = await extractLabelFields(file.buffer.toString('base64'), file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif')
      const fields = validateStandalone(extraction.data)
      const { status, flagged } = statusFromFields(fields)
      const brand = extraction.data.brandName.trim() && extraction.data.brandName.trim() !== 'UNREADABLE' ? extraction.data.brandName : file.name

      job.results.push({ id: resultId, name: file.name, brand, flagged, status, fields, durationMs: extraction.durationMs, imageQuality: extraction.data.imageQuality, qualityNote: extraction.data.qualityNote })
    } catch (err) {
      job.results.push({ id: resultId, name: file.name, brand: '—', flagged: 0, status: 'Error', error: err instanceof Error ? err.message : 'Analysis failed' })
    } finally {
      job.done++
    }
  }).then(() => {
    job.finished = true
  })

  waitUntil(backgroundWork)

  return job
}
