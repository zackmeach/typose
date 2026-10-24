//! Plan C1: the byte-accounted ledger (Z34, Z47). One per process: document data across every open file stays within
//! its limit, a quarter of physical RAM, which the core host sets from `os.totalmem()` (C4). Every allocation of
//! document data is reserved here before it's made, and released when its owner drops the memory (`Reservation`).
//!
//! Transient work runs in pooled slots, reserved when the limit is set: `INDEX_SLOTS` index jobs and `PAGE_SLOTS` page
//! reads. A job waits for a free slot rather than failing, so Raw stays usable whatever the documents hold (Z47). The
//! pool also holds `JS_PAGES`, for the core host's JavaScript copies of pages.
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::index::INDEX_TEMP;
use crate::pages::PAGE_TEMP;

/// Until the core host sets a limit, nothing can be reserved. Unit tests share one process and set none.
const UNSET: u64 = if cfg!(test) { u64::MAX / 2 } else { 0 };

/// The ledger's counters. The process has one (`LEDGER`); tests make their own.
pub(crate) struct Ledger {
    limit: AtomicU64,
    used: AtomicU64,
    high: AtomicU64,
    /// Bumped by every change to what's reserved or what the pool holds free, so a reader of `in_use` can tell that
    /// nothing moved while it looked (the counting-allocator test's contemporaneous check).
    version: AtomicU64,
}

static LEDGER: Ledger = Ledger::new(UNSET);

/// A reservation the ledger refused: it would have taken the total past the limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverBudget {
    pub asked: u64,
    pub free: u64,
}

impl std::fmt::Display for OverBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the memory budget is full: {} bytes asked, {} free", self.asked, self.free)
    }
}

impl std::error::Error for OverBudget {}

impl Ledger {
    pub(crate) const fn new(limit: u64) -> Ledger {
        Ledger {
            limit: AtomicU64::new(limit),
            used: AtomicU64::new(0),
            high: AtomicU64::new(0),
            version: AtomicU64::new(0),
        }
    }

    /// Adds `n` unless that takes the total past the limit. One atomic update, so threads can't overshoot together.
    pub(crate) fn charge(&self, n: u64) -> Result<(), OverBudget> {
        if n == 0 {
            return Ok(());
        }
        let limit = self.limit.load(SeqCst);
        match self.used.fetch_update(SeqCst, SeqCst, |u| u.checked_add(n).filter(|&t| t <= limit)) {
            Ok(before) => {
                self.version.fetch_add(1, SeqCst);
                self.high.fetch_max(before + n, SeqCst);
                Ok(())
            }
            Err(used) => Err(OverBudget { asked: n, free: limit.saturating_sub(used) }),
        }
    }

    pub(crate) fn release(&self, n: u64) {
        if n > 0 {
            self.used.fetch_sub(n, SeqCst);
            self.version.fetch_add(1, SeqCst);
        }
    }
}

/// Bytes charged to the ledger until this drops or shrinks. Its owner keeps it beside the memory it pays for, declared
/// after it, so the memory is freed first.
#[derive(Debug, Default)]
#[must_use]
pub struct Reservation(u64);

impl Reservation {
    /// Nothing reserved yet.
    pub const fn none() -> Reservation {
        Reservation(0)
    }

    pub fn new(bytes: u64) -> Result<Reservation, OverBudget> {
        LEDGER.charge(bytes)?;
        Ok(Reservation(bytes))
    }

    pub fn bytes(&self) -> u64 {
        self.0
    }

    pub fn grow(&mut self, n: u64) -> Result<(), OverBudget> {
        LEDGER.charge(n)?;
        self.0 += n;
        Ok(())
    }

    pub fn shrink(&mut self, n: u64) {
        let n = n.min(self.0);
        LEDGER.release(n);
        self.0 -= n;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        LEDGER.release(self.0);
    }
}

