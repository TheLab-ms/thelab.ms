//! Async Wiegand 26/34-bit reader.

use embassy_futures::select::{select, Either};
use embassy_time::{with_timeout, Duration, Instant};
use esp_hal::gpio::Input;

const DEBOUNCE: Duration = Duration::from_micros(500);
const BIT_TIMEOUT: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Copy)]
pub struct WiegandRead {
    facility: u32,
    card: u32,
    data: u32,
}

impl WiegandRead {
    /// H10301 fob format: facility code + 5-digit card ID.
    pub fn to_fob(self) -> u32 {
        self.facility * 100_000 + self.card
    }

    /// NFC UID derived by byte-reversing the raw data field.
    pub fn to_nfc_uid(self) -> u32 {
        self.data.swap_bytes()
    }
}

/// Decode a frame of `count` bits: leading even parity over the upper half
/// of the data bits, trailing odd parity over the lower half. Facility is
/// always bits 23..16 of the data field, matching the legacy fob database
/// (strict H10304 would use bits 31..16 for 34-bit frames).
fn decode(raw: u64, count: u32) -> Option<WiegandRead> {
    let data_bits = count - 2;
    let half = data_bits / 2;
    let data = ((raw >> 1) & ((1u64 << data_bits) - 1)) as u32;
    let leading = ((raw >> (count - 1)) & 1) as u32;
    let trailing = (raw & 1) as u32;
    let upper = data >> half;
    let lower = data & ((1 << half) - 1);
    if upper.count_ones() % 2 != leading || lower.count_ones() % 2 == trailing {
        return None;
    }
    Some(WiegandRead {
        facility: (data >> 16) & 0xFF,
        card: data & 0xFFFF,
        data,
    })
}

pub struct Wiegand<'a> {
    d0: Input<'a>,
    d1: Input<'a>,
}

impl<'a> Wiegand<'a> {
    pub fn new(d0: Input<'a>, d1: Input<'a>) -> Self {
        Self { d0, d1 }
    }

    /// Wait for a complete transmission: collect bits until none arrive
    /// within `BIT_TIMEOUT`, then decode by bit count.
    pub async fn read(&mut self) -> Option<WiegandRead> {
        let mut bits = self.wait_for_bit().await as u64;
        let mut count = 1;
        let mut last_bit = Instant::now();

        while let Ok(bit) = with_timeout(BIT_TIMEOUT, self.wait_for_bit()).await {
            let now = Instant::now();
            if now.duration_since(last_bit) < DEBOUNCE {
                continue;
            }
            last_bit = now;
            if count >= 64 {
                break;
            }
            bits = (bits << 1) | bit as u64;
            count += 1;
        }

        match count {
            26 | 34 => decode(bits, count),
            _ => {
                log::warn!("wiegand: unknown format ({} bits)", count);
                None
            }
        }
    }

    /// D0 falling edge = 0 bit, D1 falling edge = 1 bit. The reader idles
    /// high and the non-inverting input buffer preserves that polarity.
    async fn wait_for_bit(&mut self) -> u8 {
        match select(
            self.d0.wait_for_falling_edge(),
            self.d1.wait_for_falling_edge(),
        )
        .await
        {
            Either::First(()) => 0,
            Either::Second(()) => 1,
        }
    }
}
