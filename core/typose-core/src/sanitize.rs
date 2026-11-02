//! Raw HTML and the final pass over every block's HTML (brief §4.6 🔒, spec §4.6), ported from Spike C's `sanitize.rs`
//! (tag `phase0-snap2/spike-c`). Plan (Rendered Markdown slice) §2.3:
//! - `escape_raw`: an allowlisted tag passes through verbatim for ammonia to sanitize. Every other `<` becomes `&lt;`,
//!   so a disallowed tag, a comment or a declaration renders as literal text (ammonia alone would strip the tag and keep
//!   its content, or drop `<script>`'s content).
//! - `sanitize`: ammonia with the brief's allowlist plus pulldown-cmark's own markup, then every `<img>` becomes an
//!   inert placeholder carrying its URL in `data-src`.
//! - Links reach ammonia with their target in `data-href`, which it keeps as data. The one change from the spike: no
//!   URL from the file reaches a live attribute. Every link leaves as `<a href="#" data-href="…">`, or `<a href="#">`
//!   when its target is `javascript:`, `vbscript:` or `data:` (`target`).
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::LazyLock;

/// Brief §4.6: the only tags raw HTML may contribute. `a[href]` (renamed `data-href`) and `img[src alt]` keep those
/// attributes.
pub const RAW_TAGS: [&str; 20] = [
    "b", "i", "em", "strong", "code", "kbd", "sub", "sup", "br", "hr", "details", "summary", "a", "img", "table",
    "thead", "tbody", "tr", "th", "td",
];

/// pulldown-cmark's tags, and the image placeholder's `span`. Raw HTML can't produce them: `escape_raw` escapes them
/// like any other tag.
pub const OWN_TAGS: [&str; 16] =
    ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "pre", "del", "span", "div", "input"];

static AMMONIA: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    // No `href` at all: `sanitize` writes every link's `href` itself, so none from the file can survive.
    let attrs: [(&str, &[&str]); 7] = [
        ("a", &["data-href"]),
        ("img", &["data-src", "alt"]),
        // pulldown-cmark's attributes sit only on its own tags, so raw HTML can't smuggle them onto RAW_TAGS.
        ("ol", &["start"]),
        ("input", &["type", "checked", "disabled"]),
        // The placeholder `sanitize` makes, kept when it runs again.
        ("span", &["data-src", "data-alt", "data-source-map", "data-display"]),
        ("blockquote", &["data-callout"]),
        ("pre", &["data-frontmatter"]),
    ];
    let set = |v: &[&'static str]| v.iter().copied().collect::<HashSet<_>>();
    let mut b = ammonia::Builder::empty();
    b.tags(RAW_TAGS.iter().chain(&OWN_TAGS).copied().collect())
        .tag_attributes(attrs.iter().map(|&(t, a)| (t, set(a))).collect::<HashMap<_, _>>())
        .allowed_classes(
            [
                ("span", set(&["tp-img", "tp-math"])),
                (
                    "code",
                    set(&[
                        "language-mermaid",
                        "language-ts",
                        "language-typescript",
                        "language-js",
                        "language-javascript",
                        "language-json",
                        "language-rust",
                        "language-python",
                        "language-css",
                        "language-html",
                        "language-bash",
                        "language-yaml",
                    ]),
                ),
            ]
            .into_iter()
            .collect(),
        )
        .generic_attributes(HashSet::new()) // ammonia's default allows `lang` and `title` everywhere
        .url_schemes(["http", "https", "mailto"].into())
        .link_rel(None);
    b
});

const WS: [u8; 5] = [b'\t', b'\n', 0x0C, b'\r', b' '];