/// Sets the limit: the core host's `floor(totalmem / 4)` (Z34), or the test-hooks build's override. The pool is reserved
/// the first time, so a limit that can't hold it is refused.
pub fn set_limit(limit: u64) -> Result<(), OverBudget> {
    LEDGER.limit.store(limit, SeqCst);
    reserve_pool()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Totals {
    pub limit: u64,
    /// Everything charged, the pool's free slots included.
    pub used: u64,
    /// The most `used` has been.
    pub high: u64,
    /// The pool's bytes, reserved once the limit is set.
    pub pool: u64,
}

pub fn totals() -> Totals {
    let pool = if POOL_RESERVED.load(SeqCst) { pool_bytes() } else { 0 };
    Totals { limit: LEDGER.limit.load(SeqCst), used: LEDGER.used.load(SeqCst), high: LEDGER.high.load(SeqCst), pool }
}

/// What's charged, less the pool's free slots and `JS_PAGES`: the reservations paying for Rust's memory now (the
/// counting-allocator test's comparison, which sees no JavaScript heap). With the ledger's version, so a caller can retry
/// when something moved while it read.
pub fn in_use() -> (u64, u64) {
    loop {
        let v = LEDGER.version.load(SeqCst);
        let free = if POOL_RESERVED.load(SeqCst) {
            FREE[0].load(SeqCst) * slot_bytes(Work::Index) + FREE[1].load(SeqCst) * slot_bytes(Work::Page) + JS_PAGES
        } else {
            0
        };
        let used = LEDGER.used.load(SeqCst);
        if LEDGER.version.load(SeqCst) == v {
            return (used - free, v);
        }
    }
}

/// Starts the high-water mark again from what's charged now (the test-hooks build's per-cycle peaks, plan C1).
pub fn reset_high() {
    LEDGER.high.store(LEDGER.used.load(SeqCst), SeqCst);
}

pub fn version() -> u64 {
    LEDGER.version.load(SeqCst)
}

/// Transient work, run in one of the pool's slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Work {
    /// An index job's block buffer and checkpoints in waiting (`index::INDEX_TEMP`).
    Index,
    /// A page read's buffers, text and maps in Rust (`pages::PAGE_TEMP`).
    Page,
}

pub const INDEX_SLOTS: u64 = 2;
/// libuv's default thread pool, where napi's page reads run. A bigger pool's extra reads wait for a slot.
pub const PAGE_SLOTS: u64 = 4;

const fn slot_bytes(work: Work) -> u64 {
    match work {
        Work::Index => INDEX_TEMP as u64,
        Work::Page => PAGE_TEMP as u64,
    }
}

/// Plan C1's (c) and (d): the core host's JavaScript page objects and their structured-clone copies, until V8 collects
/// them. Neither is released when a page is answered, so they're held for the process's life. Measured (plan §7, PR 6):
/// at most 10.3 MiB above the core host's post-GC heap over 400 pages of the densest maps, answered as fast as they came.
pub const JS_PAGES: u64 = 32 << 20;

pub const fn pool_bytes() -> u64 {
    INDEX_SLOTS * slot_bytes(Work::Index) + PAGE_SLOTS * slot_bytes(Work::Page) + JS_PAGES
}

static FREE: [AtomicU64; 2] = [AtomicU64::new(INDEX_SLOTS), AtomicU64::new(PAGE_SLOTS)];
static POOL_RESERVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Held only to reserve the pool once. Never held while allocating.
static POOL: Mutex<Option<Reservation>> = Mutex::new(None);
static WAIT: Mutex<()> = Mutex::new(());
static FREED: Condvar = Condvar::new();

fn reserve_pool() -> Result<(), OverBudget> {
    let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
    if pool.is_none() {
        *pool = Some(Reservation::new(pool_bytes())?);
        POOL_RESERVED.store(true, SeqCst);
        LEDGER.version.fetch_add(1, SeqCst);
    }
    Ok(())
}

/// Why a job got no slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoSlot {
    /// Cancelled while it waited.
    Cancelled,
    /// No limit has been set that holds the pool.
    Budget(OverBudget),
}

/// One job's slot in the pool, until it drops.
#[derive(Debug)]
pub struct Slot(Work);

impl Drop for Slot {
    fn drop(&mut self) {
        FREE[self.0 as usize].fetch_add(1, SeqCst);
        LEDGER.version.fetch_add(1, SeqCst);
        let _lock = WAIT.lock().unwrap_or_else(|e| e.into_inner());
        FREED.notify_all();
    }
}

