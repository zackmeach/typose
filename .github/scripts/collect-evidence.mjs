// Gathers a failed CI job's evidence into one directory for upload (plan C9, PR 2): Playwright's test-results/, where
// e2e/app.ts's `finish` copies each launch's exit status, lifecycle log and crash dumps, plus the logs and dumps of any
// e2e profile still in the temp directory because its run never reached `finish`.
// Bounded for GitHub Free's 500 MB of artifact storage: smallest files first, a file over FILE_CAP is listed but not
// copied, and copying stops at TOTAL_CAP. MANIFEST.txt lists every file found, copied or not, with its size.
// Usage: node .github/scripts/collect-evidence.mjs <out-dir>. Writes nothing when there's nothing to keep.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

const MiB = 2 ** 20
const FILE_CAP = 16 * MiB
const TOTAL_CAP = 32 * MiB

/** Every file under `dir`, recursively; none if it doesn't exist. */
function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
}

const out = process.argv[2]
if (!out) throw new Error('usage: collect-evidence.mjs <out-dir>')

// [source, path inside the artifact]
const found = files('test-results').map((src) => [src, src])
for (const e of existsSync(tmpdir()) ? readdirSync(tmpdir(), { withFileTypes: true }) : []) {
  if (!e.isDirectory() || !e.name.startsWith('typose-e2e-')) continue // e2e/app.ts's profile prefix
  const profile = join(tmpdir(), e.name)
  const kept = [...files(join(profile, 'logs')), ...files(join(profile, 'Crashpad')).filter((f) => f.endsWith('.dmp'))]
  for (const src of kept) found.push([src, join('profiles', e.name, relative(profile, src))])
}
if (!found.length) process.exit(0)

const sized = found.map(([src, dest]) => ({ src, dest, size: statSync(src).size })).sort((a, b) => a.size - b.size)
const lines = []
let total = 0
for (const f of sized) {
  let skipped = ''
  if (f.size > FILE_CAP) skipped = `over the ${FILE_CAP / MiB} MiB file cap`
  else if (total + f.size > TOTAL_CAP) skipped = `the ${TOTAL_CAP / MiB} MiB total cap was reached`
  else {
    mkdirSync(dirname(join(out, f.dest)), { recursive: true })
    copyFileSync(f.src, join(out, f.dest))
    total += f.size
  }
  lines.push(`${String(f.size).padStart(10)}  ${f.dest}${skipped && `  NOT COPIED: ${skipped}`}`)
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'MANIFEST.txt'), `${lines.join('\n')}\n${total} bytes copied from ${sized.length} files\n`)
console.log(`${basename(out)}: ${total} bytes copied from ${sized.length} files; see MANIFEST.txt`)
