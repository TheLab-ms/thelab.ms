//! Over-the-air firmware update: stream an image into the inactive app slot,
//! then point `otadata` at it. Verification is limited to the ESP image magic
//! byte and the declared length.

use alloc::boxed::Box;

use embedded_storage::Storage;
use esp_bootloader_esp_idf::{
    ota::{Ota, Slot},
    partitions::{
        read_partition_table, AppPartitionSubType, DataPartitionSubType, PartitionType,
        PARTITION_TABLE_MAX_LEN,
    },
};
use esp_storage::FlashStorage;

const SECTOR: usize = 4096;

/// Find the inactive app slot and return its `(offset, size)`. When
/// `activate` is set, also select it as the slot to boot next.
fn next_slot(flash: &mut FlashStorage, activate: bool) -> Result<(u32, u32), &'static str> {
    let mut pt_buf = Box::new([0u8; PARTITION_TABLE_MAX_LEN]);
    let pt =
        read_partition_table(flash, pt_buf.as_mut_slice()).map_err(|_| "partition table error")?;
    let otadata = pt
        .find_partition(PartitionType::Data(DataPartitionSubType::Ota))
        .ok()
        .flatten()
        .ok_or("no otadata partition")?;

    let mut region = otadata.as_embedded_storage(flash);
    let mut ota = Ota::new(&mut region).map_err(|_| "otadata error")?;
    // Erased otadata (fresh USB flash) reports `None`, but the bootloader runs
    // ota_0 in that state, so the next slot must be ota_1.
    let next = match ota.current_slot().map_err(|_| "otadata error")? {
        Slot::Slot0 | Slot::None => Slot::Slot1,
        Slot::Slot1 => Slot::Slot0,
    };
    let subtype = match next {
        Slot::Slot1 => AppPartitionSubType::Ota1,
        _ => AppPartitionSubType::Ota0,
    };
    let app = pt
        .find_partition(PartitionType::App(subtype))
        .ok()
        .flatten()
        .ok_or("no target app slot")?;

    if activate {
        ota.set_current_slot(next)
            .map_err(|_| "otadata write failed")?;
    }
    Ok((app.offset(), app.len()))
}

pub struct OtaWriter {
    flash: FlashStorage,
    base: u32,
    expected: u32,
    flushed: u32,
    buf_len: usize,
    buf: Box<[u8; SECTOR]>,
}

impl OtaWriter {
    pub fn begin(content_length: u32) -> Result<Self, &'static str> {
        let mut flash = FlashStorage::new();
        let (base, size) = next_slot(&mut flash, false)?;
        if content_length == 0 || content_length > size {
            return Err("image size invalid for slot");
        }
        log::info!("ota: writing {} bytes at 0x{:X}", content_length, base);
        Ok(Self {
            flash,
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
        next_slot(&mut self.flash, true)?;
        Ok(())
    }
}
