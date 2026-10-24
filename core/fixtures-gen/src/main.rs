use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone());
    let num = |name: &str, default: u64| flag(name).map(|v| v.parse().expect("number")).unwrap_or(default);
    let out = flag("--out").expect("--out <path>");
    if let Some(dir) = Path::new(&out).parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut w = BufWriter::with_capacity(8 << 20, File::create(&out)?);
    match args.first().map(String::as_str) {
        Some("jsonl") => {
            let n = fixtures_gen::jsonl(&mut w, num("--bytes", 1 << 30), num("--line", 200) as usize)?;
            eprintln!("{out}: {n} lines");
        }
        Some("jsonl-huge-first") => {
            fixtures_gen::huge_record(&mut w, num("--first", 200 << 20))?;
            let n = fixtures_gen::jsonl(&mut w, num("--bytes", 1 << 20), num("--line", 200) as usize)?;
            eprintln!("{out}: 1 huge record + {n} lines");
        }
        Some(kind @ ("csv" | "tsv")) => {
            let rows = num("--rows", u64::MAX);
            let bytes = num("--bytes", if rows == u64::MAX { 100 << 20 } else { u64::MAX });
            let sep = if kind == "tsv" { '\t' } else { ',' };
            let n = fixtures_gen::csv(&mut w, bytes, rows, num("--cols", 20) as usize, num("--quoted", 10), sep)?;
            eprintln!("{out}: header + {n} records");
        }
        Some("yaml") => {
            let n = fixtures_gen::yaml(&mut w, num("--bytes", 100 << 20))?;
            eprintln!("{out}: {n} records");
        }
        Some("md") => {
            let n = fixtures_gen::markdown(&mut w, num("--bytes", 100 << 20))?;
            eprintln!("{out}: {n} sections");
        }
        Some("json") => {
            let shape = flag("--shape").unwrap_or_else(|| "records".into());
            let n = fixtures_gen::json_doc(&mut w, &shape, num("--bytes", 1 << 30))?;
            eprintln!("{out}: {n} elements ({shape})");
        }
        other => panic!("unknown fixture kind {other:?}"),
    }
    w.flush()
}
