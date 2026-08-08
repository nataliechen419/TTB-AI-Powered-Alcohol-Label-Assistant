import { useEffect, useRef, useState } from 'react'
import type { Screen } from '../App'
import type { Application, FieldResult } from '../../server/db'
import Button, { IconButton } from '../components/Button'

type Decision = 'approve' | 'reject' | 'flag' | null

// Width the image scales from once the reviewer zooms in past 100%. At 100%
// or below, the image instead fills the actual (wide) panel width via CSS
// so it isn't capped at some fixed px well below the panel's real size —
// see the img style below.
const IMAGE_BASE_WIDTH = 560

const DECISION_LABEL: Record<'approve' | 'reject' | 'flag', string> = {
  approve: 'Approved', reject: 'Rejected', flag: 'Flagged for Review',
}

const DECISION_COLOR: Record<'approve' | 'reject' | 'flag', { color: string; bg: string; border: string }> = {
  approve: { color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  reject:  { color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  flag:    { color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
}

const STATUS: Record<FieldResult['status'], { label: string; color: string; bg: string }> = {
  match:       { label: 'Match',          color: '#15803D', bg: '#F0FDF4' },
  variance:    { label: 'Minor variance', color: '#B45309', bg: '#FFFBEB' },
  mismatch:    { label: 'Mismatch',       color: '#DC2626', bg: '#FEF2F2' },
  // Unreadable means a required field couldn't be verified at all — that's
  // a compliance risk worth the same red urgency as a confirmed mismatch,
  // not a neutral "no info" gray. The reviewer still needs to act on it
  // (re-upload) before this application can be approved.
  unreadable:  { label: 'Unreadable',     color: '#DC2626', bg: '#FEF2F2' },
  // Distinct from both 'mismatch' (a value was detected and disagrees) and
  // 'unreadable' (present but illegible) — this field simply isn't printed
  // on the label anywhere. Same red urgency as 'mismatch': a required field
  // that's absent is a real compliance problem the label needs to fix, not
  // just an image quality snag.
  missing:     { label: 'Missing',        color: '#DC2626', bg: '#FEF2F2' },
  onLabel:     { label: 'On label',       color: '#374151', bg: '#F3F4F6' },
}

export default function LabelReview({ id, navigate }: { id: string | null; navigate: (s: Screen, id?: string) => void }) {
  // No silent fallback to a specific seeded application here — every real
  // navigation into this screen (Dashboard row click, Prev/Next) always
  // passes an id. If it's ever missing, that's a real "nothing is
  // selected" state (see the early return below), not a cue to quietly
  // substitute an arbitrary record the reviewer never asked for.
  const appId = id

  const [app, setApp] = useState<Application | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [queue, setQueue] = useState<Application[]>([])

  const [zoom, setZoom] = useState(1)
  const [decision, setDecision] = useState<Decision>(null)
  const [comment, setComment] = useState('')
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const [dragOver, setDragOver] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Nothing to fetch without an id — leave app null and stop "loading"
    // immediately so the render below falls into the explicit "no
    // application selected" state instead of spinning forever.
    if (!appId) { setLoading(false); setApp(null); return }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    fetch(`/api/applications/${encodeURIComponent(appId)}`)
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Failed to load application (${res.status})`)
        return res.json() as Promise<Application>
      })
      .then(data => { if (!cancelled) setApp(data) })
      .catch(err => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load application') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [appId])

  // Reset per-application review state whenever we navigate to a different
  // application (via Prev/Next or the queue) — without this, finishing a
  // decision and moving to the next app would still show the "done" screen
  // for the app you just left.
  useEffect(() => {
    setZoom(1)
    setDecision(null)
    setComment('')
    setDone(false)
    setSubmitting(false)
    setSubmitError(null)
    setUploadError(null)
    setAnalyzing(false)
  }, [appId])

  // Queue order for Prev/Next — fetched once, same ordering as the Dashboard.
  useEffect(() => {
    let cancelled = false
    fetch('/api/applications')
      .then(res => (res.ok ? (res.json() as Promise<Application[]>) : Promise.reject()))
      .then(data => { if (!cancelled) setQueue(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const queueIndex = queue.findIndex(a => a.id === appId)
  const prevApp = queueIndex > 0 ? queue[queueIndex - 1] : null
  const nextApp = queueIndex >= 0 && queueIndex < queue.length - 1 ? queue[queueIndex + 1] : null

  async function analyzeFile(file: File) {
    // These upload/analyze/submit actions are only reachable from buttons
    // rendered after the "no application selected" and "couldn't load"
    // early returns below, so `app` is always loaded by the time a
    // reviewer can trigger them — but guard explicitly rather than
    // asserting, so a future call site that skips those guards fails safe
    // instead of hitting the API with a bad URL.
    if (!app) return
    setAnalyzing(true)
    setUploadError(null)
    try {
      const form = new FormData()
      form.append('image', file)
      const res = await fetch(`/api/applications/${encodeURIComponent(app.id)}/label`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Analysis failed (${res.status})`)
      setApp(data as Application)
      setDecision(null)
      setComment('')
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  /** Runs extraction+comparison against an image that's already loaded on
   * the application (a seeded /labels/*.jpg asset) instead of a fresh
   * upload — this is the "Analyze label" call-to-action for pre-loaded
   * seed images, kept as an explicit click so we never spend a live Claude
   * call without the reviewer asking for it. */
  async function runAnalysis() {
    if (!app) return
    setAnalyzing(true)
    setUploadError(null)
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(app.id)}/analyze`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Analysis failed (${res.status})`)
      setApp(data as Application)
      setDecision(null)
      setComment('')
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  async function submit() {
    if (!decision || !app) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(app.id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: decision, comment }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `Failed to submit decision (${res.status})`)
      setApp(data as Application)
      setDone(true)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit decision')
    } finally {
      setSubmitting(false)
    }
  }

  if (!appId) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
          <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 8 }}>No application selected</div>
          <div style={{ color: '#6B7280', fontSize: 15, marginBottom: 20 }}>Pick an application from the queue to review it.</div>
          <Button variant="primary" onClick={() => navigate('dashboard')}>Back to Queue</Button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', fontSize: 16 }}>
        Loading application…
      </div>
    )
  }

  if (loadError || !app) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 8 }}>Couldn't load this application</div>
          <div style={{ color: '#6B7280', fontSize: 15, marginBottom: 20 }}>{loadError ?? 'Unknown error'}</div>
          <Button variant="primary" onClick={() => navigate('dashboard')}>Back to Queue</Button>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>
            {decision === 'approve' ? '✅' : decision === 'reject' ? '❌' : '🔖'}
          </div>
          <div style={{ fontSize: 21, fontWeight: 600, marginBottom: 8 }}>
            {decision === 'approve' ? 'Approved' : decision === 'reject' ? 'Rejected' : 'Flagged for Review'}
          </div>
          <div style={{ color: '#6B7280', fontSize: 16, marginBottom: 28 }}>
            {decision === 'approve'
              ? 'The applicant has been notified.'
              : 'Your notes have been recorded and the applicant will be contacted.'}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <Button variant="primary" onClick={() => navigate('dashboard')}>Back to Queue</Button>
            {nextApp && (
              <Button variant="ghost" onClick={() => navigate('review', nextApp.id)}>Next Application</Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const fields = app.review?.fields ?? []
  const hasImage = !!app.labelImageDataUrl
  const hasReview = !!app.review
  const needsAnalysis = hasImage && !hasReview
  const isPoorQuality = app.review?.imageQuality === 'poor'

  return (
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(460px, 42%) 1fr', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>

      {/* Left — label image */}
      <div style={{ borderRight: '1px solid #E5E7EB', background: '#F9FAFB', display: 'flex', flexDirection: 'column' }}>
        {/* Controls */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #E5E7EB', background: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, color: '#6B7280', flex: 1 }}>Label Image</span>
          {typeof app.review?.durationMs === 'number' && (
            <span
              title="Time spent on the extraction call itself"
              style={{
                fontSize: 13, fontWeight: 600, color: '#374151', background: '#F3F4F6',
                borderRadius: 20, padding: '3px 10px', display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              ⚡ Analyzed in {(app.review.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {hasReview && (
            <Button
              variant="ghost"
              small
              onClick={runAnalysis}
              disabled={analyzing}
              title="Re-run analysis on the same label image, without uploading a new one"
            >
              ↻ Reanalyze
            </Button>
          )}
          <IconButton onClick={() => setZoom(z => Math.max(0.5, z - 0.25))} disabled={!hasImage}>−</IconButton>
          <span style={{ fontSize: 14, color: '#9CA3AF', minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <IconButton onClick={() => setZoom(z => Math.min(2.5, z + 0.25))} disabled={!hasImage}>+</IconButton>
          <IconButton onClick={() => setZoom(1)} disabled={!hasImage} style={{ width: 'auto', padding: '0 8px', fontSize: 13 }}>Reset</IconButton>
        </div>

        {app.review?.mockMode && (
          <div style={{ padding: '8px 16px', background: '#FFFBEB', borderBottom: '1px solid #FDE68A', fontSize: 14, color: '#92400E' }}>
            Demo mode — this result is simulated locally, not a live Claude analysis.
          </div>
        )}

        {isPoorQuality && (
          <div style={{ padding: '10px 16px', background: '#FFFBEB', borderBottom: '1px solid #FDE68A', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 15 }}>⚠️</span>
            <div style={{ fontSize: 14, color: '#92400E', lineHeight: 1.4 }}>
              <strong>Poor image quality.</strong> {app.review?.qualityNote || 'Some fields could not be read confidently.'}
            </div>
          </div>
        )}

        {/* Image / upload zone */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            display: 'flex',
            // "safe center" keeps the image centered while it fits, but falls
            // back to start alignment once it overflows — with plain
            // "center" here, zooming in made the image spill equally past
            // both edges of the scroll container, and the left-side overflow
            // was never reachable by scrolling (scrollLeft can't go
            // negative). Growing the image's real width (below) rather than
            // using a CSS transform is what makes this fallback trigger correctly.
            alignItems: 'safe center',
            justifyContent: 'safe center',
            padding: 24,
          }}
        >
          {analyzing ? (
            <div style={{ textAlign: 'center', color: '#6B7280' }}>
              <span style={{ display: 'inline-block', width: 24, height: 24, border: '2.5px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite', marginBottom: 12 }} />
              <div style={{ fontSize: 15 }}>Analyzing label…</div>
            </div>
          ) : hasImage ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
              <img
                src={app.labelImageDataUrl}
                alt="Label"
                style={{
                  // At 100% zoom or below, fill the panel's actual width
                  // (up to a generous cap) instead of a small fixed px —
                  // the panel itself is now wide, so the image should read
                  // as filling it. Past 100%, scale up from a fixed base
                  // width so zooming still has a consistent, predictable step.
                  width: zoom > 1 ? `${IMAGE_BASE_WIDTH * zoom}px` : '100%',
                  maxWidth: zoom > 1 ? 'none' : 760,
                  display: 'block',
                  borderRadius: 8,
                  boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
                  transition: 'width 0.15s',
                  flexShrink: 0,
                }}
              />
              {needsAnalysis && (
                <Button variant="primary" onClick={runAnalysis}>Analyze Label</Button>
              )}
            </div>
          ) : (
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault(); setDragOver(false)
                const file = e.dataTransfer.files?.[0]
                if (file) analyzeFile(file)
              }}
              onClick={() => fileInput.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? '#6366F1' : '#D1D5DB'}`,
                borderRadius: 12,
                background: dragOver ? '#EEF2FF' : '#fff',
                padding: '56px 24px',
                textAlign: 'center',
                cursor: 'pointer',
                width: '100%',
                maxWidth: 340,
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={e => { const file = e.target.files?.[0]; if (file) analyzeFile(file) }}
              />
              <div style={{ fontSize: 32, marginBottom: 12 }}>📷</div>
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 5 }}>Upload label image</div>
              <div style={{ fontSize: 14, color: '#9CA3AF' }}>Drop a file or click to browse</div>
            </div>
          )}
        </div>

        {uploadError && (
          <div style={{ padding: '10px 16px', background: '#FEF2F2', borderTop: '1px solid #FECACA', fontSize: 14, color: '#DC2626' }}>
            {uploadError}
          </div>
        )}

        {/* Re-upload */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid #E5E7EB', background: '#fff' }}>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={analyzing}
            style={{ fontSize: 14, color: '#9CA3AF', background: 'none', border: 'none', cursor: analyzing ? 'default' : 'pointer', padding: 0 }}
          >
            {hasImage ? 'Request re-upload / replace image' : ''}
          </button>
        </div>
      </div>

      {/* Right — fields + decision */}
      <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #E5E7EB', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <button onClick={() => navigate('dashboard')} style={{ fontSize: 15, color: '#9CA3AF', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            ← Queue
          </button>
          <div style={{ width: 1, height: 16, background: '#E5E7EB' }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{app.brand}</div>
            <div style={{ fontSize: 14, color: '#9CA3AF' }}>{app.id} · {app.type} · Submitted {app.submitted}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {queueIndex >= 0 && (
              <span style={{ fontSize: 14, color: '#9CA3AF' }}>{queueIndex + 1} of {queue.length}</span>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant="ghost"
                disabled={!prevApp}
                title={prevApp ? `${prevApp.brand} (${prevApp.id})` : 'No previous application'}
                onClick={() => prevApp && navigate('review', prevApp.id)}
              >
                ← Prev
              </Button>
              <Button
                variant="ghost"
                disabled={!nextApp}
                title={nextApp ? `${nextApp.brand} (${nextApp.id})` : 'No next application'}
                onClick={() => nextApp && navigate('review', nextApp.id)}
              >
                Next →
              </Button>
            </div>
          </div>
        </div>

        {/* Decision — kept at the top, right under the header, so it's the
            first thing a reviewer sees and doesn't have to scroll past every
            field to act on. Compact: inline label + buttons + submit all on
            one row, no separate "Your decision" heading block. */}
        <div style={{ borderBottom: '1px solid #E5E7EB', padding: '12px 24px', background: '#fff', flexShrink: 0 }}>
          {app.decision && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              padding: '6px 12px', borderRadius: 7, marginBottom: 10,
              background: DECISION_COLOR[app.decision.action].bg,
              border: `1px solid ${DECISION_COLOR[app.decision.action].border}`,
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: DECISION_COLOR[app.decision.action].color, flexShrink: 0 }}>
                {DECISION_LABEL[app.decision.action]}
              </span>
              <span style={{ fontSize: 12, color: '#9CA3AF', flexShrink: 0 }}>
                {new Date(app.decision.at).toLocaleString()}
              </span>
              {app.decision.comment && (
                <span style={{ fontSize: 13, color: '#374151' }}>— {app.decision.comment}</span>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#374151', flexShrink: 0 }}>Decision</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {([
                ['approve', 'Approve', '#15803D', '#F0FDF4', '#BBF7D0'],
                ['flag',    'Flag for Review', '#B45309', '#FFFBEB', '#FDE68A'],
                ['reject',  'Reject', '#DC2626', '#FEF2F2', '#FECACA'],
              ] as [Decision, string, string, string, string][]).map(([d, label, color, bg, border]) => (
                <button
                  key={d!}
                  onClick={() => setDecision(d)}
                  onMouseEnter={e => { if (decision !== d) e.currentTarget.style.background = '#F9FAFB' }}
                  onMouseLeave={e => { if (decision !== d) e.currentTarget.style.background = '#fff' }}
                  style={{
                    padding: '6px 14px', borderRadius: 7, cursor: 'pointer',
                    fontSize: 14, fontWeight: decision === d ? 600 : 400,
                    border: `1.5px solid ${decision === d ? border : '#E5E7EB'}`,
                    background: decision === d ? bg : '#fff',
                    color: decision === d ? color : '#374151',
                    transition: 'background-color .12s ease, border-color .12s ease',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <Button
              variant="primary"
              small
              onClick={submit}
              disabled={!decision || submitting}
              style={{ marginLeft: 'auto' }}
            >
              {submitting ? 'Submitting…' : 'Submit Decision'}
            </Button>
          </div>

          {(decision === 'reject' || decision === 'flag') && (
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={1}
              placeholder={decision === 'reject' ? 'Reason for rejection (optional)' : 'What needs attention? (optional)'}
              style={{
                width: '100%', padding: '6px 10px', borderRadius: 7,
                border: '1px solid #E5E7EB', fontSize: 14, resize: 'vertical',
                outline: 'none', marginTop: 8, lineHeight: 1.4,
              }}
            />
          )}

          {submitError && (
            <div style={{ marginTop: 8, fontSize: 13, color: '#DC2626' }}>{submitError}</div>
          )}
        </div>

        {/* Fields */}
        <div style={{ flex: 1, padding: '20px 24px' }}>
          {!hasImage ? (
            <div style={{ color: '#9CA3AF', fontSize: 15, textAlign: 'center', padding: '40px 0' }}>
              Upload a label image to compare it against this application.
            </div>
          ) : needsAnalysis && !analyzing ? (
            <div style={{ color: '#9CA3AF', fontSize: 15, textAlign: 'center', padding: '40px 0' }}>
              A label image is already on file for this application. Click "Analyze Label" to compare it against the submitted application data.
            </div>
          ) : analyzing ? (
            <div style={{ color: '#9CA3AF', fontSize: 15, textAlign: 'center', padding: '40px 0' }}>
              Comparing detected fields against the application…
            </div>
          ) : (
            <>
              <p style={{ margin: '0 0 16px', fontSize: 15, color: '#6B7280' }}>
                Review each field. Approve if values match or differences are cosmetic (punctuation, case). Reject if there's a real mismatch.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {fields.map(f => (
                  <FieldRow key={f.key} field={f} onRequestReupload={() => fileInput.current?.click()} onReanalyze={runAnalysis} />
                ))}
              </div>
            </>
          )}
        </div>

      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function FieldRow({ field, onRequestReupload, onReanalyze }: { field: FieldResult; onRequestReupload: () => void; onReanalyze: () => void }) {
  const s = STATUS[field.status]
  const isHighStakes = field.highStakes
  // "highStakes" just marks the Government Warning as a field where TTB
  // requires exact wording — it doesn't mean something is wrong. Only style
  // the card as a red alert when there's an actual problem to act on;
  // otherwise the red made a confirmed match look like a mismatch.
  const isAlert = isHighStakes && field.status !== 'match'

  return (
    <div style={{
      borderRadius: 8,
      border: isAlert ? '1.5px solid #FECACA' : '1px solid #F3F4F6',
      background: isAlert ? '#FFF5F5' : '#fff',
      overflow: 'hidden',
      marginBottom: isAlert ? 2 : 0,
    }}>
      {isHighStakes && (
        <div style={{
          background: isAlert ? '#FEE2E2' : '#F0FDF4',
          padding: '5px 12px', fontSize: 13, fontWeight: 600,
          color: isAlert ? '#991B1B' : '#166534',
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          {isAlert ? '⚠' : '✓'} Government Warning — exact wording and ALL CAPS required by law{isAlert ? '' : ' — verified'}
        </div>
      )}
      <div style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: '#111', flex: 1 }}>{field.label}</span>
          <span style={{
            fontSize: 13, fontWeight: 600, padding: '2px 9px', borderRadius: 20,
            color: s.color, background: s.bg,
          }}>
            {s.label}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ fontSize: 13, color: '#9CA3AF', marginBottom: 3 }}>Application</div>
            <div style={{ fontSize: 15, color: '#374151', lineHeight: 1.4 }}>{field.appValue}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: '#9CA3AF', marginBottom: 3 }}>Detected on label</div>
            <div style={{
              fontSize: 15, lineHeight: 1.4,
              color: s.color,
              fontStyle: field.status === 'unreadable' || field.status === 'missing' ? 'italic' : undefined,
            }}>
              {field.detected}
            </div>
          </div>
        </div>

        {field.note && (
          <div style={{ marginTop: 8, fontSize: 14, color: '#6B7280', background: '#F9FAFB', borderRadius: 6, padding: '5px 8px' }}>
            {field.note}
          </div>
        )}

        {field.status === 'unreadable' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={onReanalyze} style={{ fontSize: 14, color: '#374151', background: '#F3F4F6', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 500 }}>
              ↻ Retry analysis
            </button>
            <button onClick={onRequestReupload} style={{ fontSize: 14, color: '#374151', background: '#F3F4F6', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 500 }}>
              Request re-upload
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

