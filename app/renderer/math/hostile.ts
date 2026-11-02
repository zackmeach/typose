// Hostile fixtures for the untrusted-content renderers (spec §13.1). Every URL is on .invalid, which never resolves.

/** TeX: trusted commands, macro bombs, huge sizes, deep nesting, CSS injection, raw markup in text. */
export const HOSTILE_TEX: string[] = [
  String.raw`\href{javascript:alert(1)}{click}`,
  String.raw`\href{https://example.invalid/h}{x}\url{https://example.invalid/u}`,
  String.raw`\includegraphics{https://example.invalid/i.png}\includegraphics[height=1em]{file:///C:/Windows/win.ini}`,
  String.raw`\htmlData{onload=alert(1), x=y}{a}\htmlId{evil}{b}\htmlClass{x" onmouseover="alert(1)}{c}\htmlStyle{background:url(https://example.invalid/s)}{d}`,
  String.raw`\def\a{\a\a}\a`,
  String.raw`\def\b#1{#1#1}\b{\b{\b{\b{\b{\b{\b{\b{\b{\b{\b{\b{x}}}}}}}}}}}}`,
  String.raw`\newcommand{\zz}{\zz\zz}\zz`,
  String.raw`\rule{100000em}{100000em}\kern100000em\hspace{100000em}\mkern100000mu\raisebox{100000em}{x}`,
  '{'.repeat(50_000) + 'x' + '}'.repeat(50_000),
  '\\sqrt{'.repeat(5_000) + 'x' + '}'.repeat(5_000),
  String.raw`\color{red;background:url(https://example.invalid/c)}{x}\textcolor{expression(alert(1))}{y}\colorbox{url(https://example.invalid/b)}{z}`,
  String.raw`\text{<img src=https://example.invalid/t onerror=alert(1)><script>alert(1)</script>}`,
  String.raw`\mathrm{</span><a href="https://example.invalid/">x</a>}\operatorname{<math href="javascript:alert(1)">y</math>}`,
  String.raw`\begin{array}{c}\href{javascript:alert(1)}{x}\\\url{javascript:alert(1)}\end{array}`,
  String.raw`\sqrt{x}\frac{a}{b}\xrightarrow{abc}\widehat{xyz}` // legitimate: KaTeX draws these with inline SVG
]

/** One \def that copies its argument 100 times, applied twice: 231 characters, 101 expansions, 200,010 elements. */
export const MATH_BOMB = String.raw`\def\zz#1{` + '#1'.repeat(100) + String.raw`}\zz{\zz{yyyyyyyyyy}}`
/** The same, three deep: past maxExpand, so KaTeX itself stops it. */
export const MATH_BOMB_3 = String.raw`\def\zz#1{` + '#1'.repeat(100) + String.raw`}\zz{\zz{\zz{y}}}`

/** HTML/MathML/SVG a KaTeX bug could emit: what the DOMPurify pass alone must neutralize. */
export const HOSTILE_HTML: string[] = [
  '<math><annotation-xml encoding="text/html"><img src="https://example.invalid/a" onerror="alert(1)"></annotation-xml></math>',
  '<math><semantics><mi>x</mi><annotation-xml encoding="application/xhtml+xml"><a href="https://example.invalid/">y</a></annotation-xml></semantics></math>',
  '<math href="javascript:alert(1)"><mi xlink:href="https://example.invalid/m">x</mi></math>',
  '<svg><a xlink:href="https://example.invalid/s"><text>x</text></a><foreignObject><img src="https://example.invalid/f"></foreignObject></svg>',
  '<svg><image href="https://example.invalid/i.png"></image><use href="https://example.invalid/u.svg#x"></use></svg>',
  '<span style="background:url(https://example.invalid/b)">a</span><span style="background:u\\72l(https://example.invalid/e)">b</span>',
  '<style>@import url(https://example.invalid/i.css)</style><span style="x:1;@import url(https://example.invalid/j.css)">c</span>',
  '<span onclick="alert(1)" data-x="1">d</span><script>alert(1)</script><img src=x onerror=alert(1)>',
  '<math><mtext><table><mglyph><style><img src=https://example.invalid/mx onerror=alert(1)>',
  '<a href="https://example.invalid/">link</a><iframe src="https://example.invalid/if"></iframe><object data="https://example.invalid/o"></object>',
  '<img srcset="https://example.invalid/s.png 1x"><video poster="https://example.invalid/p.png"></video><table background="https://example.invalid/t.png"><tr><td background="https://example.invalid/d.png">x</td></tr></table>' +
    '<form action="https://example.invalid/f"><button formaction="https://example.invalid/g">b</button><input type="image" src="https://example.invalid/i.png"></form>'
]

