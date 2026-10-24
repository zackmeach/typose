use std::io::{self, Write};

const TYPES: [&str; 4] = ["plan", "tool", "model", "eval"];

/// JSONL lines of exactly `line_len` bytes (newline included) until `target_bytes` is reached.
pub fn jsonl<W: Write>(w: &mut W, target_bytes: u64, line_len: usize) -> io::Result<u64> {
    let mut written = 0u64;
    let mut n = 0u64;
    while written < target_bytes {
        let head = format!(
            "{{\"ts\":\"2026-10-20T12:{:02}:{:02}.{:03}Z\",\"type\":\"{}\",\"msg\":\"line {:010} ",
            (n / 60_000) % 60,
            (n / 1000) % 60,
            n % 1000,
            TYPES[(n % 4) as usize],
            n
        );
        let tail = "\"}\n";
        assert!(line_len >= head.len() + tail.len(), "line_len too small");
        w.write_all(head.as_bytes())?;
        w.write_all(&vec![b'x'; line_len - head.len() - tail.len()])?;
        w.write_all(tail.as_bytes())?;
        written += line_len as u64;
        n += 1;
    }
    Ok(n)
}

/// One record whose `msg` is `payload_bytes` of 'a', then a newline.
pub fn huge_record<W: Write>(w: &mut W, payload_bytes: u64) -> io::Result<()> {
    w.write_all(b"{\"ts\":\"2026-10-20T12:00:00.000Z\",\"type\":\"blob\",\"msg\":\"")?;
    let block = vec![b'a'; 1 << 20];
    let mut left = payload_bytes;
    while left > 0 {
        let take = left.min(block.len() as u64) as usize;
        w.write_all(&block[..take])?;
        left -= take as u64;
    }
    w.write_all(b"\"}\n")
}

const NUMBERS: [&str; 10] = [
    "12345678901234567890",
    "3.10",
    "-0",
    "1e400",
    "0.000123",
    "-42",
    "6.02214076e23",
    "0",
    "-1.5E-7",
    "9007199254740993",
];

/// A JSON document of at least `target_bytes` for the Spike C scanner benchmark; returns its element count.
/// Shapes: `records` (an array of ~190-byte objects, like `jsonl` lines joined), `wide` (one object, every
/// 100,000th key repeating key 0), `deep` (an array of records nested 1,000 levels) and `numbers`.
pub fn json_doc<W: Write>(w: &mut W, shape: &str, target_bytes: u64) -> io::Result<u64> {
    if !["records", "wide", "deep", "numbers"].contains(&shape) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("unknown shape {shape}")));
    }
    let deep = format!("{}1{}", "{\"a\":[".repeat(500), "]}".repeat(500));
    let pad = "x".repeat(100);
    let (open, close): (&[u8], &[u8]) = if shape == "wide" { (b"{\n", b"\n}\n") } else { (b"[\n", b"\n]\n") };
    w.write_all(open)?;
    let (mut written, mut n) = (open.len() as u64, 0u64);
    while written < target_bytes {
        let item = match shape {
            "records" => format!(
                "{{\"id\":{n},\"ts\":\"2026-10-20T12:{:02}:{:02}.{:03}Z\",\"type\":\"{}\",\"msg\":\"line {n:010} {pad}\"}}",
                (n / 60_000) % 60,
                (n / 1000) % 60,
                n % 1000,
                TYPES[(n % 4) as usize]
            ),
            "wide" => format!(
                "\"key_{:09}\":{}",
                if n % 100_000 == 99_999 { 0 } else { n },
                ["1", "\"v\"", "true", "null"][(n % 4) as usize]
            ),
            "deep" => deep.clone(),
            _ => NUMBERS[(n % 10) as usize].to_string(),
        };
        let sep: &[u8] = if n == 0 { b"" } else { b",\n" };
        w.write_all(sep)?;
        w.write_all(item.as_bytes())?;
        written += (sep.len() + item.len()) as u64;
        n += 1;
    }
    w.write_all(close)?;
    Ok(n)
}

