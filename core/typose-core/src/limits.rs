//! Plan C4: a caller-controlled number crosses every boundary as a JS number (`f64` in napi, never `u32` or
//! `i64`, which wrap, truncate or turn NaN into 0) and is checked to be a finite integer within its declared
//! range before any conversion. It's never clamped or wrapped.
use crate::doc::MAX_SAFE;
use crate::pages::MAX_ITEMS;

/// Every numeric protocol field and its inclusive range. The core host checks requests against this same table,
/// which it reads through the addon, so the two sides can't drift.
pub const RANGES: [(&str, u64, u64); 11] = [
    ("id", 1, MAX_SAFE),       // a request id
    ("protocol", 0, MAX_SAFE), // the handshake's protocol version
    ("doc", 1, MAX_SAFE),      // a document id
    ("start", 0, MAX_SAFE),    // a line number
    ("count", 1, MAX_ITEMS as u64),
    ("gen", 1, u32::MAX as u64), // a document generation (spec §3.1); generations start at 1
    // A continuation token's fields (plan C3). The core checks the rest: the session and generation are current,
    // and the offset is a cut of the line.
    ("session", 1, MAX_SAFE),
    ("line", 0, MAX_SAFE),
    ("offset", 0, MAX_SAFE),
    // Plan C1: the renderer cache's reservation, and the test-hooks build's budget override, in bytes.
    ("bytes", 0, MAX_SAFE),
    // The core host's `os.totalmem()`, which sets the ledger's limit.
    ("totalmem", 1, MAX_SAFE),
];

/// `x` as an integer, if it's a finite whole number within `field`'s range. The error names the field. A field with no
/// range is an error too, never a panic: a panic in a napi call kills the core host.
pub fn int(field: &str, x: f64) -> Result<u64, String> {
    let Some(&(_, min, max)) = RANGES.iter().find(|r| r.0 == field) else {
        return Err(format!("{field} has no range"));
    };
    // Both bounds are at most 2^53 − 1, so they're exact as f64 and the cast below is exact too.
    if x.is_finite() && x.fract() == 0.0 && x >= min as f64 && x <= max as f64 {
        Ok(x as u64)
    } else {
        Err(format!("{field} must be an integer in [{min}, {max}], not {x}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// C4's table: each field against the hostile values, plus min, max and max + 1.
    #[test]
    fn every_field_takes_only_integers_in_its_range() {
        let two32 = 4_294_967_296f64;
        for (field, min, max) in RANGES {
            let (min, max) = (min as f64, max as f64);
            let cases = [
                f64::NAN,
                f64::INFINITY,
                f64::NEG_INFINITY,
                -1.0,
                0.5,
                two32,
                two32 + 1.0,
                2f64.powi(53),
                1e12,
                min,
                max,
                max + 1.0,
            ];
            for x in cases {
                let valid = x.is_finite() && x.fract() == 0.0 && (min..=max).contains(&x);
                match int(field, x) {
                    Ok(n) => assert!(valid && n as f64 == x, "{field} accepted {x}"),
                    Err(e) => assert!(!valid && e.starts_with(field), "{field} refused {x}: {e}"),
                }
            }
            assert!(int(field, min).is_ok() && int(field, max).is_ok() && int(field, max + 1.0).is_err());
        }
        assert_eq!(int("count", 1e12), Err("count must be an integer in [1, 1024], not 1000000000000".into()));
        assert!(int("start", 2f64.powi(53)).is_err()); // past MAX_SAFE: not exact in JavaScript
    }

    /// A name without a row is refused, not a panic: on the JS thread a panic kills the core host (M5 PR 1).
    #[test]
    fn a_field_without_a_range_is_an_error() {
        assert_eq!(int("no-such-field", 1.0), Err("no-such-field has no range".into()));
    }

    /// Every `int("…")` in the addon names a row, so none is refused at run time for want of one.
    #[test]
    fn every_addon_call_site_names_a_range() {
        let mut sites = 0;
        for file in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../typose-node/src")).unwrap() {
            let path = file.unwrap().path();
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            for (at, _) in source.match_indices("int(\"") {
                if source[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_') {
                    continue; // print(", hint("
                }
                let name = source[at + 5..].split('"').next().unwrap();
                assert!(RANGES.iter().any(|r| r.0 == name), "{}: int(\"{name}\") has no range", path.display());
                sites += 1;
            }
        }
        assert!(sites > 50, "only {sites} call sites found: the scan is broken");
    }
}