/** YAML for the zero-effects run: an alias bomb, URL-shaped tags and %TAG handles, a recursive alias. */
export const HOSTILE_YAML: string[] = [
  ['a: &a [x, x, x, x, x, x, x, x, x]', ...Array.from({ length: 9 }, (_, i) => `${'bcdefghij'[i]}: &${'bcdefghij'[i]} [${Array(9).fill('*' + 'abcdefghi'[i]).join(', ')}]`)].join('\n'),
  '%TAG !e! tag:example.invalid,2000:\n--- !e!doc\na: !<https://example.invalid/t> 1\nb: !!binary aGVsbG8=\nc: !!js/function "function () { fetch(\'https://example.invalid/\') }"\n',
  'r: &r [*r]\n<<: *r\n'
]

/** A label payload: an image, a script, a javascript: link, an @import and a frame. */
const H =
  "<img src=https://example.invalid/i.png><script>alert(1)</script><a href='javascript:alert(1)'>a</a>" +
  "<style>@import url(https://example.invalid/s.css)</style><iframe src=https://example.invalid/f></iframe>"

/** A flowchart with `edges` edges, padded with a comment to `chars` characters (Mermaid's limits: 50,000 and 500). */
export function hugeFlowchart(edges: number, chars: number): string {
  const lines = ['flowchart LR']
  for (let i = 0; i < edges; i++) lines.push(`  n${i}["${i}"] --> n${i + 1}`)
  const body = lines.join('\n') + '\n'
  return body + '%%' + 'x'.repeat(Math.max(0, chars - body.length - 2))
}

/**
 * Mermaid: every diagram type mermaid 12.2.0 registers, with hostile text wherever the type's grammar accepts text,
 * plus directives, front-matter, click/href/link, classDef/style CSS and the image shape.
 */