const WORDS: [&str; 5] = ["alpha", "bravo", "charlie", "delta", "echo"];

/// CSV with a header row `c0,c1,…` and typed columns (integer, decimal, word, date), until `rows` records or
/// `target_bytes`, whichever comes first. About `quoted_per_mille`‰ of fields are quoted and hold the separator,
/// doubled quotes and an embedded newline. `sep` is `,`, or a tab for TSV in Z45's CSV-style quoting. Returns the
/// record count, header excluded.
pub fn csv<W: Write>(
    w: &mut W,
    target_bytes: u64,
    rows: u64,
    cols: usize,
    quoted_per_mille: u64,
    sep: char,
) -> io::Result<u64> {
    use std::fmt::Write as _;
    let mut line = (0..cols).map(|j| format!("c{j}")).collect::<Vec<_>>().join(&sep.to_string()) + "\n";
    w.write_all(line.as_bytes())?;
    let (mut written, mut n) = (line.len() as u64, 0u64);
    while n < rows && written < target_bytes {
        line.clear();
        for j in 0..cols as u64 {
            if j > 0 {
                line.push(sep);
            }
            let k = n * cols as u64 + j;
            let _ = if (k.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32) % 1000 < quoted_per_mille {
                write!(line, "\"row {n} note{sep} with \"\"quotes\"\"\nand a second line\"")
            } else {
                match j % 4 {
                    0 => write!(line, "{}", k % 1_000_003),
                    1 => write!(line, "{}.{:02}", k % 10_000, k % 100),
                    2 => write!(line, "{}", WORDS[(k % 5) as usize]),
                    _ => write!(line, "2026-{:02}-{:02}", k % 12 + 1, k % 28 + 1),
                }
            };
        }
        line.push('\n');
        w.write_all(line.as_bytes())?;
        written += line.len() as u64;
        n += 1;
    }
    Ok(n)
}

/// A YAML sequence of records until `target_bytes`, with a comment every 100th and a block scalar every 50th.
/// Returns the record count.
pub fn yaml<W: Write>(w: &mut W, target_bytes: u64) -> io::Result<u64> {
    let (mut written, mut n) = (0u64, 0u64);
    while written < target_bytes {
        let mut item = String::new();
        if n % 100 == 0 {
            item += &format!("# records {n} to {}\n", n + 99);
        }
        item += &format!(
            "- id: {n}\n  ts: \"2026-10-20T12:{:02}:{:02}.{:03}Z\"\n  type: {}\n  msg: \"line {n:010}\"\n  tags: [{}, {}]\n",
            (n / 60_000) % 60,
            (n / 1000) % 60,
            n % 1000,
            TYPES[(n % 4) as usize],
            WORDS[(n % 5) as usize],
            WORDS[((n + 2) % 5) as usize]
        );
        if n % 50 == 0 {
            item += "  note: |\n    a block scalar,\n    over two lines\n";
        }
        w.write_all(item.as_bytes())?;
        written += item.len() as u64;
        n += 1;
    }
    Ok(n)
}

