//! Access controller firmware: reads Wiegand credentials, authorizes them
//! against the fob list synced from Conway, and pulses the door relay.

#![no_std]
#![no_main]
#![allow(static_mut_refs)] // Required for ESP32 heap initialization

esp_bootloader_esp_idf::esp_app_desc!();

mod cache_store;
mod http;
mod ota;
mod sync;
mod wiegand;

extern crate alloc;

use core::mem::MaybeUninit;
use core::net::Ipv4Addr;
use core::sync::atomic::{AtomicU32, Ordering};
use embassy_futures::select::{select, select3, Either3};
use embassy_net::{Config as NetConfig, DhcpConfig, Stack, StackResources};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_sync::mutex::Mutex;
use embassy_sync::signal::Signal;
use embassy_time::{with_timeout, Duration, Instant, Timer};
use esp_hal::clock::CpuClock;
use esp_hal::gpio::{Input, InputConfig, Level, Output, OutputConfig, Pull};
use esp_hal::time::Duration as HalDuration;
use esp_hal::timer::timg::{MwdtStage, MwdtStageAction, TimerGroup, Wdt};
use esp_radio::wifi::{ClientConfig, ModeConfig, WifiController, WifiDevice};
use heapless::{String as HString, Vec as HVec};
use static_cell::StaticCell;

use crate::sync::{AccessEvent, EVENTS};
use crate::wiegand::{Wiegand, WiegandRead};

// Build-time configuration, validated by build.rs (see network.env.example).
pub const SSID: &str = env!("CONWAY_SSID");
const PASSWORD: &str = env!("CONWAY_PASSWORD");
const CONWAY_HOST: &str = env!("CONWAY_HOST");
const CONWAY_PORT: &str = env!("CONWAY_PORT");

pub fn conway_server() -> (Ipv4Addr, u16) {
    (CONWAY_HOST.parse().unwrap(), CONWAY_PORT.parse().unwrap())
}

pub const MAX_FOBS: usize = 512;

/// Fob value recorded for manual unlocks via HTTP. Outside the Wiegand-26
/// card-number range, so it can't collide with a real swipe.
pub const MANUAL_UNLOCK_FOB: u32 = u32::MAX;

/// How long after a denial a sync can still retroactively grant access.
const RECHECK_WINDOW: Duration = Duration::from_secs(10);

/// Fob list from the last successful Conway sync.
pub static FOBS: Mutex<CriticalSectionRawMutex, HVec<u32, MAX_FOBS>> = Mutex::new(HVec::new());

#[derive(Clone, Copy)]
pub struct LastSwipe {
    pub fob: u32,
    pub allowed: bool,
    pub at: Instant,
}

pub static LAST_SWIPE: Mutex<CriticalSectionRawMutex, Option<LastSwipe>> = Mutex::new(None);

#[derive(Clone, Copy)]
enum Feedback {
    Granted,
    Denied,
}

static WIEGAND_CHANNEL: Channel<CriticalSectionRawMutex, WiegandRead, 16> = Channel::new();
static SYNC_REQUEST: Signal<CriticalSectionRawMutex, ()> = Signal::new();
/// Number of syncs started; `SYNC_COMPLETE` carries the finished sync's number.
static SYNC_STARTED: AtomicU32 = AtomicU32::new(0);
static SYNC_COMPLETE: Signal<CriticalSectionRawMutex, u32> = Signal::new();
static DOOR: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static READER_FEEDBACK: Signal<CriticalSectionRawMutex, Feedback> = Signal::new();

static STACK_RESOURCES: StaticCell<StackResources<4>> = StaticCell::new();

type Watchdog = Wdt<esp_hal::peripherals::TIMG1<'static>>;

