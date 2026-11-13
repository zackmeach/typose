// electron-builder's afterPack hook (app/package.json `build.afterPack`), on every package, `--dir` included: it
// leaves Electron's Windows Error Reporting module out, and writes resources/THIRD-PARTY-NOTICES.txt.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const LICENSE_FILE = /^((un)?licen[cs]e|copying|notice)/i

export default function afterPack({ appOutDir, electronPlatformName, packager }) {
  // electron_wer.dll is unused today, and adopting it would make the app write a registry value. rmSync throws if
  // it's missing, so an Electron that stops shipping it fails the package until this line goes too.
  if (electronPlatformName === 'win32') rmSync(join(appOutDir, 'electron_wer.dll'))
  writeFileSync(join(packager.getResourcesDir(appOutDir), 'THIRD-PARTY-NOTICES.txt'), notices(packager.appInfo.version))
}

/** A package's license and notice files, in name order. */
const texts = (dir) => readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8').trim())

/**
 * What the renderer, main, preload and core-host bundles may include: every package package-lock.json resolves from
 * app/package.json's dependencies, through their dependencies, optional and peer dependencies. Typose's own addon is
 * left out; so is a package not installed on this system (another platform's optional binary), which can't be bundled.
 */
function npmPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages
  // Node's lookup: the importer's own node_modules, then each enclosing package's, then the root's.
  const find = (from, name) => {
    for (let at = from; ; at = at.slice(0, Math.max(0, at.lastIndexOf('/node_modules/')))) {
      const path = `${at && at + '/'}node_modules/${name}`
      if (lock[path]) return path
      if (!at) return null
    }
  }
  const app = lock.app
  const found = new Set()
  const queue = Object.keys({ ...app.dependencies, ...app.devDependencies }).map((name) => find('app', name))
  while (queue.length) {
    const path = queue.pop()
    if (!path || found.has(path) || lock[path].link || !existsSync(join(ROOT, path))) continue
    found.add(path)
    const { dependencies, optionalDependencies, peerDependencies } = lock[path]
    for (const name of Object.keys({ ...dependencies, ...optionalDependencies, ...peerDependencies })) queue.push(find(path, name))
  }
  return [...found].map((path) => ({
    name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
    version: lock[path].version,
    license: lock[path].license,
    texts: texts(join(ROOT, path))
  }))
}

/** What the core addon links: the crates core/Cargo.lock resolves from typose-node's normal dependencies, for this host. */
function crates() {
  const host = /^host: (\S+)$/m.exec(execFileSync('rustc', ['-vV'], { cwd: ROOT, encoding: 'utf8' }))[1]
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', host,
    '--manifest-path', join(ROOT, 'core/Cargo.toml')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }))
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]))
  const ours = new Set(metadata.workspace_members)
  const found = new Set([metadata.packages.find((p) => p.name === 'typose-node').id])
  for (const id of found) // a Set iterates what's added during the loop
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((k) => k.kind === null)) found.add(dep.pkg)
  return metadata.packages.filter((p) => found.has(p.id) && !ours.has(p.id))
    .map((p) => ({ name: p.name, version: p.version, license: p.license, texts: texts(dirname(p.manifest_path)) }))
}

function notices(version) {
  const firstWith = new Map() // a license text, and the first package that carries it
  const entry = (p) => {
    const id = `${p.name} ${p.version}`
    const body = p.texts.map((text) => {
      if (firstWith.has(text)) return `(The same text as ${firstWith.get(text)}'s, above.)`
      firstWith.set(text, id)
      return text
    })
    if (!body.length) body.push('(The package has no license file.)')
    return [`${'='.repeat(80)}\n${id} (${p.license ?? 'no declared license'})`, ...body].join('\n\n')
  }
  const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  const section = (title, packages) => [`\n${title}\n`, ...packages.sort(byName).map(entry)].join('\n\n')
  return [
    `Third-party notices for Typose ${version}`,
    'Typose includes the third-party software below, generated at package time from package-lock.json and core/Cargo.lock. ' +
      "Electron's and Chromium's notices are LICENSE.electron.txt and LICENSES.chromium.html, beside the Typose executable. " +
      "The bundled fonts' licenses are in app.asar, under third-party/fonts.",
    section('npm packages, bundled into the app', npmPackages()),
    section('Rust crates, linked into the core addon', crates())
  ].join('\n\n') + '\n'
}
