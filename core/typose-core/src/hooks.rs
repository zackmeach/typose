//! The test-hooks build's hooks (plan m8), compiled only with the `test-hooks` feature: a delay before every chunk
//! read from disk (plan C5's acceptance), and debug stats that count what a document holds (C6).
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

/// Open byte stores, so open file handles: one per open document generation (plan C6).
pub static HANDLES: AtomicUsize = AtomicUsize::new(0);
/// Index jobs whose thread hasn't ended.
pub static JOBS: AtomicUsize = AtomicUsize::new(0);
/// Page reads (napi tasks) not yet settled.
pub static TASKS: AtomicUsize = AtomicUsize::new(0);

static READ_DELAY_MS: AtomicU64 = AtomicU64::new(0);

/// Counts one of something in `counter` for as long as it lives.
pub struct Live(&'static AtomicUsize);

impl Live {
    pub fn new(counter: &'static AtomicUsize) -> Live {
        counter.fetch_add(1, Ordering::Relaxed);
        Live(counter)
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

pub fn count(counter: &AtomicUsize) -> usize {
    counter.load(Ordering::Relaxed)
}

/// Sets the delay before each chunk read from disk. Plan C4: a whole number of ms in [0, 10000], never clamped.
pub fn set_read_delay(ms: f64) -> Result<(), String> {
    READ_DELAY_MS.store(delay_ms(ms)?, Ordering::Relaxed);
    Ok(())
}

fn delay_ms(ms: f64) -> Result<u64, String> {
    match ms.is_finite() && ms.fract() == 0.0 && (0.0..=10_000.0).contains(&ms) {
        true => Ok(ms as u64),
        false => Err(format!("read delay must be a whole number of ms in [0, 10000], not {ms}")),
    }
}

pub(crate) fn read_delay() {
    let ms = READ_DELAY_MS.load(Ordering::Relaxed);
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checked on its own: setting a delay here would slow every other test's reads.
    #[test]
    fn the_read_delay_takes_only_whole_ms_in_range() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 0.5, 10_001.0, 2f64.powi(32), 1e12] {
            assert!(delay_ms(bad).is_err(), "took {bad}");
        }
        for good in [0.0, 1.0, 10_000.0] {
            assert_eq!(delay_ms(good), Ok(good as u64));
        }
    }
}
