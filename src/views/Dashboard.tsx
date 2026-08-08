import { useEffect, useState, type CSSProperties } from 'react'
import type { Screen } from '../App'
import type { Application, AppStatus } from '../../server/db'

type Status = AppStatus

const DOT: Record<Status, string> = {
  Pending:        '#9CA3AF',
  'Needs Review': '#F59E0B',
  Approved:       '#22C55E',
  Flagged:        '#EF4444',
}

// Same palette family used for status pills in LabelReview.tsx, so a status
// reads the same color wherever a reviewer sees it in the app.
const STATUS_COLOR: Record<Status, { color: string; bg: string; border: string }> = {
  Pending:        { color: '#4B5563', bg: '#F3F4F6', border: '#E5E7EB' },
  'Needs Review': { color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  Approved:       { color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  Flagged:        { color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
}

const ALL_COLOR = { color: '#fff', bg: '#111', border: '#111' }

// Shared column template between the header row and every data row, so
// they always line up exactly.
const ROW_COLUMNS = '40px minmax(170px, 1.7fr) minmax(190px, 1.4fr) 110px 150px 18px'

export default function Dashboard({ navigate }: { navigate: (s: Screen, id?: string) => void }) {
  const [filter, setFilter] = useState<Status | 'All'>('All')
  const [apps, setApps] = useState<Application[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/applications')
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Failed to load queue (${res.status})`)
        return res.json() as Promise<Application[]>
      })
      .then(data => { if (!cancelled) setApps(data) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load queue') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filtered = apps.filter(a => filter === 'All' || a.status === filter)

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '40px 32px', width: '100%' }}>

      {/* Page title + upload */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 600 }}>Application Queue</h1>
          <p style={{ margin: '6px 0 0', color: '#6B7280', fontSize: 16 }}>
            {apps.length} applications · {apps.filter(a => a.status === 'Flagged' || a.status === 'Needs Review').length} need attention
          </p>
        </div>
        <button
          onClick={() => navigate('batch')}
          onMouseEnter={e => (e.currentTarget.style.background = '#2A2A2A')}
          onMouseLeave={e => (e.currentTarget.style.background = '#111')}
          style={{
            marginLeft: 'auto',
            background: '#111', color: '#fff', border: 'none',
            borderRadius: 8, padding: '11px 22px', cursor: 'pointer',
            fontSize: 15, fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 8,
            transition: 'background-color .12s ease',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Upload Labels
        </button>
      </div>

      {/* Filter tabs — bigger, centered, color-coded to match each status
          everywhere else in the app so a reviewer can scan the queue by
          color, not just read text. */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
        {(['All', 'Flagged', 'Needs Review', 'Pending', 'Approved'] as const).map(s => {
          const active = filter === s
          const palette = s === 'All' ? ALL_COLOR : STATUS_COLOR[s]
          const count = s === 'All' ? apps.length : apps.filter(a => a.status === s).length
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#F9FAFB' }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = '#fff' }}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '13px 26px', borderRadius: 999,
                border: `1.5px solid ${active ? palette.border : '#E5E7EB'}`,
                fontSize: 17, cursor: 'pointer', fontWeight: active ? 700 : 500,
                background: active ? palette.bg : '#fff',
                color: active ? palette.color : '#374151',
                transition: 'background-color .12s ease, border-color .12s ease',
              }}
            >
              {s !== 'All' && (
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: active ? palette.color : DOT[s], flexShrink: 0 }} />
              )}
              {s}
              <span style={{
                fontSize: 13, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
                background: active ? 'rgba(255,255,255,0.25)' : '#F3F4F6',
                color: active ? palette.color : '#6B7280',
              }}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #E5E7EB', padding: '72px 40px', textAlign: 'center', color: '#9CA3AF', fontSize: 16 }}>
          Loading queue…
        </div>
      ) : error ? (
        <div style={{ background: '#FEF2F2', borderRadius: 10, border: '1px solid #FECACA', padding: '24px', color: '#DC2626', fontSize: 16 }}>
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <Empty />
      ) : (
        <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #E5E7EB', overflow: 'hidden' }}>
          {/* Column headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: ROW_COLUMNS, alignItems: 'center',
            padding: '11px 24px', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB',
          }}>
            <span style={HEADER_CELL}>#</span>
            <span style={HEADER_CELL}>Brand</span>
            <span style={HEADER_CELL}>Details</span>
            <span style={HEADER_CELL}>Submitted</span>
            <span style={HEADER_CELL}>Status</span>
            <span />
          </div>

          {filtered.map((app, i) => {
            const sc = STATUS_COLOR[app.status]
            return (
              <div
                key={app.id}
                onClick={() => navigate('review', app.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: ROW_COLUMNS,
                  alignItems: 'center',
                  padding: '15px 24px',
                  borderBottom: i < filtered.length - 1 ? '1px solid #F3F4F6' : 'none',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#FAFAFA')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* # */}
                <span style={{ fontSize: 14, fontWeight: 600, color: '#D1D5DB' }}>{i + 1}</span>

                {/* Brand + type */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: DOT[app.status], flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 16, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {app.brand}
                    </div>
                    <div style={{ fontSize: 13, color: '#9CA3AF', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {app.type}
                    </div>
                  </div>
                </div>

                {/* Key alcohol details, straight from the submitted application */}
                <div style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, minWidth: 0 }}>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {app.applicationData.beverageType} · {app.applicationData.abv}
                  </div>
                  <div style={{ color: '#9CA3AF' }}>{app.applicationData.netContents}</div>
                </div>

                {/* Submitted */}
                <span style={{ fontSize: 14, color: '#6B7280' }}>{app.submitted}</span>

                {/* Status badge + flagged count */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                  <span style={{
                    fontSize: 13, fontWeight: 600, padding: '3px 11px', borderRadius: 20,
                    color: sc.color, background: sc.bg, border: `1px solid ${sc.border}`,
                  }}>
                    {app.status}
                  </span>
                  {app.flagged > 0 && (
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#EF4444' }}>
                      {app.flagged} flagged
                    </span>
                  )}
                </div>

                {/* Arrow */}
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const HEADER_CELL: CSSProperties = {
  fontSize: 12, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.04em',
}

function Empty() {
  return (
    <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #E5E7EB', padding: '72px 40px', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 14 }}>📋</div>
      <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>No applications yet</div>
      <div style={{ color: '#9CA3AF', fontSize: 14 }}>Upload label files to start reviewing.</div>
    </div>
  )
}
