import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Window-scroll virtualized list for the dashboard's long row lists (drives,
 * charging history). The dashboard scrolls the *window* (the centered column is
 * just `min-height:100vh`, no inner `overflow:auto`), so we virtualize against the
 * window and offset by the list's distance from the top of the document
 * (`scrollMargin`) — the standard TanStack window-virtualizer pattern.
 *
 * Rows keep the existing flex `gap` look: each virtual row carries `paddingBottom:gap`
 * and the gap is folded into the size estimate, then corrected by `measureElement`
 * so variable heights stay pixel-accurate.
 *
 * SSR/hydration: until mounted we render the plain (non-virtual) list so the server
 * markup and first client render match exactly — no hydration mismatch, no flash —
 * then virtualization takes over on the client for scroll performance.
 */
export function VirtualList<T>({
  items,
  getKey,
  renderRow,
  estimateRowHeight = 72,
  gap = 10,
  overscan = 6,
}: {
  items: T[]
  getKey: (item: T, index: number) => string | number
  renderRow: (item: T, index: number) => ReactNode
  estimateRowHeight?: number
  gap?: number
  overscan?: number
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useLayoutEffect(() => {
    const measure = () => {
      const el = listRef.current
      if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [mounted])

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => estimateRowHeight + gap,
    overscan,
    scrollMargin,
    getItemKey: (i) => getKey(items[i], i),
  })

  // Pre-hydration / SSR: render the full list with the original flex layout.
  if (!mounted) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap }}>
        {items.map((item, i) => (
          <div key={getKey(item, i)}>{renderRow(item, i)}</div>
        ))}
      </div>
    )
  }

  return (
    <div ref={listRef} style={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((vi) => (
        <div
          key={vi.key}
          data-index={vi.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
            paddingBottom: gap,
          }}
        >
          {renderRow(items[vi.index], vi.index)}
        </div>
      ))}
    </div>
  )
}
