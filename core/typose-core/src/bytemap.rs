//! Byte maps (spec §3.2): every text slice the core sends maps its UTF-16 offsets back to source bytes,
//! so the renderer never re-encodes text to find offsets.
//!
//! A slice is a run of *elements*: `units` UTF-16 units that came from `bytes` source bytes (a char,
//! one U+FFFD for 1–3 malformed bytes, an entity, an escape, a dropped `\r`). Endpoints snap outward:
//! - `start_byte(u)` is the first byte of the first element that isn't wholly before `u`;
//! - `end_byte(u)` is the byte just past the last element that isn't wholly after `u`.
//!
//! An element over units `[s, t)` is wholly before `u` if `t < u`, or `t == u` and `s < u`; wholly after
//! `u` if `s > u`, or `s == u` and `t > u`. So an offset inside a surrogate pair snaps back (start) or
//! forward (end) to the pair's edges, and a zero-unit element at `u` lies inside both: a selection never
//! drops a source byte it touches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ByteMap {
    /// byte(u) = start + u * unit_bytes at every element boundary. Every element is one unit, except the
    /// two-unit elements (surrogate pairs) starting at the sorted offsets in `pairs`, inside which offsets snap.
    /// Windows-1252 and ASCII UTF-8 have unit_bytes 1, UTF-16 has 2.
    Uniform { start: u64, unit_bytes: u32, units: u32, pairs: Vec<u32> },
    /// `points` sorted by UTF-16 offset; points[0] = (0, start). Between points, one UTF-16 unit = one source byte.
    /// `end` = (total UTF-16 units, byte offset just past the slice).
    /// Points may share an offset: the first one there is `start_byte`, the last is `end_byte`.
    Breakpoints { points: Vec<(u32, u64)>, end: (u32, u64) },
}

pub struct MapBuilder {
    start: u64,
    units: u32,
    bytes: u64,
    /// True while every element is 1 or 2 units of `unit_bytes` bytes each.
    uniform: bool,
    unit_bytes: Option<u32>,
    pairs: Vec<u32>,
    points: Vec<(u32, u64)>,
    /// The most source bytes the map will cover, when known: its lists are sized from it once (plan C1).
    most: Option<usize>,
}

impl MapBuilder {
    pub fn new(start: u64) -> Self {
        let (pairs, points) = (Vec::new(), Vec::new());
        MapBuilder { start, units: 0, bytes: 0, uniform: true, unit_bytes: None, pairs, points, most: None }
    }

    /// A builder for at most `most` source bytes of a Raw decode, whose elements are a char or one U+FFFD. Its lists
    /// are allocated once, when first needed, at their most for that many bytes: a pair (2 units) takes 4 bytes, and
    /// the densest breakpoints are pairs too, 3 per 4 bytes, after the first.
    pub fn with_capacity(start: u64, most: usize) -> Self {
        MapBuilder { most: Some(most), ..MapBuilder::new(start) }
    }

    /// Append one display element: `units` UTF-16 units that came from `bytes` source bytes
    /// (a char, an entity like "&amp;" → push(1, 5), a backslash escape "\*" → push(1, 2), a dropped "\r" → push(0, 1)).
    pub fn push(&mut self, units: u32, bytes: u64) {
        if units == 0 && bytes == 0 {
            return;
        }
        if self.uniform {
            let k = self.unit_bytes.or_else(|| u32::try_from(bytes / u64::from(units.max(1))).ok());
            match k {
                Some(k) if (units == 1 || units == 2) && bytes == u64::from(units) * u64::from(k) => {
                    self.unit_bytes = Some(k);
                    if units == 2 {
                        if let (Some(most), 0) = (self.most, self.pairs.capacity()) {
                            self.pairs.reserve_exact(most / 4);
                        }
                        self.pairs.push(self.units);
                    }
                    self.units += units;
                    self.bytes += bytes;
                    return;
                }
                _ => self.switch_to_points(),
            }
        }
        self.add_points(units, bytes);
        self.units += units;
        self.bytes += bytes;
    }

    /// Uniform when every push had the same bytes-per-unit ratio (and was 1 or 2 units), else Breakpoints.
    pub fn finish(mut self) -> ByteMap {
        if self.uniform {
            let unit_bytes = self.unit_bytes.unwrap_or(1);
            return ByteMap::Uniform { start: self.start, unit_bytes, units: self.units, pairs: self.pairs };
        }
        let end = (self.units, self.start + self.bytes);
        if self.points.len() > 1 && self.points.last() == Some(&end) {
            self.points.pop(); // `end` already says it
        }
        ByteMap::Breakpoints { points: self.points, end }
    }

