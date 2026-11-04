/** napi-rs's `--platform` name for each build target (spec §12.1). */
const TARGETS: Record<string, string> = { 'win32-x64': 'win32-x64-msvc', 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'linux-x64': 'linux-x64-gnu' }

/** The addon's build target on `platform`-`arch`, or a clear error where no Typose core is built for it. */
export function addonTarget(platform: string, arch: string): string {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) throw new Error(`no Typose core is built for ${platform}-${arch}`)
  return target
}
