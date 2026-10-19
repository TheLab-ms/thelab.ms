//! Last-synced fob list persisted to the `cache` partition so authorized fobs
//! keep working after a reboot while the Conway server is unreachable.
//!
//! The partition's two 4 KiB sectors hold identical copies, each laid out as
//! `magic u32 | count u32 | count × fob u32 | checksum u32` (little-endian).
//! `save` rewrites the primary then the backup, so power loss mid-write
//! always leaves at least one valid copy; `load` takes the first that passes
//! its checksum.
//!
//! Copies are streamed through a small stack buffer so syncs never allocate.

use embedded_storage::nor_flash::{NorFlash, ReadNorFlash};
use esp_storage::{FlashStorage, FlashStorageError};
use heapless::Vec as HVec;

use crate::MAX_FOBS;

/// Start of the `cache` partition. Keep in sync with `partitions.csv`.
const BASE: u32 = 0x3E0000;
const SECTOR: u32 = 4096;
const SLOTS: [u32; 2] = [BASE, BASE + SECTOR];
const MAGIC: u32 = u32::from_le_bytes(*b"FOB2");
const FNV_OFFSET: u32 = 0x811C_9DC5;
const CHUNK_WORDS: usize = 32;

/// Word-aligned so esp-storage transfers it directly instead of staging it
/// through its own 4 KiB stack buffer.
#[repr(C, align(4))]
struct Chunk([u8; CHUNK_WORDS * 4]);

impl Chunk {
    fn new() -> Self {
        Self([0; CHUNK_WORDS * 4])
    }
}

fn checksum(hash: u32, bytes: &[u8]) -> u32 {
    bytes.iter().fold(hash, |h, &b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

fn word(buf: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(buf[i * 4..i * 4 + 4].try_into().unwrap())
}

fn read_slot(flash: &mut FlashStorage, base: u32) -> Option<HVec<u32, MAX_FOBS>> {
    let mut chunk = Chunk::new();
    let header = &mut chunk.0[..8];
    flash.read(base, header).ok()?;
    if word(header, 0) != MAGIC {
        return None;
    }
    let count = word(header, 1) as usize;
    if count > MAX_FOBS {
        return None;
    }
    let mut sum = checksum(FNV_OFFSET, header);

    let mut fobs = HVec::new();
    let mut offset = base + 8;
    while fobs.len() < count {
        let bytes = &mut chunk.0[..(count - fobs.len()).min(CHUNK_WORDS) * 4];
        flash.read(offset, bytes).ok()?;
        sum = checksum(sum, bytes);
        for i in 0..bytes.len() / 4 {
            let _ = fobs.push(word(bytes, i));
        }
        offset += bytes.len() as u32;
    }

    let stored = &mut chunk.0[..4];
    flash.read(offset, stored).ok()?;
    if word(stored, 0) != sum {
        log::warn!("cache: checksum mismatch at 0x{:X}", base);
        return None;
    }
    Some(fobs)
}

/// Erase the slot's sector, then program it in chunks. Bytes past the
/// checksum stay erased (0xFF).
fn write_slot(flash: &mut FlashStorage, base: u32, fobs: &[u32]) -> Result<(), FlashStorageError> {
    flash.erase(base, base + SECTOR)?;
    let mut chunk = Chunk::new();
    chunk.0[..4].copy_from_slice(&MAGIC.to_le_bytes());
    chunk.0[4..8].copy_from_slice(&(fobs.len() as u32).to_le_bytes());
    let mut sum = checksum(FNV_OFFSET, &chunk.0[..8]);
    flash.write(base, &chunk.0[..8])?;

    let mut offset = base + 8;
    for group in fobs.chunks(CHUNK_WORDS) {
        let bytes = &mut chunk.0[..group.len() * 4];
        for (dst, fob) in bytes.chunks_exact_mut(4).zip(group) {
            dst.copy_from_slice(&fob.to_le_bytes());
        }
        sum = checksum(sum, bytes);
        flash.write(offset, bytes)?;
        offset += bytes.len() as u32;
    }

    chunk.0[..4].copy_from_slice(&sum.to_le_bytes());
    flash.write(offset, &chunk.0[..4])
}

pub fn load() -> HVec<u32, MAX_FOBS> {
    let mut flash = FlashStorage::new();
    SLOTS
        .iter()
        .find_map(|&base| read_slot(&mut flash, base))
        .unwrap_or_default()
}

/// Whether both copies already hold `fobs`, so a save would be redundant.
pub fn is_current(fobs: &[u32]) -> bool {
    let mut flash = FlashStorage::new();
    SLOTS
        .iter()
        .all(|&base| read_slot(&mut flash, base).is_some_and(|s| s == fobs))
}

pub fn save(fobs: &[u32]) -> Result<(), &'static str> {
    if fobs.len() > MAX_FOBS {
        return Err("too many fobs");
    }
    let mut flash = FlashStorage::new();
    for base in SLOTS {
        write_slot(&mut flash, base, fobs).map_err(|_| "flash write failed")?;
        if read_slot(&mut flash, base).is_none_or(|s| s != fobs) {
            return Err("flash verify failed");
        }
    }
    Ok(())
}
