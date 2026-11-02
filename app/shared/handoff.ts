// What Typose never hands to the OS's default-app launcher: programs, scripts, and the files that start them. Main
// adds the machine's PATHEXT; this list is the floor, shared so the renderer can show the sheet main would enforce.
// Main opens only `OPENABLE` below; this list names programs for the sheets, and is main's second check.
const EXECUTABLE = new Set([
  // Windows' default PATHEXT
  '.com', '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc', '.cpl',
  // Plan Z79's list
  '.ps1', '.psm1', '.msi', '.msp', '.scr', '.lnk', '.url', '.reg', '.hta', '.jar', '.appref-ms', '.application',
  '.gadget', '.pif', '.scf', '.inf', '.settingcontent-ms',
  // Also run code, or mount or fetch something that can
  '.chm', '.sct', '.wsc', '.ws', '.dll', '.ocx', '.sys', '.diagcab', '.library-ms', '.searchconnector-ms', '.website',
  '.appinstaller', '.appx', '.appxbundle', '.msix', '.msixbundle', '.xbap', '.iso', '.img', '.vhd', '.vhdx',
  '.py', '.pyw', '.sh', '.command', '.app', '.desktop'
])

/** The extension Windows acts on: trailing dots and spaces fall away when a path is opened. Lowercase, with its dot. */
export function extension(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? '').replace(/[. ]+$/, '')
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : '' // Windows reads `.bat` alone as a .bat file
}

/** Z79: all that Open with default app hands to the OS, by the extension of a path main has already normalized. */
const OPENABLE = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg', '.ico',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.mp4', '.mov', '.mkv', '.webm', '.avi',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.log', '.rtf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.epub', '.zip', '.7z', '.tar', '.gz'
])

export const canOpen = (path: string): boolean => OPENABLE.has(extension(path))

/** `pathext` is Windows' PATHEXT (`.COM;.EXE;…`), which main adds; the renderer and core host use the floor. */
export function isExecutable(path: string, pathext = ''): boolean {
  const ext = extension(path)
  return ext !== '' && (EXECUTABLE.has(ext) || pathext.toLowerCase().split(';').includes(ext))
}
