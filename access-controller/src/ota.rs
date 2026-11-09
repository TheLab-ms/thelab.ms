//! Over-the-air firmware update: stream an image into the app slot that is not
//! running, then point `otadata` at it. Verification is limited to the ESP
//! image magic byte and the declared length; the bootloader checks the image
//! and falls back to the running slot if it cannot load it.

use alloc::boxed::Box;

use embedded_storage::{ReadStorage, Storage};
use esp_bootloader_esp_idf::partitions::{
    read_partition_table, AppPartitionSubType, DataPartitionSubType, PartitionType,
    PARTITION_TABLE_MAX_LEN,
};
use esp_storage::FlashStorage;

const SECTOR: usize = 4096;

/// The two `otadata` entries, each in its own sector. The bootloader boots
/// app slot `(seq - 1) % 2` from the valid entry with the highest sequence.
const OTADATA_ENTRIES: [u32; 2] = [0, 0x1000];
const OTADATA_ENTRY_LEN: usize = 32;
const SEQ_UNSET: u32 = u32::MAX;
const STATE_UNDEFINED: u32 = u32::MAX;
const STATE_INVALID: u32 = 3;
const STATE_ABORTED: u32 = 4;

/// The checksum the ESP-IDF bootloader expects for an `otadata` entry:
/// `esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4)`.
fn otadata_crc(seq: u32) -> u32 {
    esp_rom_sys::rom::crc::crc32_le(u32::MAX, &seq.to_le_bytes())
}

/// Returns the sequence number of an entry the bootloader would accept.
fn valid_seq(entry: &[u8; OTADATA_ENTRY_LEN]) -> Option<u32> {
    let word = |at: usize| u32::from_le_bytes([entry[at], entry[at + 1], entry[at + 2], entry[at + 3]]);
    let (seq, state, crc) = (word(0), word(24), word(28));
    (seq != 0 && seq != SEQ_UNSET && crc == otadata_crc(seq) && state != STATE_INVALID && state != STATE_ABORTED)
        .then_some(seq)
}

/// Returns `(entry index, sequence)` of the entry the bootloader selects.
fn selected_entry(flash: &mut FlashStorage, otadata: u32) -> Result<Option<(usize, u32)>, &'static str> {
    let mut selected = None;
    for (index, offset) in OTADATA_ENTRIES.iter().enumerate() {
        let mut entry = [0u8; OTADATA_ENTRY_LEN];
        flash
            .read(otadata + offset, &mut entry)
            .map_err(|_| "otadata read failed")?;
        if let Some(seq) = valid_seq(&entry) {
            if selected.is_none_or(|(_, best)| seq > best) {
                selected = Some((index, seq));
            }
        }
    }
    Ok(selected)
}

/// The app slot the bootloader will boot. Without a valid entry it boots ota_0.
fn selected_slot(flash: &mut FlashStorage, otadata: u32) -> Result<u8, &'static str> {
    Ok(selected_entry(flash, otadata)?.map_or(0, |(_, seq)| ((seq - 1) % 2) as u8))
}

/// Select app slot `slot` (0 or 1) for the next boot, in the format the
/// bootloader validates, and confirm it reads back as selected.
fn select_slot(flash: &mut FlashStorage, otadata: u32, slot: u8) -> Result<(), &'static str> {
    let current = selected_entry(flash, otadata)?;
    if current.map_or(0, |(_, seq)| ((seq - 1) % 2) as u8) == slot {
        return Ok(());
    }
    // With two slots, the next sequence number always selects the other slot.
    // Write it over the entry the bootloader is not using.
    let (index, seq) = match current {
        Some((index, seq)) => (1 - index, seq.checked_add(1).ok_or("otadata sequence exhausted")?),
        None => (0, u32::from(slot) + 1),
    };
    let mut entry = [0xFFu8; OTADATA_ENTRY_LEN];
    entry[0..4].copy_from_slice(&seq.to_le_bytes());
    entry[24..28].copy_from_slice(&STATE_UNDEFINED.to_le_bytes());
    entry[28..32].copy_from_slice(&otadata_crc(seq).to_le_bytes());
    flash
        .write(otadata + OTADATA_ENTRIES[index], &entry)
        .map_err(|_| "otadata write failed")?;
    if selected_slot(flash, otadata)? != slot {
        return Err("otadata verify failed");
    }
    Ok(())
}