#[esp_rtos::main]
async fn main(spawner: embassy_executor::Spawner) {
    let peripherals = esp_hal::init(esp_hal::Config::default().with_cpu_clock(CpuClock::max()));

    // Raising the CPU clock changes UART0's divisor; reconfigure it so log
    // output stays readable at 115200 baud. Leaked to keep it configured.
    let console = esp_hal::uart::UartTx::new(
        peripherals.UART0,
        esp_hal::uart::Config::default().with_baudrate(115_200),
    )
    .expect("UART0 console reconfig");
    core::mem::forget(console);
    esp_println::logger::init_logger(log::LevelFilter::Info);
    log::info!("access controller starting");

    const HEAP_SIZE: usize = 72 * 1024;
    static mut HEAP: MaybeUninit<[u8; HEAP_SIZE]> = MaybeUninit::uninit();
    unsafe {
        esp_alloc::HEAP.add_region(esp_alloc::HeapRegion::new(
            HEAP.as_mut_ptr() as *mut u8,
            HEAP_SIZE,
            esp_alloc::MemoryCapability::Internal.into(),
        ));
    }
    // DRAM the ROM only uses during boot. Wi-Fi alone can fill most of the
    // first region, and an allocation failure panics and reboots.
    esp_alloc::heap_allocator!(#[unsafe(link_section = ".dram2_uninit")] size: 96 * 1024);

    // The scheduler must start before esp_radio::init().
    esp_rtos::start(TimerGroup::new(peripherals.TIMG0).timer0);

    // Resets the system unless access_task feeds it at least every 30 s.
    let mut wdt = TimerGroup::new(peripherals.TIMG1).wdt;
    wdt.set_timeout(MwdtStage::Stage0, HalDuration::from_secs(30));
    wdt.set_stage_action(MwdtStage::Stage0, MwdtStageAction::ResetSystem);
    wdt.enable();

    *FOBS.lock().await = cache_store::load();
    log::info!("cache: loaded {} fobs from flash", FOBS.lock().await.len());

    // Pin map: see HARDWARE.md. Wiegand inputs are driven by a Schmitt buffer
    // and outputs drive NPN low-side switches (HIGH = energized).
    let no_pull = InputConfig::default().with_pull(Pull::None);
    let wiegand = Wiegand::new(
        Input::new(peripherals.GPIO25, no_pull),
        Input::new(peripherals.GPIO33, no_pull),
    );
    let door = Output::new(peripherals.GPIO12, Level::Low, OutputConfig::default());
    let reader_led = Output::new(peripherals.GPIO26, Level::Low, OutputConfig::default());
    let reader_beep = Output::new(peripherals.GPIO27, Level::Low, OutputConfig::default());
    let status_led = Output::new(peripherals.GPIO14, Level::Low, OutputConfig::default());

    // Door control depends only on the flash cache, so start it before the
    // radio and keep it running even if the radio fails to initialize.
    spawner.must_spawn(wiegand_task(wiegand));
    spawner.must_spawn(access_task(wdt));
    spawner.must_spawn(door_task(door));
    spawner.must_spawn(reader_feedback_task(reader_led, reader_beep));

    let radio = match esp_radio::init() {
        Ok(radio) => alloc::boxed::Box::leak(alloc::boxed::Box::new(radio)),
        Err(e) => {
            log::error!("radio init failed, running offline: {:?}", e);
            return;
        }
    };
    let (wifi, interfaces) = match esp_radio::wifi::new(radio, peripherals.WIFI, Default::default())
    {
        Ok(wifi) => wifi,
        Err(e) => {
            log::error!("wifi init failed, running offline: {:?}", e);
            return;
        }
    };

    // Advertise conway-XXXXXX as the DHCP hostname so the unit is easy to
    // find in the router's lease table.
    let mac = esp_radio::wifi::sta_mac();
    let mut dhcp = DhcpConfig::default();
    let mut hostname = HString::new();
    let _ = core::fmt::write(
        &mut hostname,
        format_args!("conway-{:02X}{:02X}{:02X}", mac[3], mac[4], mac[5]),
    );
    dhcp.hostname = Some(hostname);
    let seed = u64::from_le_bytes([mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], 0, 0]);
    let (stack, runner) = embassy_net::new(
        interfaces.sta,
        NetConfig::dhcpv4(dhcp),
        STACK_RESOURCES.init(StackResources::new()),
        seed,
    );

    spawner.must_spawn(net_task(runner));
    spawner.must_spawn(wifi_task(wifi));
    spawner.must_spawn(status_led_task(status_led, stack));
    spawner.must_spawn(sync_task(stack));
    spawner.must_spawn(http::http_task(stack));
}

#[embassy_executor::task]
async fn net_task(mut runner: embassy_net::Runner<'static, WifiDevice<'static>>) {
    runner.run().await;
}

#[embassy_executor::task]
async fn wifi_task(mut controller: WifiController<'static>) {
    let config = ModeConfig::Client(
        ClientConfig::default()
            .with_ssid(SSID.into())
            .with_password(PASSWORD.into()),
    );
    loop {
        if !controller.is_connected().unwrap_or(false) {
            log::info!("wifi: connecting to {}", SSID);
            let _ = controller.stop();
            Timer::after(Duration::from_millis(100)).await;
            if let Err(e) = controller
                .set_config(&config)
                .and_then(|_| controller.start())
                .and_then(|_| controller.connect())
            {
                log::error!("wifi: {:?}", e);
            }
            for _ in 0..100 {
                if controller.is_connected().unwrap_or(false) {
                    log::info!("wifi: connected");
                    break;
                }
                Timer::after(Duration::from_millis(200)).await;
            }
        }
        Timer::after(Duration::from_secs(5)).await;
    }
}

/// Forwards decoded reads to access_task. Returns to `read()` immediately so
/// back-to-back swipes aren't lost.
#[embassy_executor::task]
async fn wiegand_task(mut wiegand: Wiegand<'static>) {
    loop {
        if let Some(read) = wiegand.read().await {
            if WIEGAND_CHANNEL.try_send(read).is_err() {
                log::warn!("wiegand: channel full, read dropped");
            }
        }
    }
}

/// Look up a read in the synced cache by H10301 fob number, then NFC UID.
async fn authorize(read: &WiegandRead) -> Option<u32> {
    let fobs = FOBS.lock().await;
    [read.to_fob(), read.to_nfc_uid()]
        .into_iter()
        .find(|id| fobs.contains(id))
}

