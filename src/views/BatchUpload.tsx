import { useEffect, useRef, useState } from 'react'
import type { Screen } from '../App'
import type { BatchFileStatus, BatchJob, BatchResult } from '../../server/batch'
import type { Decision, FieldResult } from '../../server/db'
import Button from '../components/Button'

type Stage = 'idle' | 'uploading' | 'processing' | 'done'

const DOT: Record<BatchFileStatus, string> = {
  Approved: '#22C55E',
  'Needs Review': '#F59E0B',
  Flagged: '#EF4444',
  Error: '#9CA3AF',
}

const FIELD_STATUS: Record<FieldResult['status'], { label: string; color: string; bg: string }> = {
  match:       { label: 'Match',          color: '#15803D', bg: '#F0FDF4' },
  variance:    { label: 'Minor variance', color: '#B45309', bg: '#FFFBEB' },
  mismatch:    { label: 'Mismatch',       color: '#DC2626', bg: '#FEF2F2' },
  unreadable:  { label: 'Unreadable',     color: '#DC2626', bg: '#FEF2F2' },
  missing:     { label: 'Missing',        color: '#DC2626', bg: '#FEF2F2' },
  onLabel:     { label: 'On label',       color: '#374151', bg: '#F3F4F6' },
}

const DECISION_LABEL: Record<Decision['action'], string> = {
  approve: 'Approved', reject: 'Rejected', flag: 'Flagged for Review',
}

