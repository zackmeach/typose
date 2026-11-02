import { useEffect, useState } from 'react'
import './drop-target.css'

/** The window's drop state while files or folders are dragged over it: a dashed outline and "Drop to open". The preload
 *  reads the drop and App opens it; text and link drags never show it. */
export function DropTarget() {
  const [active, setActive] = useState(false)
  useEffect(() => {
    let depth = 0 // enter and leave pair up per element the drag crosses; the window is left when they balance
    const files = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')
    const enter = (event: DragEvent) => { if (files(event)) setActive(++depth > 0) }
    const leave = (event: DragEvent) => { if (files(event)) setActive((depth = Math.max(0, depth - 1)) > 0) }
    const end = () => { depth = 0; setActive(false) }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', end)
      window.removeEventListener('dragend', end)
    }
  }, [])
  return active ? <div className="drop-target" aria-hidden="true">
    <div className="drop-target-card"><h1>Drop to open</h1><p>Markdown, JSON, JSONL, CSV and YAML. Folders become roots in the sidebar.</p></div>
  </div> : null
}