/// If a start or end tag begins at `s[i]` (a `<`), its end (just past `>`), its lowercase name and where each attribute
/// name is, following the WHATWG tokenizer's tag and attribute states. None for anything else: a comment, a
/// declaration, a lone `<`, or a tag the input ends inside.
fn tag_parts(s: &[u8], i: usize) -> Option<(usize, String, Vec<Range<usize>>)> {
    let mut j = i + 1 + usize::from(s.get(i + 1) == Some(&b'/'));
    if !s.get(j)?.is_ascii_alphabetic() {
        return None;
    }
    let name_start = j;
    while j < s.len() && !WS.contains(&s[j]) && s[j] != b'/' && s[j] != b'>' {
        j += 1;
    }
    let name = String::from_utf8_lossy(&s[name_start..j]).to_ascii_lowercase();
    let mut attrs = Vec::new();
    loop {
        match *s.get(j)? {
            b'>' => return Some((j + 1, name, attrs)),
            c if WS.contains(&c) || c == b'/' => j += 1,
            _ => {
                let a = j;
                j += 1; // an attribute name; its first char may be '='
                while j < s.len() && !WS.contains(&s[j]) && !b"/>=".contains(&s[j]) {
                    j += 1;
                }
                attrs.push(a..j);
                while j < s.len() && WS.contains(&s[j]) {
                    j += 1;
                }
                if s.get(j) == Some(&b'=') {
                    j += 1;
                    while j < s.len() && WS.contains(&s[j]) {
                        j += 1;
                    }
                    match *s.get(j)? {
                        q @ (b'"' | b'\'') => j += 2 + memchr::memchr(q, &s[j + 1..])?,
                        b'>' => {}
                        _ => {
                            while j < s.len() && !WS.contains(&s[j]) && s[j] != b'>' {
                                j += 1;
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Raw HTML (an `Html` or `InlineHtml` event) into `out`: allowlisted tags verbatim, except that an `a` tag's `href`
/// (any case) becomes `data-href`, everything else as text. Text keeps its `&` (entities mean what they mean in HTML);
/// `<` and `>` outside allowlisted tags are escaped.
pub fn escape_raw(s: &str, out: &mut String) {
    let b = s.as_bytes();
    let (mut i, mut done) = (0, 0);
    while let Some(k) = memchr::memchr2(b'<', b'>', &b[i..]) {
        let at = i + k;
        out.push_str(&s[done..at]);
        i = at + 1;
        if b[at] == b'<' {
            match tag_parts(b, at) {
                Some((end, name, attrs)) if RAW_TAGS.contains(&name.as_str()) => {
                    let mut from = at;
                    for r in attrs.into_iter().filter(|r| name == "a" && s[r.clone()].eq_ignore_ascii_case("href")) {
                        out.push_str(&s[from..r.start]);
                        out.push_str("data-href");
                        from = r.end;
                    }
                    out.push_str(&s[from..end]);
                    i = end;
                }
                Some((end, ..)) => {
                    // A disallowed tag: all of it is text. Jumping past it keeps the pass linear.
                    out.push_str(&s[at..end].replace('<', "&lt;").replace('>', "&gt;"));
                    i = end;
                }
                None if tag_at_eof(b, at) => {
                    // The input ends inside this tag, and HTML would swallow everything after it: all of it is
                    // text. Stopping here also keeps the pass linear (no re-scan per later `<`).
                    out.push_str(&s[at..].replace('<', "&lt;").replace('>', "&gt;"));
                    return;
                }
                None => out.push_str("&lt;"),
            }
        } else {
            out.push_str("&gt;");
        }
        done = i;
    }
    out.push_str(&s[done..]);
}

/// True when `s[i]` starts what would be a tag if the input didn't end first.
fn tag_at_eof(s: &[u8], i: usize) -> bool {
    let j = i + 1 + usize::from(s.get(i + 1) == Some(&b'/'));
    s.get(j).is_some_and(u8::is_ascii_alphabetic)
}

/// HTML-escapes text exactly as html5ever serializes it, so written text and sanitized text compare equal.
pub fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{A0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

/// An attribute value, double-quoted by the caller.
pub fn escape_attr(s: &str) -> String {
    let mut out = String::new();
    escape_text(s, &mut out);
    out.replace('"', "&quot;")
}

/// What a link or image target may become (brief §4.4, §4.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// http, https, mailto, or a relative path that isn't a network path: for a link, `data-href`; for an image (not
    /// mailto, `image_target`), `data-src`.
    Live,
    /// Any other scheme (`file:`, `smb:`, …) or a network path (`//host`, `\\host`): a link's `data-href`, for the
    /// hand-off to decide on a click (PR 3); never an image's `data-src`.
    Inert,
    /// javascript, vbscript and data: nothing is kept.
    Dropped,
}

/// Classifies `url` (decoded) as WHATWG URL parsing reads it: C0 controls and spaces trimmed, tabs and newlines
/// removed, `\` read as `/`, and a scheme an ASCII letter then letters, digits, `+`, `-` or `.` before a `:`.
pub fn target(url: &str) -> Target {
    let s: String = url.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let b = s.as_bytes();
    if b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\') {
        return Target::Inert;
    }
    let scheme = s.split_once(':').map(|(scheme, _)| scheme).filter(|scheme| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    match scheme.map(str::to_ascii_lowercase).as_deref() {
        None | Some("http" | "https" | "mailto") => Target::Live,
        Some("javascript" | "vbscript" | "data") => Target::Dropped,
        Some(_) => Target::Inert,
    }
}

/// What an image target may become: as `target`, except that `mailto:` is never an image target (Z43).
pub fn image_target(url: &str) -> Target {
    let s: String = url.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let bytes = s.as_bytes();
    if s.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:///"))
        && bytes.get(8).is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(9) == Some(&b':')
        && bytes.get(10) == Some(&b'/')
    {
        return Target::Live; // inert metadata only; the native capability validates the actual route
    }
    match target(url) {
        Target::Live if s.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("mailto:")) => Target::Inert,
        t => t,
    }
}

/// Move image destinations into inert data before ammonia's URL filtering. The final pass always replaces the
/// image element, so preserving a file URI here never gives the browser a live file/network source.
fn inert_images(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let (mut at, mut copied) = (0, 0);
    while let Some(next) = memchr::memchr(b'<', &html.as_bytes()[at..]) {
        let start = at + next;
        at = start + 1;
        if let Some((end, name, attrs)) = tag_parts(html.as_bytes(), start) {
            if name == "img" {
                for attr in attrs.into_iter().filter(|r| html[r.clone()].eq_ignore_ascii_case("src")) {
                    out.push_str(&html[copied..attr.start]);
                    out.push_str("data-src");
                    copied = attr.end;
                }
            }
            at = end;
        } else if tag_at_eof(html.as_bytes(), start) {
            break; // do not rescan a long unterminated tag for every later literal '<'
        }
    }
    out.push_str(&html[copied..]);
    out
}

/// Every block's last step: ammonia, then `<img>` → placeholder, and every link rewritten with `href="#"`: its target
/// judged once (`target`), kept as inert `data-href` or dropped. Every link keeps an `href`, so it keeps its role and
/// keyboard focus (brief §9). Running it again changes nothing.
pub fn sanitize(html: &str) -> String {
    let inert = inert_images(html);
    let clean = AMMONIA.clean(&inert).to_string();
    // ponytail: a string rewrite of ammonia's serialization, where `<` only ever opens a tag and attribute values
    // are double-quoted with `"`, `<` and `>` escaped. A DOM rewrite would need ammonia's unstable rcdom API.
    let mut out = String::with_capacity(clean.len());
    let mut rest = clean.as_str();
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let end = i + rest[i..].find('>').map_or(rest.len() - i, |e| e + 1);
        let tag = &rest[i..end];
        let value =
            |name: &str| tag.split_once(&format!(" {name}=\"")).map(|(_, v)| &v[..v.find('"').unwrap_or(v.len())]);
        let decode = |v: &str| {
            v.replace("&quot;", "\"")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&nbsp;", "\u{A0}")
                .replace("&amp;", "&")
        };
        if tag.starts_with("<img") {
            out.push_str("<span class=\"tp-img\"");
            let src = value("data-src").filter(|v| image_target(&decode(v)) == Target::Live);
            for (attr, v) in [("data-src", src), ("data-alt", value("alt"))] {
                if let Some(v) = v {
                    out.push_str(&format!(" {attr}=\"{v}\""));
                }
            }
            out.push_str("></span>");
        } else if tag == "<a>" || tag.starts_with("<a ") {
            match value("data-href").filter(|v| target(&decode(v)) != Target::Dropped) {
                Some(v) => out.push_str(&format!("<a href=\"#\" data-href=\"{v}\">")),
                None => out.push_str("<a href=\"#\">"),
            }
        } else {
            out.push_str(tag);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlisted_tags_pass_and_everything_else_is_literal_text() {
        let mut out = String::new();
        let raw = r#"<B title="a>b">x</b> <script>alert(1)</script> <!-- c --> a < b > c <br/> <img src=x onerror=y>"#;
        escape_raw(raw, &mut out);
        assert_eq!(
            out,
            r#"<B title="a>b">x</b> &lt;script&gt;alert(1)&lt;/script&gt; &lt;!-- c --&gt; a &lt; b &gt; c <br/> <img src=x onerror=y>"#
        );
        out.clear();
        escape_raw(r#"<a HREF="x" Href=y>l</a> <link rel=preconnect href=//h>"#, &mut out);
        assert_eq!(out, r#"<a data-href="x" data-href=y>l</a> &lt;link rel=preconnect href=//h&gt;"#);
    }

    #[test]
    fn tag_ends_follow_the_tokenizer() {
        let end = |s: &str| tag_parts(s.as_bytes(), 0).map(|(end, name, _)| (end, name));
        assert_eq!(end(r#"<a href='x>y' title=z/>rest"#), Some((23, "a".into()))); // quoted '>' and an unquoted '/'
        assert_eq!(end("<a\nhref=x>"), Some((10, "a".into())));
        assert_eq!(end("</TD x>"), Some((7, "td".into())));
        assert_eq!(end("<a =x>"), Some((6, "a".into())));
        assert_eq!(end("<a href=\"x"), None); // the input ends inside the tag: HTML drops it, we show it
        assert_eq!(end("<1>"), None);
        assert_eq!(end("</>"), None);
        assert_eq!(end("<!-- x -->"), None);
    }

    #[test]
    fn an_unterminated_tag_makes_the_rest_literal_in_linear_time() {
        let hostile = "<a ".repeat(200_000);
        let t = std::time::Instant::now();
        let mut out = String::new();
        escape_raw(&hostile, &mut out);
        assert_eq!(out, "&lt;a ".repeat(200_000));
        assert!(t.elapsed().as_secs() < 2, "{:?}", t.elapsed());
    }

    #[test]
    fn sanitize_strips_attributes_and_rewrites_every_link_and_image() {
        let got = sanitize(concat!(
            r#"<p><b style="x" onclick="y" title="t">b</b> <a data-href="javascript:alert(1)">j</a> "#,
            r#"<a data-href="java&#115;cript:x">e</a> <a data-href="https://x.y/?a=1&amp;b">ok</a> "#,
            r#"<a href="https://evil/">h</a> <a>bare</a> <a data-href="smb://h/s">s</a> "#,
            r#"<img src="http://evil/t.png" alt="A&quot;B" onerror="z"> <img src="//h/x.png"> <img src="data:image/png,x"></p>"#
        ));
        assert_eq!(
            got,
            concat!(
                r##"<p><b>b</b> <a href="#">j</a> <a href="#">e</a> <a href="#" data-href="https://x.y/?a=1&amp;b">ok</a> "##,
                r##"<a href="#">h</a> <a href="#">bare</a> <a href="#" data-href="smb://h/s">s</a> "##,
                r#"<span class="tp-img" data-src="http://evil/t.png" data-alt="A&quot;B"></span> "#,
                r#"<span class="tp-img"></span> <span class="tp-img"></span></p>"#
            )
        );
        assert_eq!(sanitize(&got), got, "idempotent");
    }

    #[test]
    fn image_destinations_stay_inert_including_file_and_network_forms() {
        for (src, kept) in [
            ("next.png", true),
            ("file:///C:/a%20b.png", true),
            ("file://host/share/a.png", false),
            ("smb://host/a.png", false),
            ("//host/a.png", false),
        ] {
            let html = sanitize(&format!("<img src=\"{src}\" alt=\"a&lt;b\" onerror=\"x\">"));
            assert!(html.starts_with("<span class=\"tp-img\""), "{html}");
            assert_eq!(html.contains(&format!("data-src=\"{src}\"")), kept, "{html}");
            assert!(!html.contains("<img") && !html.contains(" src=") && !html.contains("onerror"), "{html}");
            assert_eq!(sanitize(&html), html);
        }
        let hostile = "<img src=\"<img ".repeat(20_000);
        let start = std::time::Instant::now();
        let _ = sanitize(&hostile);
        assert!(start.elapsed().as_secs() < 2);
    }

    #[test]
    fn targets_are_classified_as_whatwg_reads_them() {
        for (url, want) in [
            ("#heading", Target::Live),
            ("other.md", Target::Live),
            ("HTTPS://x", Target::Live),
            ("mailto:a@b", Target::Live),
            ("file:///C:/x", Target::Inert),
            ("smb://h/s", Target::Inert),
            ("//h/x", Target::Inert),
            ("\\\\h\\x", Target::Inert),
            (" \t//h", Target::Inert),
            ("ms-settings:display", Target::Inert),
            ("java\tscript:x", Target::Dropped),
            ("\u{1}JavaScript:x", Target::Dropped),
            ("VBScript:x", Target::Dropped),
            ("data:text/html,x", Target::Dropped),
        ] {
            assert_eq!(target(url), want, "{url:?}");
        }
        assert_eq!(image_target("mailto:a@b"), Target::Inert);
        assert_eq!(image_target("a.png"), Target::Live);
    }
}