/// Markdown sections until `target_bytes`: a heading, a paragraph with inline markup and a link, a list, a code
/// fence and a table. Returns the section count.
pub fn markdown<W: Write>(w: &mut W, target_bytes: u64) -> io::Result<u64> {
    let (mut written, mut n) = (0u64, 0u64);
    while written < target_bytes {
        let word = WORDS[(n % 5) as usize];
        let section = format!(
            "## Section {n}\n\nParagraph {n} has *emphasis*, **strong** text, `code` and a [link](#section-{}). \
             It runs on for a while, as prose does, about {word}.\n\n- item one of {n}\n- item two, {word}\n  \
             - a nested item\n\n```rust\nfn section_{n}() -> u64 {{\n    {n}\n}}\n```\n\n\
             | key | value |\n|---|---|\n| n | {n} |\n| word | {word} |\n\n",
            n.saturating_sub(1)
        );
        w.write_all(section.as_bytes())?;
        written += section.len() as u64;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonl_lines_are_exact_length_and_valid_json() {
        let mut out = Vec::new();
        let n = jsonl(&mut out, 10_000, 200).unwrap();
        assert_eq!(n, 50);
        assert_eq!(out.len(), 10_000);
        for line in out.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
            assert_eq!(line.len(), 199);
            let s = std::str::from_utf8(line).unwrap();
            assert!(s.starts_with("{\"ts\":\"2026-10-20T"), "{s}");
            assert!(s.ends_with("\"}"), "{s}");
        }
    }

    #[test]
    fn huge_record_has_the_requested_payload() {
        let mut out = Vec::new();
        huge_record(&mut out, 1000).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.ends_with("\"}\n"));
        assert_eq!(s.matches('a').count(), 1000);
    }

    #[test]
    fn json_docs_reach_the_target_and_count_their_elements() {
        for shape in ["records", "wide", "deep", "numbers"] {
            let mut out = Vec::new();
            let n = json_doc(&mut out, shape, 100_000).unwrap();
            assert!(out.len() >= 100_000, "{shape}");
            assert_eq!(out.windows(2).filter(|w| w == b",\n").count() as u64 + 1, n, "{shape}");
            let (open, close): (&[u8], &[u8]) = if shape == "wide" { (b"{\n", b"\n}\n") } else { (b"[\n", b"\n]\n") };
            assert!(out.starts_with(open) && out.ends_with(close), "{shape}");
        }
        assert!(json_doc(&mut Vec::new(), "nope", 1).is_err());
    }

    #[test]
    fn csv_has_a_header_typed_columns_and_quoted_newlines() {
        let mut out = Vec::new();
        assert_eq!(csv(&mut out, u64::MAX, 2_000, 20, 10, ',').unwrap(), 2_000);
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("c0,c1,c2,c3,"), "{}", &s[..40]);
        let quoted = s.matches(" note, with \"\"quotes\"\"\nand a second line\"").count();
        assert!((250..=550).contains(&quoted), "{quoted} quoted fields of 40,000");
        assert!(s.contains(",alpha,") && s.contains(",2026-"));
    }

    #[test]
    fn csv_stops_at_the_byte_target() {
        let mut out = Vec::new();
        let n = csv(&mut out, 100_000, u64::MAX, 20, 10, ',').unwrap();
        assert!(out.len() >= 100_000 && out.len() < 102_000, "{}", out.len());
        assert!(n > 500, "{n}");
    }

    #[test]
    fn tsv_separates_with_tabs_and_quotes_like_csv() {
        let mut out = Vec::new();
        assert_eq!(csv(&mut out, u64::MAX, 2_000, 20, 10, '\t').unwrap(), 2_000);
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("c0\tc1\tc2\t") && !s.contains(','), "{}", &s[..40]);
        assert!(s.contains(" note\t with \"\"quotes\"\"\nand a second line\""));
    }

    #[test]
    fn yaml_and_markdown_reach_the_target_and_count_what_they_wrote() {
        let mut out = Vec::new();
        let n = yaml(&mut out, 100_000).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.len() >= 100_000 && s.starts_with("# records 0 to 99\n- id: 0\n"), "{}", &s[..40]);
        assert_eq!(s.matches("\n- id: ").count() as u64, n);
        assert_eq!(s.matches("  note: |\n").count() as u64, n.div_ceil(50));
        let mut out = Vec::new();
        let n = markdown(&mut out, 100_000).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.len() >= 100_000 && s.starts_with("## Section 0\n\n"), "{}", &s[..40]);
        assert_eq!(s.matches("## Section ").count() as u64, n);
        assert_eq!(s.matches("```").count() as u64, 2 * n);
    }
}