    /// Replays the uniform elements so far as points; runs once, when the first non-uniform element arrives.
    fn switch_to_points(&mut self) {
        let k = u64::from(self.unit_bytes.unwrap_or(1));
        let (total, pairs) = (self.units, std::mem::take(&mut self.pairs));
        let mut points = Vec::with_capacity(self.most.map_or(1, |most| 1 + 3 * most / 4));
        points.push((0, self.start));
        (self.uniform, self.units, self.bytes, self.points) = (false, 0, 0, points);
        let mut pairs = pairs.into_iter().peekable();
        while self.units < total {
            let n = if pairs.next_if_eq(&self.units).is_some() { 2 } else { 1 };
            self.add_points(n, u64::from(n) * k);
            self.units += n;
            self.bytes += u64::from(n) * k;
        }
    }

    /// Points for one element at the current position. Invariant: the 1:1 run from the last point reaches
    /// the current position, so a one-unit, one-byte element needs nothing.
    fn add_points(&mut self, units: u32, bytes: u64) {
        let (u, b) = (self.units, self.start + self.bytes);
        let e = b + bytes;
        match units {
            0 => {
                if self.points.last().map(|p| p.0) != Some(u) {
                    self.points.push((u, b));
                }
                self.points.push((u, e));
            }
            1 if bytes == 1 => {}
            1 => self.points.push((u + 1, e)),
            n => {
                for k in 1..n {
                    self.points.push((u + k, b));
                    self.points.push((u + k, e));
                }
                self.points.push((u + n, e));
            }
        }
    }
}

impl ByteMap {
    /// Selection START at UTF-16 offset u → source byte. Inside a multi-unit element (a surrogate pair) or a
    /// multi-byte element, snaps BACK to the element's first byte. Offsets past the end clamp to it.
    pub fn start_byte(&self, u: u32) -> u64 {
        match self {
            ByteMap::Uniform { start, unit_bytes, units, pairs } => {
                let u = u.min(*units);
                let u = if u > 0 && pairs.binary_search(&(u - 1)).is_ok() { u - 1 } else { u };
                start + u64::from(u) * u64::from(*unit_bytes)
            }
            ByteMap::Breakpoints { points, end } => {
                let u = u.min(end.0);
                let i = points.partition_point(|p| p.0 < u);
                match points.get(i) {
                    Some(&(pu, pb)) if pu == u => pb,
                    None if end.0 == u => end.1,
                    _ => run(points[i - 1], u),
                }
            }
        }
    }

    /// Selection END at u → source byte. Inside an element, snaps FORWARD to just past the element.
    pub fn end_byte(&self, u: u32) -> u64 {
        match self {
            ByteMap::Uniform { start, unit_bytes, units, pairs } => {
                let u = u.min(*units);
                let u = if u > 0 && pairs.binary_search(&(u - 1)).is_ok() { u + 1 } else { u };
                start + u64::from(u) * u64::from(*unit_bytes)
            }
            ByteMap::Breakpoints { points, end } => {
                if u >= end.0 {
                    return end.1;
                }
                run(points[points.partition_point(|p| p.0 <= u) - 1], u)
            }
        }
    }

    pub fn units(&self) -> u32 {
        match self {
            ByteMap::Uniform { units, .. } => *units,
            ByteMap::Breakpoints { end, .. } => end.0,
        }
    }

    /// The wire form (plan C2): every number but `start` and `end` is a `u32`, and breakpoint bytes are relative
    /// to `start`, so a map travels as one `Uint32Array`. A slice covers at most `pages::PIECE_BYTES` source bytes.
    pub fn to_wire(&self) -> WireMap {
        match self {
            ByteMap::Uniform { start, unit_bytes, units, pairs } => WireMap {
                uniform: true,
                start: *start,
                end: start + u64::from(*units) * u64::from(*unit_bytes),
                units: *units,
                unit_bytes: *unit_bytes,
                points: pairs.clone(),
            },
            ByteMap::Breakpoints { points, end } => WireMap {
                uniform: false,
                start: points[0].1,
                end: end.1,
                units: end.0,
                unit_bytes: 0,
                points: {
                    let mut wire = Vec::with_capacity(2 * points.len()); // plan C1: sized once
                    wire.extend(points.iter().flat_map(|&(u, b)| [u, (b - points[0].1) as u32]));
                    wire
                },
            },
        }
    }
}

/// `ByteMap` as it crosses to JavaScript. `points` holds a uniform map's pair starts, or a breakpoint map's
/// `(unit, byte - start)` pairs flattened, so `points[0..2]` is `(0, 0)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireMap {
    pub uniform: bool,
    pub start: u64,
    pub end: u64,
    pub units: u32,
    pub unit_bytes: u32,
    pub points: Vec<u32>,
}

/// The 1:1 run from point `p`, evaluated at `u`.
fn run((pu, pb): (u32, u64), u: u32) -> u64 {
    pb + u64::from(u - pu)
}

