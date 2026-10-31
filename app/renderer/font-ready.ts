/** Settle bundled fonts before any lens measures rows/anchors. A timeout pins the session to fallback metrics. */
export async function fontsReady(fonts: Pick<FontFaceSet, 'load'>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.all([
        fonts.load('13px Inter'), fonts.load('italic 13px Inter'),
        ...[400, 500, 600, 700].map((weight) => fonts.load(`${weight} 13px "JetBrains Mono"`))
      ])
        .then((faces) => faces.every((loaded) => loaded.length > 0), () => false),
      new Promise<false>((done) => { timer = setTimeout(() => done(false), 1500) })
    ])
  } finally {
    clearTimeout(timer)
  }
}
