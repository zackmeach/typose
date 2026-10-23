// NetLog assertion (spec §7.3): no outside-scheme URL request, no DNS resolution, no proxy auto-detection, no socket connect.
// It sees Chromium's network stack only: Node sockets in main or the core host never appear in a NetLog.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DNS = /^(HOST_RESOLVER_|DNS_TRANSACTION)/
const PROXY = /^(WPAD_|PAC_FILE_)/
const SOCKET = /^(TCP_CONNECT|TCP_CONNECT_ATTEMPT|UDP_CONNECT|SSL_CONNECT|QUIC_SESSION)$/

/** Parses a NetLog file, tolerating a log that was cut off before its closing brackets. */
export function parseNetLog(text) {
  try {
    return JSON.parse(text)
  } catch {
    const trimmed = text.trimEnd().replace(/,$/, '')
    return JSON.parse(`${trimmed}]}`)
  }
}

export function checkNetLog(json, allow) {
  const names = Object.fromEntries(Object.entries(json.constants.logEventTypes).map(([name, id]) => [id, name]))
  const violations = []
  for (const e of json.events ?? []) {
    const name = names[e.type]
    if (name === 'URL_REQUEST_START_JOB') {
      // Only the begin event carries the URL; the end event has no params.
      const url = e.params?.url
      // A blob: URL is only as local as the origin that minted it.
      const scheme = url?.startsWith('blob:') ? `blob:${url.slice(5).split(':')[0]}` : url?.split(':')[0]
      if (url && !(allow.includes(scheme) || (scheme.startsWith('blob:') && allow.includes(scheme.slice(5)))))
        violations.push(`request ${url}`)
    } else if (name && DNS.test(name)) {
      violations.push(`dns ${name} ${JSON.stringify(e.params ?? {})}`)
    } else if (name && PROXY.test(name)) {
      violations.push(`proxy ${name} ${JSON.stringify(e.params ?? {})}`)
    } else if (name && SOCKET.test(name)) {
      violations.push(`socket ${name} ${JSON.stringify(e.params ?? {})}`)
    }
  }
  return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowArg = process.argv.indexOf('--allow')
  const allow = allowArg > 0 ? process.argv[allowArg + 1].split(',') : ['typose', 'data', 'blob']
  const violations = checkNetLog(parseNetLog(readFileSync(process.argv[2], 'utf8')), allow)
  for (const v of violations) console.log(v)
  console.log(
    violations.length
      ? `FAIL: ${violations.length} violation(s)`
      : 'PASS: no Chromium network-stack activity (Node sockets in main/core host are not covered)'
  )
  process.exit(violations.length ? 1 : 0)
}