const DECISION_COLOR: Record<Decision['action'], { color: string; bg: string; border: string }> = {
  approve: { color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  reject:  { color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  flag:    { color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
}

const BEVERAGE_TYPES = ['Wine', 'Distilled Spirits', 'Malt Beverage']

/** Merges a decision-updated result (returned by POST
 * /api/batch/:jobId/results/:resultId/decision) back into a job's results
 * array — shared by both the multi-file batch job and the 1-file Custom
 * Test Mode job, since both are just BatchJobs (see server/batch.ts's
 * createCompletedJob). */
function applyResultUpdate(prev: BatchJob | null, updated: BatchResult): BatchJob | null {
  if (!prev) return prev
  return { ...prev, results: prev.results.map(r => (r.id === updated.id ? updated : r)) }
}

/** A batch result tagged with which of the (possibly several, see
 * chunkFilesBySize below) underlying BatchJobs it actually came from — needed
 * so its decision gets posted to the right job id once one logical batch run
 * is spread across multiple server-side jobs. */
type BatchResultWithJob = BatchResult & { jobId: string }
type MergedJob = Omit<BatchJob, 'results'> & { results: BatchResultWithJob[] }

/** Same idea as applyResultUpdate, for the merged multi-job view — preserves
 * each result's jobId tag (the update payload itself doesn't carry one). */
function applyMergedResultUpdate(prev: MergedJob | null, updated: BatchResult): MergedJob | null {
  if (!prev) return prev
  return { ...prev, results: prev.results.map(r => (r.id === updated.id ? { ...r, ...updated } : r)) }
}

/** Vercel's serverless functions hard-cap request bodies at 4.5MB — a
 * platform limit that can't be raised via vercel.json or app config. A batch
 * of even a few uncompressed phone photos in one multipart request blows
 * past that instantly. Splitting staged files into several under-the-cap
 * uploads (each starting its own BatchJob server-side) keeps every request
 * safely inside the limit; run() below polls all the resulting job ids and
 * stitches them back into one progress bar and results list, so this stays
 * invisible in the UI — it still reads as a single batch run. Locally,
 * where there's no such limit, this just means a few small requests instead
 * of one big one — functionally identical either way.
 *
 * A single file larger than maxBytes still ends up alone in its own chunk
 * (nothing to split further) and may itself get rejected by Vercel with a
 * 413 — that's a real, documented limitation (see README), not something
 * client-side chunking alone can fix. */
function chunkFilesBySize(files: File[], maxBytes: number): File[][] {
  const chunks: File[][] = []
  let current: File[] = []
  let currentBytes = 0
  for (const file of files) {
    if (current.length > 0 && currentBytes + file.size > maxBytes) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(file)
    currentBytes += file.size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

const MAX_BATCH_CHUNK_BYTES = 3.5 * 1024 * 1024

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 7 }}>
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 13px', borderRadius: 8,
  border: '1px solid #D1D5DB', fontSize: 15, outline: 'none',
  fontFamily: 'inherit', color: '#111', boxSizing: 'border-box',
}

export default function BatchUpload({ navigate }: { navigate: (s: Screen, id?: string) => void }) {
  const [stage, setStage] = useState<Stage>('idle')
  const [job, setJob] = useState<MergedJob | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [filter, setFilter] = useState<BatchFileStatus | 'All'>('All')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pollRef = useRef<number | null>(null)

  // Files staged for either a single Custom Test check or a multi-file
  // batch run — chosen but not yet submitted.
  const [stagedFiles, setStagedFiles] = useState<File[]>([])

  // Custom Test Mode fields — only brandName is required; everything else
  // is an optional expected value to cross-check the label against.
  const [brandName, setBrandName] = useState('')
  const [beverageType, setBeverageType] = useState('')
  const [showOptional, setShowOptional] = useState(false)
  const [classType, setClassType] = useState('')
  const [abv, setAbv] = useState('')
  const [netContents, setNetContents] = useState('')
  const [bottlerAddress, setBottlerAddress] = useState('')
  const [countryOfOrigin, setCountryOfOrigin] = useState('')

  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [singleJob, setSingleJob] = useState<BatchJob | null>(null)
  const singleResult = singleJob?.results[0] ?? null

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  function stageFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return
    setStagedFiles(list)
    setUploadError(null)
    setCheckError(null)
    setSingleJob(null)
  }

  function resetStaged() {
    setStagedFiles([])
    setSingleJob(null)
    setCheckError(null)
    setBrandName('')
    setBeverageType('')
    setShowOptional(false)
    setClassType('')
    setAbv('')
    setNetContents('')
    setBottlerAddress('')
    setCountryOfOrigin('')
    if (fileInput.current) fileInput.current.value = ''
  }

  async function checkSingleLabel() {
    if (!stagedFiles[0] || !brandName.trim()) return
    setChecking(true)
    setCheckError(null)
    try {
      const form = new FormData()
      form.append('image', stagedFiles[0])
      form.append('brandName', brandName.trim())
      if (beverageType) form.append('beverageType', beverageType)
      if (classType.trim()) form.append('classType', classType.trim())
      if (abv.trim()) form.append('abv', abv.trim())
      if (netContents.trim()) form.append('netContents', netContents.trim())
      if (bottlerAddress.trim()) form.append('bottlerAddress', bottlerAddress.trim())
      if (countryOfOrigin.trim()) form.append('countryOfOrigin', countryOfOrigin.trim())

      const res = await fetch('/api/test-label', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Check failed (${res.status})`)
      setSingleJob(data as BatchJob)
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Check failed')
    } finally {
      setChecking(false)
    }
  }

  async function run(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return

    setStage('uploading')
    setUploadError(null)
    setJob(null)
    setExpandedId(null)
    setStagedFiles([])

    try {
      const chunks = chunkFilesBySize(list, MAX_BATCH_CHUNK_BYTES)
      const uploads = await Promise.all(chunks.map(async chunk => {
        const form = new FormData()
        for (const file of chunk) form.append('files', file)
        const res = await fetch('/api/batch', { method: 'POST', body: form })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error ?? `Upload failed (${res.status})`)
        return { jobId: data.jobId as string, total: data.total as number }
      }))

      const jobIds = uploads.map(u => u.jobId)
      const total = uploads.reduce((n, u) => n + u.total, 0)

      setStage('processing')

      pollRef.current = window.setInterval(async () => {
        try {
          const jobResults = await Promise.all(jobIds.map(async id => {
            const jobRes = await fetch(`/api/batch/${id}`)
            if (!jobRes.ok) throw new Error('Lost connection to batch job')
            return (await jobRes.json()) as BatchJob
          }))
          const merged: MergedJob = {
            id: jobIds[0],
            total,
            done: jobResults.reduce((n, j) => n + j.done, 0),
            results: jobResults.flatMap(j => j.results.map(r => ({ ...r, jobId: j.id }))),
            finished: jobResults.every(j => j.finished),
            mockMode: jobResults.some(j => j.mockMode),
          }
          setJob(merged)
          if (merged.finished) {
            if (pollRef.current) window.clearInterval(pollRef.current)
            setStage('done')
          }
        } catch (err) {
          if (pollRef.current) window.clearInterval(pollRef.current)
          setUploadError(err instanceof Error ? err.message : 'Lost connection to batch job')
          setStage('idle')
        }
      }, 800)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
      setStage('idle')
    }
  }

  const results = job?.results ?? []
  const filtered = results.filter(r => filter === 'All' || r.status === filter)

  if (stage === 'idle') {
    return (
      <div style={{ maxWidth: 760, margin: '48px auto', padding: '0 24px 64px' }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 30, fontWeight: 600 }}>Custom Test Mode</h1>
        <p style={{ margin: '0 0 28px', color: '#6B7280', fontSize: 17, lineHeight: 1.5 }}>
          Check a single label that isn't in the queue yet — upload a photo, optionally enter the expected
          values to cross-check, and run verification. Drop several files at once instead to batch-process a
          whole folder. This is a testing tool; the day-to-day workflow is{' '}
          <a onClick={() => navigate('dashboard')} style={{ color: '#4F46E5', cursor: 'pointer', fontWeight: 500 }}>
            Label Approvals
          </a>.
        </p>

        <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 28 }}>
          <FieldLabel>Label Photo</FieldLabel>
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) stageFiles(e.dataTransfer.files) }}
            onClick={() => fileInput.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? '#6366F1' : '#D1D5DB'}`,
              borderRadius: 10,
              background: dragOver ? '#EEF2FF' : '#F9FAFB',
              padding: stagedFiles.length ? '28px 24px' : '40px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s',
              marginBottom: 24,
            }}
          >
            <input
              ref={fileInput}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files?.length) stageFiles(e.target.files) }}
            />
            {stagedFiles.length === 0 ? (
              <>
                <div style={{ fontSize: 30, marginBottom: 10 }}>⬆️</div>
                <div style={{ fontSize: 16 }}>
                  <strong>Click to choose a photo</strong> or drag it here
                </div>
                <div style={{ fontSize: 14, color: '#9CA3AF', marginTop: 6 }}>
                  PNG, JPEG, or WebP. Phone photos are fine. Drop several files at once to batch-process them.
                </div>
              </>
            ) : stagedFiles.length === 1 ? (
              <div style={{ fontSize: 15, color: '#374151' }}>
                📷 <strong>{stagedFiles[0].name}</strong> selected
                <button
                  onClick={e => { e.stopPropagation(); resetStaged() }}
                  style={{ marginLeft: 10, fontSize: 14, color: '#4F46E5', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  change
                </button>
              </div>
            ) : (
              <div style={{ fontSize: 15, color: '#374151' }}>
                📁 <strong>{stagedFiles.length} files</strong> selected for batch processing
                <button
                  onClick={e => { e.stopPropagation(); resetStaged() }}
                  style={{ marginLeft: 10, fontSize: 14, color: '#4F46E5', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  change
                </button>
              </div>
            )}
          </div>

          {uploadError && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '14px 16px', display: 'flex', gap: 12, marginBottom: 20 }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
              <div style={{ fontSize: 15, color: '#7F1D1D', lineHeight: 1.5 }}>{uploadError}</div>
            </div>
          )}

          {/* Multiple files staged — batch path, no field entry */}
          {stagedFiles.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '14px 16px' }}>
              <span style={{ fontSize: 15, color: '#374151', flex: 1 }}>
                Ready to batch-process <strong>{stagedFiles.length}</strong> files — each is analyzed on its own, with no expected values needed.
              </span>
              <Button variant="primary" onClick={() => run(stagedFiles)}>Start Batch Analysis</Button>
            </div>
          )}

          {/* Exactly one file staged — Custom Test Mode field entry */}
          {stagedFiles.length === 1 && !singleResult && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 18 }}>
                <div>
                  <FieldLabel>Brand Name (required)</FieldLabel>
                  <input
                    value={brandName}
                    onChange={e => setBrandName(e.target.value)}
                    placeholder="e.g. Old Tom Distillery"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <FieldLabel>Beverage Type</FieldLabel>
                  <select value={beverageType} onChange={e => setBeverageType(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="">Auto (detect from label)</option>
                    {BEVERAGE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>

              <button
                onClick={() => setShowOptional(o => !o)}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 14px', borderRadius: 8,
                  border: `1.5px solid ${showOptional ? '#4F46E5' : '#E5E7EB'}`,
                  background: showOptional ? '#EEF2FF' : '#fff',
                  color: '#4F46E5', fontSize: 15, fontWeight: 500, cursor: 'pointer',
                  marginBottom: showOptional ? 14 : 20,
                }}
              >
                {showOptional ? '▾' : '▸'} Add more label details (optional)
              </button>

              {showOptional && (
                <div style={{ marginBottom: 20 }}>
                  <p style={{ margin: '0 0 16px', fontSize: 14, color: '#6B7280' }}>
                    Enter the values from the application and the tool will compare them to the label.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 20 }}>
                    <div>
                      <FieldLabel>Class / Type</FieldLabel>
                      <input value={classType} onChange={e => setClassType(e.target.value)} placeholder="e.g. Kentucky Straight Bourbon Whiskey" style={inputStyle} />
                    </div>
                    <div>
                      <FieldLabel>Alcohol Content</FieldLabel>
                      <input value={abv} onChange={e => setAbv(e.target.value)} placeholder="e.g. 45% (90 Proof)" style={inputStyle} />
                    </div>
                    <div>
                      <FieldLabel>Net Contents</FieldLabel>
                      <input value={netContents} onChange={e => setNetContents(e.target.value)} placeholder="e.g. 750 mL" style={inputStyle} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                    <div>
                      <FieldLabel>Bottler / Producer</FieldLabel>
                      <input value={bottlerAddress} onChange={e => setBottlerAddress(e.target.value)} placeholder="e.g. Old Tom Distillery, Bardstown, KY" style={inputStyle} />
                    </div>
                    <div>
                      <FieldLabel>Country of Origin (imports only)</FieldLabel>
                      <input value={countryOfOrigin} onChange={e => setCountryOfOrigin(e.target.value)} placeholder="e.g. Scotland" style={inputStyle} />
                    </div>
                  </div>
                </div>
              )}

              {checkError && (
                <div style={{ marginBottom: 16, fontSize: 14, color: '#DC2626' }}>{checkError}</div>
              )}

              <Button
                variant="primary"
                disabled={!brandName.trim() || checking}
                onClick={checkSingleLabel}
                style={{ width: '100%', padding: '12px 0', fontSize: 15 }}
              >
                {checking ? 'Checking…' : 'Check this label'}
              </Button>
            </>
          )}

          {/* Single-file result */}
          {singleResult && singleJob && (
            <SingleResultCard
              result={singleResult}
              jobId={singleJob.id}
              onReset={resetStaged}
              onDecision={updated => setSingleJob(prev => applyResultUpdate(prev, updated))}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '36px 32px', width: '100%' }}>
      {job?.mockMode && (
        <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '12px 18px', fontSize: 15, color: '#92400E', marginBottom: 20 }}>
          Demo mode — these results are simulated locally, no live Claude calls were made.
        </div>
      )}

      {/* Progress */}
      <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: '20px 24px', marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: stage !== 'done' ? 12 : 0 }}>
          {stage !== 'done' && (
            <span style={{ width: 18, height: 18, border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
          )}
          {stage === 'done' && <span style={{ fontSize: 18 }}>✅</span>}
          <span style={{ fontWeight: 600, fontSize: 18 }}>
            {stage === 'uploading' && 'Uploading files…'}
            {stage === 'processing' && job && `Processing — ${job.done} of ${job.total} files analyzed`}
            {stage === 'done' && `Done — ${results.length} labels processed`}
          </span>
          {stage === 'done' && (
            <Button
              variant="ghost"
              onClick={() => { setStage('idle'); setJob(null); setExpandedId(null) }}
              style={{ marginLeft: 'auto', fontSize: 15 }}
            >
              Upload another batch
            </Button>
          )}
        </div>
        {stage !== 'done' && job && (
          <div style={{ height: 7, background: '#F3F4F6', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: '#111', borderRadius: 3, width: `${(job.done / job.total) * 100}%`, transition: 'width 0.2s' }} />
          </div>
        )}
      </div>

      {/* Results */}
      {results.length > 0 && (
        <>
          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            {(['All', 'Flagged', 'Needs Review', 'Approved', 'Error'] as const).map(s => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                onMouseEnter={e => { if (filter !== s) e.currentTarget.style.background = '#F9FAFB' }}
                onMouseLeave={e => { if (filter !== s) e.currentTarget.style.background = '#fff' }}
                style={{
                  padding: '6px 14px', borderRadius: 20, border: '1px solid',
                  fontSize: 15, cursor: 'pointer', fontWeight: filter === s ? 600 : 400,
                  borderColor: filter === s ? '#111' : '#E5E7EB',
                  background: filter === s ? '#111' : '#fff',
                  color: filter === s ? '#fff' : '#374151',
                  transition: 'background-color .12s ease, border-color .12s ease',
                }}>
                {s}
                {s !== 'All' && <span style={{ marginLeft: 6, opacity: 0.7 }}>{results.filter(r => r.status === s).length}</span>}
              </button>
            ))}
          </div>

          <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden' }}>
            {filtered.map((r, i) => {
              const canExpand = r.status !== 'Error' && !!r.fields?.length
              const isOpen = expandedId === r.id
              return (
                <div key={r.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                  <div
                    onClick={() => canExpand && setExpandedId(isOpen ? null : r.id)}
                    style={{
                      display: 'grid', gridTemplateColumns: '1fr auto',
                      alignItems: 'center', padding: '16px 24px',
                      cursor: canExpand ? 'pointer' : 'default',
                      opacity: r.status === 'Error' ? 0.6 : 1,
                      background: isOpen ? '#FAFAFA' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => { if (canExpand) e.currentTarget.style.background = '#FAFAFA' }}
                    onMouseLeave={e => { if (canExpand) e.currentTarget.style.background = isOpen ? '#FAFAFA' : 'transparent' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 9, height: 9, borderRadius: '50%', background: DOT[r.status], flexShrink: 0 }} />
                      <div>
                        <div style={{ fontSize: 17, fontWeight: 500, color: '#111' }}>{r.brand !== '—' ? r.brand : r.name}</div>
                        <div style={{ fontSize: 15, color: '#9CA3AF', marginTop: 2 }}>
                          {r.name}
                          {r.status === 'Error' && r.error ? ` · ${r.error}` : ''}
                        </div>
                      </div>
                      {r.flagged > 0 && (
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#EF4444', background: '#FEF2F2', padding: '2px 10px', borderRadius: 20 }}>
                          {r.flagged} flagged
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {typeof r.durationMs === 'number' && (
                        <span style={{ fontSize: 14, color: '#9CA3AF' }}>{(r.durationMs / 1000).toFixed(1)}s</span>
                      )}
                      <span style={{ fontSize: 15, color: '#6B7280' }}>{r.status}</span>
                      {canExpand && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                          style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                      )}
                    </div>
                  </div>

                  {isOpen && r.fields && (
                    <div style={{ padding: '4px 24px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {r.fields.map(f => {
                        const s = FIELD_STATUS[f.status]
                        return (
                          <div key={f.key} style={{ border: '1px solid #F3F4F6', borderRadius: 8, padding: '10px 14px', background: '#FAFAFA' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span style={{ fontSize: 15, fontWeight: 500, color: '#111', flex: 1 }}>{f.label}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, padding: '2px 8px', borderRadius: 20, color: s.color, background: s.bg }}>
                                {s.label}
                              </span>
                            </div>
                            <div style={{ fontSize: 15, color: '#374151', lineHeight: 1.4 }}>{f.detected}</div>
                            {f.note && <div style={{ marginTop: 6, fontSize: 14, color: '#6B7280' }}>{f.note}</div>}
                          </div>
                        )
                      })}
                      {job && (
                        <DecisionPanel
                          jobId={r.jobId}
                          result={r}
                          onDecision={updated => setJob(prev => applyMergedResultUpdate(prev, updated))}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function SingleResultCard({ result, jobId, onReset, onDecision }: {
  result: BatchResult
  jobId: string
  onReset: () => void
  onDecision: (updated: BatchResult) => void
}) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18, paddingTop: 4 }}>
        {result.labelImageDataUrl && (
          <img
            src={result.labelImageDataUrl}
            alt="Label"
            style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #E5E7EB', flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 9, height: 9, borderRadius: '50%', background: DOT[result.status], flexShrink: 0 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: '#111' }}>{result.brand}</span>
          </div>
          <div style={{ fontSize: 14, color: '#9CA3AF', marginTop: 2 }}>
            {result.status}
            {result.flagged > 0 ? ` · ${result.flagged} flagged` : ''}
            {typeof result.durationMs === 'number' ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ''}
          </div>
        </div>
        <Button variant="ghost" onClick={onReset}>Test another label</Button>
      </div>

      {result.imageQuality === 'poor' && (
        <div style={{ padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 14 }}>
          <span style={{ fontSize: 14 }}>⚠️</span>
          <div style={{ fontSize: 14, color: '#92400E', lineHeight: 1.4 }}>
            <strong>Poor image quality.</strong> {result.qualityNote || 'Some fields could not be read confidently.'}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(result.fields ?? []).map(f => {
          const s = FIELD_STATUS[f.status]
          return (
            <div key={f.key} style={{ border: '1px solid #F3F4F6', borderRadius: 8, padding: '10px 14px', background: '#FAFAFA' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 500, color: '#111', flex: 1 }}>{f.label}</span>
                <span style={{ fontSize: 13, fontWeight: 600, padding: '2px 8px', borderRadius: 20, color: s.color, background: s.bg }}>
                  {s.label}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 2 }}>Expected</div>
                  <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.4 }}>{f.appValue}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 2 }}>Detected on label</div>
                  <div style={{ fontSize: 14, color: s.color, lineHeight: 1.4 }}>{f.detected}</div>
                </div>
              </div>
              {f.note && <div style={{ marginTop: 6, fontSize: 14, color: '#6B7280' }}>{f.note}</div>}
            </div>
          )
        })}
      </div>

      <DecisionPanel jobId={jobId} result={result} onDecision={onDecision} />
    </div>
  )
}

/** Approve/Reject/Flag control for one batch or Custom Test result — shared
 * by the multi-file batch results list and Custom Test Mode's single-result
 * card, since both are backed by a BatchResult within a BatchJob (see
 * server/batch.ts). Once a decision is on file, shows it instead of the
 * button row, so it's visible again on later expand/revisit — comments are
 * optional here, matching the single-application review flow. */
function DecisionPanel({ jobId, result, onDecision }: {
  jobId: string
  result: BatchResult
  onDecision: (updated: BatchResult) => void
}) {
  const [action, setAction] = useState<Decision['action'] | null>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (result.decision) {
    const d = result.decision
    const c = DECISION_COLOR[d.action]
    return (
      <div style={{
        marginTop: 14, padding: '10px 14px', borderRadius: 8,
        background: c.bg, border: `1px solid ${c.border}`,
        display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: c.color, flexShrink: 0 }}>{DECISION_LABEL[d.action]}</span>
        <span style={{ fontSize: 13, color: '#9CA3AF', flexShrink: 0 }}>{new Date(d.at).toLocaleString()}</span>
        {d.comment && <span style={{ fontSize: 14, color: '#374151' }}>— {d.comment}</span>}
      </div>
    )
  }

  async function submit() {
    if (!action) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/batch/${encodeURIComponent(jobId)}/results/${encodeURIComponent(result.id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, comment }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Failed to save decision (${res.status})`)
      onDecision(data as BatchResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save decision')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 8, border: '1px solid #E5E7EB', background: '#FAFAFA' }} onClick={e => e.stopPropagation()}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        {([
          ['approve', 'Approve'],
          ['flag', 'Flag for Review'],
          ['reject', 'Reject'],
        ] as [Decision['action'], string][]).map(([a, label]) => {
          const c = DECISION_COLOR[a]
          const selected = action === a
          return (
            <button
              key={a}
              onClick={() => setAction(a)}
              style={{
                padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
                fontSize: 14, fontWeight: selected ? 600 : 400,
                border: `1.5px solid ${selected ? c.border : '#E5E7EB'}`,
                background: selected ? c.bg : '#fff',
                color: selected ? c.color : '#374151',
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      <textarea
        value={comment}
        onChange={e => setComment(e.target.value)}
        rows={2}
        placeholder="Add a note (optional)"
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 8,
          border: '1px solid #E5E7EB', fontSize: 14, resize: 'vertical',
          outline: 'none', marginBottom: 10, lineHeight: 1.5, fontFamily: 'inherit', boxSizing: 'border-box',
        }}
      />

      {error && <div style={{ marginBottom: 10, fontSize: 13, color: '#DC2626' }}>{error}</div>}

      <Button variant="primary" disabled={!action || submitting} onClick={submit}>
        {submitting ? 'Saving…' : 'Submit decision'}
      </Button>
    </div>
  )
}
