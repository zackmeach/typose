# Bundled fonts

These files are shipped with the renderer for offline use. No font is fetched at runtime.
The font binaries are copied unchanged from the pinned upstream release files; no subsetting
or conversion was performed, so glyph coverage is exactly the upstream file's coverage.

## Inter

- Release: `rsms/inter` v4.1, commit `e3a3d4c` (GitHub release page identifies this commit).
- Source: <https://github.com/rsms/inter/tree/v4.1/docs/font-files>
- Files: `InterVariable.woff2` (roman variable weight 100–900) and
  `InterVariable-Italic.woff2` (italic variable weight 100–900).
- License: SIL Open Font License 1.1, copied as `LICENSE-Inter-OFL.txt` from
  <https://github.com/rsms/inter/blob/v4.1/LICENSE.txt>.

## JetBrains Mono

- Release: `JetBrains/JetBrainsMono` v2.304, commit `cd5227b` (GitHub release page identifies this commit).
- Source: <https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/webfonts>
- Files: `JetBrainsMono-Regular.woff2` (400), `JetBrainsMono-Medium.woff2` (500),
  `JetBrainsMono-SemiBold.woff2` (600), and `JetBrainsMono-Bold.woff2` (700).
- License: SIL Open Font License 1.1, copied as `LICENSE-JetBrains-Mono-OFL.txt` from
  <https://github.com/JetBrains/JetBrainsMono/blob/v2.304/OFL.txt>.

## SHA-256

| File | SHA-256 |
|---|---|
| `inter-variable.woff2` | `693B77D4F32EE9B8BFC995589B5FAD5E99ADF2832738661F5402F9978429A8E3` |
| `inter-variable-italic.woff2` | `E564F652916DB6C139570FEFB9524A77C4D48F30C92928DE9DB19B6B5C7A262A` |
| `jetbrains-mono-regular.woff2` | `A9CB1CD82332B23A47E3A1239D25D13C86D16C4220695E34B243EFFA999F45F2` |
| `jetbrains-mono-medium.woff2` | `086C48DFBEA9DDAFF1320F7E09399B8E2924E88CE67453721255DB3BDBB5A353` |
| `jetbrains-mono-semibold.woff2` | `918EDAD542A1DA608FD2BA8DAEBAFF9AC802309103FE760EED465B8B4E47FAF1` |
| `jetbrains-mono-bold.woff2` | `C503CC5EC5F8B2C7666B7ECDA1ADF44BD45F2E6579B2EBA0FC292150416588A2` |
| `LICENSE-Inter-OFL.txt` | `262481E844521B326F5ECD053E59B98C8B2DA78C8EE1BDBB6E8174305E54935A` |
| `LICENSE-JetBrains-Mono-OFL.txt` | `30F0C136E3C88E422D0791ACD97238870F9054A9729BC34CF2FF0D4ED8CAC4AD` |
