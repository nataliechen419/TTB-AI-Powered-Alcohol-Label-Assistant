import { useEffect, useState } from 'react'
import Dashboard from './views/Dashboard'
import LabelReview from './views/LabelReview'
import BatchUpload from './views/BatchUpload'

export type Screen = 'dashboard' | 'review' | 'batch'

export default function App() {
  const [screen, setScreen] = useState<Screen>('dashboard')
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [mockMode, setMockMode] = useState(false)

  useEffect(() => {
    fetch('/api/status')
      .then(res => res.json())
      .then(data => setMockMode(!!data.mockMode))
      .catch(() => {})
  }, [])

  const navigate = (s: Screen, id?: string) => {
    setScreen(s)
    if (id) setReviewId(id)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header screen={screen} navigate={navigate} mockMode={mockMode} />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {screen === 'dashboard' && <Dashboard navigate={navigate} />}
        {screen === 'review'    && <LabelReview id={reviewId} navigate={navigate} />}
        {screen === 'batch'     && <BatchUpload navigate={navigate} />}
      </main>
    </div>
  )
}

function Header({ screen, navigate, mockMode }: { screen: Screen; navigate: (s: Screen) => void; mockMode: boolean }) {
  return (
    <header style={{
      background: '#fff',
      borderBottom: '1px solid #E5E7EB',
      display: 'flex',
      alignItems: 'center',
      padding: '0 28px',
      height: 64,
      gap: 36,
    }}>
      <span style={{ fontWeight: 600, fontSize: 17, color: '#111', whiteSpace: 'nowrap' }}>
        Label Review
      </span>

      <nav style={{ display: 'flex', gap: 4 }}>
        {([['dashboard', 'Queue'], ['batch', 'Batch Upload']] as [Screen, string][]).map(([s, label]) => (
          <button
            key={s}
            onClick={() => navigate(s)}
            onMouseEnter={e => { if (screen !== s) e.currentTarget.style.background = '#F9FAFB' }}
            onMouseLeave={e => { if (screen !== s) e.currentTarget.style.background = 'transparent' }}
            style={{
              border: 'none',
              padding: '8px 14px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 15,
              fontWeight: screen === s ? 600 : 400,
              color: screen === s ? '#111' : '#6B7280',
              background: screen === s ? '#F3F4F6' : 'transparent',
              transition: 'background-color .12s ease, color .12s ease',
            } as React.CSSProperties}
          >
            {label}
          </button>
        ))}
      </nav>

      {mockMode && (
        <span
          title="No live Claude API calls are made — all extraction results are simulated locally. Safe to test with any number of uploads."
          style={{
            marginLeft: 'auto',
            fontSize: 12, fontWeight: 600, color: '#B45309', background: '#FFFBEB',
            border: '1px solid #FDE68A', borderRadius: 20, padding: '4px 12px',
            whiteSpace: 'nowrap', cursor: 'default',
          }}
        >
          Demo Mode — simulated results, no API calls
        </span>
      )}

      <div style={{ marginLeft: mockMode ? 0 : 'auto', fontSize: 14, color: '#9CA3AF' }}>
        M. Torres
      </div>
    </header>
  )
}
