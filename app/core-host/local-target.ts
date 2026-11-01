const MAX_TARGET = 32 << 10
// oxlint-disable-next-line no-control-regex -- Both raw hrefs and decoded paths cross an IPC boundary.
const controls = /[\u0000-\u001f\u007f-\u009f]/

export const boundedLink = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_TARGET && Buffer.byteLength(value, 'utf8') <= MAX_TARGET && !controls.test(value)

/** A decoded path, never a URI. Native code repeats these checks and enforces the source's local capability. */
export function decodedLocalTarget(target: string, allowRooted = false): boolean {
  if (!boundedLink(target) || target.length === 0 || /[<>"|?*]/.test(target)) return false
  const rooted = /^[\\/]/.test(target)
  if (rooted && (!allowRooted || /^[\\/]{2}/.test(target))) return false
  try { encodeURIComponent(target) } catch { return false } // no unpaired UTF-16 surrogate
  const relative = rooted ? target.slice(1) : /^[a-z]:[\\/]/i.test(target) ? target.slice(3) : target
  if (!relative || relative.includes(':')) return false // UNC, device, drive-relative and alternate data streams
  return relative.split(/[\\/]/).every((part) =>
    part === '.' || part === '..' || (
      part.length > 0 && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    )
  )
}

/** Decode exactly once. A local href has no query or fragment; same-document fragments resolve separately. */
export function localTarget(href: string, allowRooted = false): string | null {
  if (!boundedLink(href) || href.includes('?') || href.includes('#')) return null
  const file = /^file:\/\/\/([a-z]:\/.*)$/i.exec(href)
  if (!file && href.includes(':')) return null
  try {
    const target = decodeURIComponent(file ? file[1] : href)
    if (!file && target.includes(':')) return null
    return decodedLocalTarget(target, allowRooted) ? target : null
  } catch {
    return null
  }
}
