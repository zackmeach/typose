// Mermaid (spec §4.6, §14 D7): lazy-loaded on the first diagram, at securityLevel 'sandbox' — the diagram is drawn
// inside an iframe whose data: document can run no script. maxTextSize and maxEdges stay at Mermaid's defaults.
type Mermaid = (typeof import('mermaid'))['default']
let loading: Promise<Mermaid> | undefined
let nextId = 0

function showSource(el: HTMLElement, source: string, problem?: string): void {
  const pre = document.createElement('pre')
  pre.className = 'diagram-source'
  pre.textContent = source
  if (problem === undefined) return el.replaceChildren(pre)
  const marker = document.createElement('span')
  marker.className = 'problem'
  marker.title = problem
  marker.textContent = '⚠'
  el.replaceChildren(marker, pre)
}

/** The source shows until the diagram is ready; a render error shows the source plus a problem marker. */
export async function renderDiagram(el: HTMLElement, source: string): Promise<void> {
  showSource(el, source)
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    // suppressErrorRendering: Mermaid's own error diagram would also leave its measuring iframe in document.body.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'sandbox', suppressErrorRendering: true,
      htmlLabels: false, flowchart: { htmlLabels: false },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart'] })
    return mermaid
  })
  try {
    const { svg } = await (await loading).render(`mermaid-${nextId++}`, source)
    // Sandbox mode returns one <iframe sandbox src="data:text/html;base64,…"> with the SVG encoded inside.
    // Parse it inert and insert nothing else, so a Mermaid change can't put markup into the app's DOM.
    const t = document.createElement('template')
    t.innerHTML = svg
    const frame = t.content.firstElementChild
    const ok = t.content.childElementCount === 1 && frame?.tagName === 'IFRAME' && frame.hasAttribute('sandbox')
    if (!ok || !frame.getAttribute('src')?.startsWith('data:text/html;')) throw new Error('Mermaid did not return a sandboxed frame')
    // Mermaid sets sandbox="allow-top-navigation-by-user-activation allow-popups". Drop both: a clicked diagram link to
    // about:blank (Mermaid's rewrite of javascript:) navigates the app's top frame, and Electron emits no will-navigate
    // or will-frame-navigate for it. Diagram links go dead; a read-only viewer loses nothing.
    frame.setAttribute('sandbox', '')
    frame.setAttribute('title', 'Mermaid diagram')
    el.replaceChildren(frame)
  } catch (err) {
    showSource(el, source, err instanceof Error ? err.message : String(err))
  }
}