/// A slot for `work`, waiting while the pool has none free (plan C1: transient work queues). `cancelled` is checked
/// every few ms while it waits.
pub fn slot(work: Work, cancelled: &dyn Fn() -> bool) -> Result<Slot, NoSlot> {
    reserve_pool().map_err(NoSlot::Budget)?;
    let free = &FREE[work as usize];
    let mut lock = WAIT.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if cancelled() {
            return Err(NoSlot::Cancelled);
        }
        if free.fetch_update(SeqCst, SeqCst, |n| n.checked_sub(1)).is_ok() {
            LEDGER.version.fetch_add(1, SeqCst);
            return Ok(Slot(work));
        }
        lock = FREED.wait_timeout(lock, Duration::from_millis(5)).unwrap_or_else(|e| e.into_inner()).0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    /// Plan C1: reservations from many threads at once never take the total past the limit, and every release returns
    /// its bytes. On a private ledger: the process's is shared by every test here.
    #[test]
    fn threaded_reserve_and_release_never_overshoots() {
        let ledger = Arc::new(Ledger::new(1_000_000));
        let threads: Vec<_> = (0..8u64)
            .map(|t| {
                let ledger = ledger.clone();
                std::thread::spawn(move || {
                    let (mut held, mut refused) = (Vec::new(), 0u64);
                    for i in 0..20_000u64 {
                        let n = 1 + (i * 7919 + t * 104_729) % 50_000;
                        match ledger.charge(n) {
                            Ok(()) => held.push(n),
                            Err(e) => {
                                assert_eq!(e.asked, n);
                                refused += 1;
                            }
                        }
                        assert!(ledger.used.load(SeqCst) <= 1_000_000, "over the limit");
                        if i % 3 == 0
                            && let Some(n) = held.pop()
                        {
                            ledger.release(n);
                        }
                    }
                    for n in held {
                        ledger.release(n);
                    }
                    refused
                })
            })
            .collect();
        let refused: u64 = threads.into_iter().map(|t| t.join().unwrap()).sum();
        assert!(refused > 0, "the limit was never reached: the test proves nothing");
        assert!(ledger.high.load(SeqCst) <= 1_000_000, "peak {} over the limit", ledger.high.load(SeqCst));
        assert_eq!(ledger.used.load(SeqCst), 0);
    }

    /// The real ledger, from many threads: each thread's reservations come back in full. Other tests reserve at the
    /// same time, so only this test's own bytes are checked, through what each reservation says it holds.
    #[test]
    fn reservations_grow_shrink_and_return_their_bytes() {
        let threads: Vec<_> = (0..8)
            .map(|t| {
                std::thread::spawn(move || {
                    let mut r = Reservation::new(t).unwrap();
                    for i in 0..1000 {
                        r.grow(i).unwrap();
                        r.shrink(i / 2);
                    }
                    let want = t + (0..1000).map(|i| i - i / 2).sum::<u64>();
                    assert_eq!(r.bytes(), want);
                    r.shrink(u64::MAX); // never more than it holds
                    assert_eq!(r.bytes(), 0);
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
    }

    /// Plan C1: transient work waits for a slot, and a cancel ends the wait.
    #[test]
    fn a_job_waits_for_a_slot_and_a_cancel_ends_the_wait() {
        let held: Vec<Slot> = (0..INDEX_SLOTS).map(|_| slot(Work::Index, &|| false).unwrap()).collect();
        let cancel = Arc::new(AtomicBool::new(false));
        let waiting = {
            let cancel = cancel.clone();
            std::thread::spawn(move || slot(Work::Index, &|| cancel.load(SeqCst)).map(|_| ()))
        };
        std::thread::sleep(Duration::from_millis(30));
        assert!(!waiting.is_finished(), "a slot was granted while none was free");
        cancel.store(true, SeqCst);
        assert_eq!(waiting.join().unwrap(), Err(NoSlot::Cancelled));
        let next = std::thread::spawn(|| slot(Work::Index, &|| false).map(|_| ()));
        std::thread::sleep(Duration::from_millis(30));
        drop(held);
        assert_eq!(next.join().unwrap(), Ok(()));
    }
}