export const HOSTILE_MERMAID: { name: string; source: string }[] = [
  {
    name: 'flowchart: init directive',
    source: `%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": "@import url(https://example.invalid/t.css); .node rect {fill: url(https://example.invalid/n.png)}", "fontFamily": "x;background:url(https://example.invalid/ff)"}}%%
flowchart LR
  A["${H}"] --> B`
  },
  {
    name: 'flowchart: front-matter config',
    source: `---\nconfig:\n  securityLevel: loose\n  htmlLabels: true\n  themeCSS: "@import url(https://example.invalid/fm.css);"\n---\nflowchart LR\n  A["${H}"] --> B`
  },
  {
    name: 'flowchart: labels',
    source: `flowchart LR
  A["${H}"] --> B["\`**md** <img src=https://example.invalid/md.png>\`"]
  B --> C[#lt;img src=https://example.invalid/ent.png#gt;]
  C --> D["$$\\href{https://example.invalid/k}{k}\\includegraphics{https://example.invalid/g.png}$$"]
  D --> E(fa:fa-car icon)`
  },
  { name: 'flowchart: image shape', source: 'flowchart LR\n  A --> B@{ img: "https://example.invalid/shape.png", label: "x", pos: "t", h: 60 }' },
  {
    name: 'flowchart: click and href',
    source:
      'flowchart LR\n  A --> B --> C --> D\n  click A href "javascript:alert(1)"\n  click B href "https://example.invalid/b" _top\n  click C call alert(1)\n  click D href "https://example.invalid/d" _blank'
  },
  { name: 'flowchart: classDef url(', source: 'flowchart LR\n  A --> B\n  classDef evil fill:url(https://example.invalid/c.png)\n  class A evil' },
  { name: 'flowchart: style url(', source: 'flowchart LR\n  A --> B\n  style A fill:url(https://example.invalid/s.png)' },
  {
    name: 'sequence',
    source: `sequenceDiagram\n  participant A as ${H}\n  A->>B: ${H}\n  Note right of A: ${H}\n  link A: Evil @ javascript:alert(1)\n  links B: {"Web": "https://example.invalid/w"}`
  },
  {
    name: 'class',
    source: `classDiagram\n  class A["${H}"]\n  note for A "${H}"\n  link A "https://example.invalid/c" "tip"\n  click A href "javascript:alert(1)"`
  },
  { name: 'class: classDef url(', source: 'classDiagram\n  class A\n  classDef bad fill:url(https://example.invalid/cf.png)\n  cssClass "A" bad' },
  { name: 'state', source: `stateDiagram-v2\n  state "${H}" as s1\n  note right of s1 : x\n  [*] --> s1` },
  {
    name: 'state: classDef url( and @import',
    source:
      'stateDiagram-v2\n  s1 --> s2\n  classDef bad fill:url(https://example.invalid/sf.png)\n  classDef imp color:red;@import url(https://example.invalid/si.css)\n  class s1 bad\n  class s2 imp'
  },
  { name: 'er', source: `erDiagram\n  CUSTOMER ||--o{ ORDER : "${H}"\n  CUSTOMER {\n    string name "${H}"\n  }` },
  {
    name: 'gantt',
    source: `gantt\n  title ${H}\n  dateFormat YYYY-MM-DD\n  section ${H}\n  ${H} :a1, 2024-01-01, 30d\n  click a1 href "javascript:alert(1)"\n  click a1 call alert(1)`
  },
  { name: 'pie', source: `pie title ${H}\n  "${H}" : 42\n  "b" : 58` },
  { name: 'journey', source: `journey\n  title ${H}\n  section Sect\n    Task one: 5: Me` },
  { name: 'gitGraph', source: `gitGraph\n  commit id: "${H}"\n  branch b\n  commit tag: "${H}"\n  checkout main\n  merge b` },
  { name: 'mindmap', source: `mindmap\n  root["${H}"]\n    child["${H}"]\n    ::icon(fa fa-book)` },
  { name: 'timeline', source: `timeline\n  title ${H}\n  2024 : ${H}` },
  { name: 'quadrantChart', source: `quadrantChart\n  title ${H}\n  x-axis Low --> High\n  y-axis Low --> High\n  quadrant-1 Q1\n  Point A: [0.3, 0.6]` },
  { name: 'xychart', source: `xychart\n  title "${H}"\n  x-axis [a, b]\n  y-axis "${H}" 0 --> 10\n  bar [1, 2]` },
  { name: 'requirement', source: `requirementDiagram\n  requirement r {\n    id: 1\n    text: "${H}"\n    risk: high\n    verifymethod: test\n  }` },
  { name: 'sankey', source: `sankey\n"${H}",B,10\nB,C,5` },
  { name: 'block', source: `block\n  columns 1\n  a["${H}"]` },
  { name: 'packet', source: `packet\n  0-15: "${H}"` },
  { name: 'kanban', source: `kanban\n  todo["${H}"]\n    t1["${H}"]` },
  {
    name: 'architecture',
    source: `architecture-beta\n  group api(cloud)[${H}]\n  service db(database)[${H}] in api\n  service ext(logos:aws)[aws] in api\n  db:L -- R:ext`
  },
  { name: 'radar', source: `radar-beta\n  title ${H}\n  axis a["${H}"], b["b"], c["c"]\n  curve k["${H}"]{1, 2, 3}` },
  { name: 'treemap', source: `treemap\n  "${H}"\n    "child": 10` },
  {
    name: 'c4',
    source: `C4Context\n  title ${H}\n  Person(p, "${H}", "${H}", $link="https://example.invalid/p")\n  System(s, "${H}", $link="javascript:alert(1)")\n  Rel(p, s, "${H}")`
  },
  { name: 'flowchart-elk', source: `flowchart-elk LR\n  A["${H}"] --> B` },
  { name: 'info', source: 'info' },
  { name: 'venn', source: `venn-beta\n  title ${H}\n  set A["${H}"]\n  set B["b"]\n  union A,B` },
  { name: 'ishikawa', source: `ishikawa\n  ${H}\n    cause one\n      sub cause` },
  { name: 'usecase', source: `usecase-beta\n  actor User\n  User --> "${H}"` },
  { name: 'wardley', source: `wardley-beta\n  title ${H}\n  component Customer [0.9, 0.5]\n  component Cup [0.8, 0.6]\n  Customer -> Cup` },
  { name: 'cynefin', source: `cynefin-beta\n  title "${H}"\n  complex "${H}"` },
  { name: 'treeView', source: `treeView-beta\n  "${H}"\n    "child"` },
  { name: 'swimlane', source: `swimlane-beta\n  A["${H}"] --> B` },
  { name: 'agentflow', source: `agentflow-beta\n  A["${H}"] --> B` },
  { name: 'eventmodeling', source: `eventmodeling\n  tf 01 cmd DoThing [[Payload]]\n  data Payload \`html\` {\n    ${H}\n}\n  note 01 {\n    ${H}\n}` },
  { name: 'railroad', source: `railroad-beta\n  rule = terminal("${H}");` },
  { name: 'railroad-ebnf', source: `railroad-ebnf-beta\n  rule = "${H}" ;` },
  { name: 'railroad-abnf', source: `railroad-abnf-beta\n  rule = "${H}" ;` },
  { name: 'railroad-peg', source: `railroad-peg-beta\n  rule <- "${H}" ;` }
]