async fn record(fob: u32, allowed: bool) {
    EVENTS.lock().await.push(AccessEvent { fob, allowed });
    *LAST_SWIPE.lock().await = Some(LastSwipe {
        fob,
        allowed,
        at: Instant::now(),
    });
}

pub async fn grant(fob: u32) {
    log::info!("access GRANTED fob={}", fob);
    DOOR.signal(());
    READER_FEEDBACK.signal(Feedback::Granted);
    record(fob, true).await;
}

/// Authorization never waits on the network: reads are checked against the
/// cached list. On a miss, request a sync and re-check when one that started
/// after the swipe completes (so a newly-added fob works on first swipe).
/// Each miss that survives a sync adds a backoff (2, 4, 8, 8... s) during
/// which reads are ignored.
///
/// Also feeds the watchdog every loop, proving this task isn't stuck.
#[embassy_executor::task]
async fn access_task(mut wdt: Watchdog) {
    let mut pending: Option<(WiegandRead, Instant, u32)> = None;
    let mut backoff_until = Instant::MIN;
    let mut failures = 0u32;

    loop {
        wdt.feed();
        let event = select3(
            WIEGAND_CHANNEL.receive(),
            SYNC_COMPLETE.wait(),
            Timer::after(Duration::from_secs(10)),
        )
        .await;
        let now = Instant::now();
        match event {
            Either3::First(read) if now >= backoff_until => {
                if let Some(id) = authorize(&read).await {
                    failures = 0;
                    grant(id).await;
                } else {
                    log::warn!("access DENIED fob={}, rechecking after sync", read.to_fob());
                    READER_FEEDBACK.signal(Feedback::Denied);
                    record(read.to_fob(), false).await;
                    let next_sync = SYNC_STARTED.load(Ordering::Relaxed).wrapping_add(1);
                    pending = Some((read, now + RECHECK_WINDOW, next_sync));
                    SYNC_REQUEST.signal(());
                }
            }
            Either3::Second(sync) => {
                let Some((read, deadline, next_sync)) = pending else {
                    continue;
                };
                // A sync already in flight at swipe time may predate the fob.
                if (sync.wrapping_sub(next_sync) as i32) < 0 {
                    continue;
                }
                pending = None;
                if now > deadline {
                    continue;
                }
                if let Some(id) = authorize(&read).await {
                    failures = 0;
                    grant(id).await;
                } else {
                    failures += 1;
                    backoff_until = now + Duration::from_secs(1 << failures.min(3));
                    READER_FEEDBACK.signal(Feedback::Denied);
                }
            }
            _ => {}
        }
    }
}

/// Upper bound on one sync, in case a stalled peer keeps the socket's idle
/// timeout from firing (e.g. trickling bytes).
const SYNC_TIMEOUT: Duration = Duration::from_secs(30);

#[embassy_executor::task]
async fn sync_task(stack: Stack<'static>) {
    let mut buffers = sync::Buffers::new();
    stack.wait_config_up().await;
    let mut etag = HString::new();
    let mut logged_peak = 0;
    loop {
        let id = SYNC_STARTED.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        match with_timeout(SYNC_TIMEOUT, sync::sync(stack, &mut etag, &mut buffers)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::error!("sync: {}", e),
            Err(_) => log::error!("sync: timed out"),
        }
        SYNC_COMPLETE.signal(id);
        let heap = esp_alloc::HEAP.stats();
        if heap.max_usage > logged_peak {
            logged_peak = heap.max_usage;
            log::info!(
                "heap: {} used, new peak {} of {} bytes",
                heap.current_usage,
                heap.max_usage,
                heap.size
            );
        }
        select(Timer::after(Duration::from_secs(10)), SYNC_REQUEST.wait()).await;
    }
}

#[embassy_executor::task]
async fn door_task(mut door: Output<'static>) {
    loop {
        DOOR.wait().await;
        door.set_high();
        Timer::after(Duration::from_millis(200)).await;
        door.set_low();
    }
}

/// Granted: LED for 200 ms with a 100 ms beep. Denied: three short beeps.
#[embassy_executor::task]
async fn reader_feedback_task(mut led: Output<'static>, mut beep: Output<'static>) {
    let ms = |n| Timer::after(Duration::from_millis(n));
    loop {
        match READER_FEEDBACK.wait().await {
            Feedback::Granted => {
                led.set_high();
                beep.set_high();
                ms(100).await;
                beep.set_low();
                ms(100).await;
                led.set_low();
            }
            Feedback::Denied => {
                for _ in 0..3 {
                    beep.set_high();
                    ms(100).await;
                    beep.set_low();
                    ms(100).await;
                }
            }
        }
    }
}

/// Heartbeat: slow blink with an IP address, fast blink without.
#[embassy_executor::task]
async fn status_led_task(mut led: Output<'static>, stack: Stack<'static>) {
    loop {
        let period = if stack.is_config_up() { 500 } else { 100 };
        Timer::after(Duration::from_millis(period)).await;
        led.toggle();
    }
}

#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    log::error!("PANIC: {}", info);
    esp_hal::system::software_reset()
}
