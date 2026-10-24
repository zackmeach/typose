// Gathers a failed CI job's evidence into one directory for upload (plan C9, PR 2): Playwright's test-results/, where
// e2e/app.ts's `finish` copies each launch's exit status, lifecycle log and crash dumps, plus the logs and dumps of any
// e2e or packaged-app profile still in the temp directory because its run never reached `finish`.
// Bounded for GitHub Free's 500 MB of artifact storage by each file's stored size: the artifact is a zip, and a dump
// deflates 6-11x. Smallest first, a file storing over FILE_CAP is listed but not copied, and copying stops at TOTAL_CAP.
// MANIFEST.txt lists every file found, copied or not, with its raw and stored sizes, and is printed to the job log too.
// Usage: node .github/scripts/collect-evidence.mjs <out-dir>. Writes nothing when there's nothing to keep.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const MiB = 2 ** 20
const FILE_CAP = 16 * MiB // stored bytes, deflated at upload-artifact's compression-level 9
const TOTAL_CAP = 32 * MiB // stored bytes
const READ_CAP = 256 * MiB // raw bytes: a bigger file isn't read to measure it
const PROFILE = /^typose-(e2e|pkg)-/ // e2e/app.ts's profiles, and the packaged app's (plan PR 3)

/** Every file under `dir`, recursively; none if it doesn't exist. */
function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
}

/** A file's raw size and its size deflated at level 9, or why it can't be kept. */
function measure(src) {
  try {
    const raw = statSync(src).size
    if (raw > READ_CAP) return { raw, stored: Infinity, error: `over the ${READ_CAP / MiB} MiB read cap` }
    return { raw, stored: deflateRawSync(readFileSync(src), { level: 9 }).length }
  } catch (e) {
    return { raw: 0, stored: Infinity, error: `unreadable (${e.code ?? e.message})` }
  }
}

const out = process.argv[2]
if (!out) throw new Error('usage: collect-evidence.mjs <out-dir>')

// [source, path inside the artifact]
const found = files('test-results').map((src) => [src, src])
for (const e of existsSync(tmpdir()) ? readdirSync(tmpdir(), { withFileTypes: true }) : []) {
  if (!e.isDirectory() || !PROFILE.test(e.name)) continue
  const profile = join(tmpdir(), e.name)
  const kept = [...files(join(profile, 'logs')), ...files(join(profile, 'Crashpad')).filter((f) => f.endsWith('.dmp'))]
  for (const src of kept) found.push([src, join('profiles', e.name, relative(profile, src))])
}
if (!found.length) process.exit(0)

const sized = found.map(([src, dest]) => ({ src, dest, ...measure(src) })).sort((a, b) => a.stored - b.stored)
const lines = []
let copied = 0
let stored = 0
for (const f of sized) {
  let skipped = f.error ?? ''
  if (!skipped && f.stored > FILE_CAP) skipped = `stores over the ${FILE_CAP / MiB} MiB file cap`
  else if (!skipped && stored + f.stored > TOTAL_CAP) skipped = `the ${TOTAL_CAP / MiB} MiB total cap was reached`
  if (!skipped) {
    try {
      mkdirSync(dirname(join(out, f.dest)), { recursive: true })
      copyFileSync(f.src, join(out, f.dest))
      copied++
      stored += f.stored
    } catch (e) {
      skipped = `copy failed (${e.code ?? e.message})`
    }
  }
  const size = `${String(f.raw).padStart(10)} raw ${String(Number.isFinite(f.stored) ? f.stored : '-').padStart(10)} stored`
  lines.push(`${size}  ${f.dest}${skipped && `  NOT COPIED: ${skipped}`}`)
}
const manifest = `${lines.join('\n')}\n${copied} of ${sized.length} files copied, about ${stored} bytes stored\n`
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'MANIFEST.txt'), manifest)
process.stdout.write(manifest)
