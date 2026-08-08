import { useState, type CSSProperties, type ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, { bg: string; hoverBg: string; color: string; border: string }> = {
  primary: { bg: '#111',  hoverBg: '#2A2A2A', color: '#fff',    border: 'none' },
  ghost:   { bg: '#fff',  hoverBg: '#F9FAFB', color: '#374151', border: '1px solid #E5E7EB' },
  danger:  { bg: '#fff',  hoverBg: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA' },
}

export default function Button({
  variant = 'ghost',
  disabled,
  onClick,
  children,
  style,
  small,
  title,
}: {
  variant?: Variant
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  style?: CSSProperties
  small?: boolean
  title?: string
}) {
  const [hover, setHover] = useState(false)
  const v = VARIANTS[variant]

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: small ? '6px 12px' : '9px 18px',
        borderRadius: 8,
        fontSize: small ? 13 : 14,
        fontWeight: 500,
        border: v.border,
        background: disabled ? '#F3F4F6' : hover ? v.hoverBg : v.bg,
        color: disabled ? '#9CA3AF' : v.color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        transition: 'background-color .12s ease, border-color .12s ease, transform .05s ease',
        transform: hover && !disabled ? 'translateY(-1px)' : 'none',
        ...style,
      }}
    >
      {children}
    </button>
  )
}

export function IconButton({
  disabled,
  onClick,
  children,
  style,
}: {
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  style?: CSSProperties
}) {
  const [hover, setHover] = useState(false)

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        border: '1px solid #E5E7EB',
        background: disabled ? '#F9FAFB' : hover ? '#F3F4F6' : '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 15,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: disabled ? '#D1D5DB' : '#374151',
        transition: 'background-color .12s ease',
        ...style,
      }}
    >
      {children}
    </button>
  )
}