/// The definition in the module docs, applied by brute force: `(start_byte, end_byte)` for every offset
/// `0..=units`. Test reference only: it never looks at a `MapBuilder` or a `ByteMap`.
#[cfg(test)]
pub(crate) fn naive_endpoints(start: u64, elements: &[(u32, u64)]) -> Vec<(u64, u64)> {
    let mut spans = Vec::new(); // (s, t, first byte, byte past)
    let (mut s, mut b) = (0u32, start);
    for &(units, bytes) in elements {
        spans.push((s, s + units, b, b + bytes));
        s += units;
        b += bytes;
    }
    (0..=s)
        .map(|u| {
            let before = |&&(s, t, _, _): &&(u32, u32, u64, u64)| t < u || (t == u && s < u);
            let after = |&&(s, t, _, _): &&(u32, u32, u64, u64)| s > u || (s == u && t > u);
            let lo = spans.iter().find(|x| !before(x)).map_or(b, |x| x.2);
            let hi = spans.iter().rev().find(|x| !after(x)).map_or(start, |x| x.3);
            (lo, hi)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn build(start: u64, elements: &[(u32, u64)]) -> ByteMap {
        let mut b = MapBuilder::new(start);
        for &(units, bytes) in elements {
            b.push(units, bytes);
        }
        b.finish()
    }

    fn endpoints(map: &ByteMap, upto: u32) -> Vec<(u64, u64)> {
        (0..=upto).map(|u| (map.start_byte(u), map.end_byte(u))).collect()
    }

    #[test]
    fn ascii_runs_are_uniform_and_cost_nothing() {
        let map = build(10, &[(1, 1); 5]);
        assert_eq!(map, ByteMap::Uniform { start: 10, unit_bytes: 1, units: 5, pairs: vec![] });
        assert_eq!((map.start_byte(3), map.end_byte(3), map.end_byte(99)), (13, 13, 15));
    }

    #[test]
    fn one_multibyte_char_costs_one_point() {
        // "aé b": only é (1 unit, 2 bytes) needs a point.
        let map = build(100, &[(1, 1), (1, 2), (1, 1), (1, 1)]);
        assert_eq!(map, ByteMap::Breakpoints { points: vec![(0, 100), (2, 103)], end: (4, 105) });
        assert_eq!(endpoints(&map, 4), vec![(100, 100), (101, 101), (103, 103), (104, 104), (105, 105)]);
    }

    #[test]
    fn utf16_surrogate_pairs_stay_uniform_and_snap() {
        // "a😀b" in UTF-16: every element is 2 bytes per unit.
        let map = build(2, &[(1, 2), (2, 4), (1, 2)]);
        assert_eq!(map, ByteMap::Uniform { start: 2, unit_bytes: 2, units: 4, pairs: vec![1] });
        assert_eq!((map.start_byte(2), map.end_byte(2)), (4, 8)); // inside the pair
    }

    #[test]
    fn a_surrogate_pair_in_utf8_snaps_back_and_forward() {
        let map = build(0, &[(1, 1), (2, 4), (1, 1)]); // "a😀b"
        assert_eq!(endpoints(&map, 4), vec![(0, 0), (1, 1), (1, 5), (5, 5), (6, 6)]);
    }

    #[test]
    fn entities_escapes_and_a_dropped_cr_are_representable() {
        // "&amp;\*x\r\ny" rendered as "&*x\ny": entity, escape, x, dropped \r, \n, y.
        let map = build(0, &[(1, 5), (1, 2), (1, 1), (0, 1), (1, 1), (1, 1)]);
        assert_eq!(map.units(), 5);
        assert_eq!(endpoints(&map, 5), vec![(0, 0), (5, 5), (7, 7), (8, 9), (10, 10), (11, 11)]);
    }

    fn element() -> impl Strategy<Value = (u32, u64)> {
        prop_oneof![
            8 => Just((1, 1)),
            2 => (2u64..=4).prop_map(|b| (1, b)), // multi-byte char, or U+FFFD for 2–3 bytes
            1 => Just((2, 4)),                     // surrogate pair
            1 => Just((1, 2)),                     // UTF-16 BMP char
            1 => (5u64..=9).prop_map(|b| (1, b)),  // entity
            1 => (1u64..=3).prop_map(|b| (0, b)),  // dropped \r, markers
            1 => Just((1, 0)),                     // inserted text
            1 => (3u32..=4).prop_map(|n| (n, 7)),  // a multi-unit rewrite
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]
        #[test]
        fn endpoints_match_the_naive_definition(
            start in prop_oneof![Just(0u64), 0u64..1 << 40],
            elements in prop::collection::vec(element(), 0..40),
            uniform_k in 1u64..=3,
            uniform in any::<bool>(),
        ) {
            // Half the cases are uniform-shaped streams, so both variants get exercised.
            let elements: Vec<(u32, u64)> = if uniform {
                elements.iter().map(|&(n, _)| if n == 2 { (2, 2 * uniform_k) } else { (1, uniform_k) }).collect()
            } else {
                elements
            };
            let map = build(start, &elements);
            let naive = naive_endpoints(start, &elements);
            let units = naive.len() as u32 - 1;
            prop_assert_eq!(map.units(), units);
            prop_assert_eq!(endpoints(&map, units), naive.clone());
            prop_assert_eq!((map.start_byte(units + 3), map.end_byte(units + 3)), naive[units as usize]);
        }
    }
}
