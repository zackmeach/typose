/** Small, fixed SVGs keep format marks independent of font glyph coverage. */
export function FileIcon({ path, markdown = false }: { path: string; markdown?: boolean }) {
  const grid = /\.(csv|tsv)$/i.test(path)
  const md = markdown || /\.(md|markdown)$/i.test(path)
  return (
    <svg className="file-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-format={grid ? 'grid' : md ? 'markdown' : 'text'}>
      {grid ? <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M2 6h12M2 10h12M6 2v12" /></> : <>
        <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3" />
        {md ? <path d="M5.5 11V7.5l2 2.5 2-2.5V11" /> : <path d="M6 7h4M6 9.5h4M6 12h4" />}
      </>}
    </svg>
  )
}

export function AppIcon() {
  return <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" aria-hidden="true" focusable="false">
    <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" /><path d="M5 5h6M8 5v6" />
  </svg>
}