/// The app slot that is not running, as `(slot number, offset, size, otadata offset)`.
/// The running slot comes from the flash mapping, not `otadata`: the
/// bootloader may have fallen back from an image it could not load.
fn update_slot(flash: &mut FlashStorage) -> Result<(u8, u32, u32, u32), &'static str> {
    let mut pt_buf = Box::new([0u8; PARTITION_TABLE_MAX_LEN]);
    let pt =
        read_partition_table(flash, pt_buf.as_mut_slice()).map_err(|_| "partition table error")?;
    let otadata = pt
        .find_partition(PartitionType::Data(DataPartitionSubType::Ota))
        .ok()
        .flatten()
        .ok_or("no otadata partition")?;
    let booted = pt
        .booted_partition()
        .ok()
        .flatten()
        .ok_or("cannot determine the running app slot")?;
    let (slot, subtype) = match booted.partition_type() {
        PartitionType::App(AppPartitionSubType::Ota0) => (1, AppPartitionSubType::Ota1),
        PartitionType::App(AppPartitionSubType::Ota1) => (0, AppPartitionSubType::Ota0),
        _ => return Err("running from an unexpected app partition"),
    };
    let app = pt
        .find_partition(PartitionType::App(subtype))
        .ok()
        .flatten()
        .ok_or("no target app slot")?;
    Ok((slot, app.offset(), app.len(), otadata.offset()))
}

pub struct OtaWriter {
    flash: FlashStorage,
    slot: u8,
    otadata: u32,
    base: u32,
    expected: u32,
    flushed: u32,
    buf_len: usize,
    buf: Box<[u8; SECTOR]>,
}

impl OtaWriter {
    pub fn begin(content_length: u32) -> Result<Self, &'static str> {
        let mut flash = FlashStorage::new();
        let (slot, base, size, otadata) = update_slot(&mut flash)?;
        if content_length == 0 || content_length > size {
            return Err("image size invalid for slot");
        }
        log::info!("ota: writing {} bytes to ota_{} at 0x{:X}", content_length, slot, base);
        Ok(Self {
            flash,
            slot,
            otadata,
            base,
            expected: content_length,
            flushed: 0,
            buf_len: 0,
            buf: Box::new([0xFF; SECTOR]),
        })
    }

    pub fn remaining(&self) -> u32 {
        self.expected - self.flushed - self.buf_len as u32
    }

    /// Buffer `chunk`, writing whole sectors as they fill. `FlashStorage`
    /// erases the full sector on every write, so writes must be sector-sized.
    pub fn write(&mut self, mut chunk: &[u8]) -> Result<(), &'static str> {
        if chunk.len() as u32 > self.remaining() {
            return Err("received more bytes than Content-Length");
        }
        if self.flushed == 0 && self.buf_len == 0 && chunk.first().is_some_and(|&b| b != 0xE9) {
            return Err("not an ESP image (first byte != 0xE9)");
        }
        while !chunk.is_empty() {
            let n = chunk.len().min(SECTOR - self.buf_len);
            self.buf[self.buf_len..self.buf_len + n].copy_from_slice(&chunk[..n]);
            self.buf_len += n;
            chunk = &chunk[n..];
            if self.buf_len == SECTOR {
                self.flush()?;
            }
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), &'static str> {
        self.buf[self.buf_len..].fill(0xFF);
        self.flash
            .write(self.base + self.flushed, self.buf.as_slice())
            .map_err(|_| "flash write failed")?;
        self.flushed += self.buf_len as u32;
        self.buf_len = 0;
        Ok(())
    }

    /// Flush the final partial sector and boot the new slot on next reset.
    pub fn finish(mut self) -> Result<(), &'static str> {
        if self.remaining() != 0 {
            return Err("received fewer bytes than Content-Length");
        }
        if self.buf_len > 0 {
            self.flush()?;
        }
        select_slot(&mut self.flash, self.otadata, self.slot)
    }
}
