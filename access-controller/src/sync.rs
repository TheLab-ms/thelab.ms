//! Conway sync: every 10 s (or on demand) POST buffered swipe events to
//! `/api/fobs` and receive the authorized fob list, or 304 if the ETag
//! still matches.

use alloc::boxed::Box;
use core::fmt::Write as _;
use embassy_net::tcp::TcpSocket;
use embassy_net::{IpEndpoint, Stack};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::mutex::Mutex;
use embassy_time::Duration;
use embedded_io_async::Write;
use heapless::{Deque, String as HString, Vec as HVec};

use crate::{FOBS, MAX_FOBS};

const MAX_EVENTS: usize = 20;
const RESPONSE_CAP: usize = MAX_FOBS * 12 + 1024;
const SOCKET_RX: usize = 2048;
const SOCKET_TX: usize = 1024;

/// Socket and response buffers, allocated once at startup so a sync never
/// allocates (a failed allocation would panic and reboot the controller).
pub struct Buffers {
    rx: Box<[u8]>,
    tx: Box<[u8]>,
    response: Box<[u8]>,
}

impl Buffers {
    pub fn new() -> Self {
        Self {
            rx: alloc::vec![0; SOCKET_RX].into_boxed_slice(),
            tx: alloc::vec![0; SOCKET_TX].into_boxed_slice(),
            response: alloc::vec![0; RESPONSE_CAP].into_boxed_slice(),
        }
    }
}

#[derive(Clone, Copy)]
pub struct AccessEvent {
    pub fob: u32,
    pub allowed: bool,
}

/// Events awaiting upload. `front_seq` numbers the oldest queued event so a
/// sync can acknowledge exactly the events it sent, even if overflow drops
/// some of them mid-request.
pub struct Events {
    queue: Deque<AccessEvent, MAX_EVENTS>,
    front_seq: u64,
}

pub static EVENTS: Mutex<CriticalSectionRawMutex, Events> = Mutex::new(Events {
    queue: Deque::new(),
    front_seq: 0,
});

impl Events {
    pub fn push(&mut self, event: AccessEvent) {
        // Conway drops fob 0, so don't spend a queue slot on it.
        if event.fob == 0 {
            log::warn!("events: not queuing fob 0");
            return;
        }
        if self.queue.is_full() {
            log::warn!("events: buffer full, dropping oldest");
            self.queue.pop_front();
            self.front_seq += 1;
        }
        let _ = self.queue.push_back(event);
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    fn ack(&mut self, end_seq: u64) {
        while self.front_seq < end_seq && self.queue.pop_front().is_some() {
            self.front_seq += 1;
        }
    }
}

/// One sync round-trip. Events are only removed after the server accepts them.
pub async fn sync(
    stack: Stack<'static>,
    etag: &mut HString<64>,
    buffers: &mut Buffers,
) -> Result<(), &'static str> {
    let (host, port) = crate::conway_server();

    let mut body: HString<1024> = HString::new();
    let end_seq = {
        let events = EVENTS.lock().await;
        let _ = body.push('[');
        for (i, e) in events.queue.iter().enumerate() {
            let sep = if i > 0 { "," } else { "" };
            let _ = write!(
                body,
                r#"{}{{"fob":{},"allowed":{}}}"#,
                sep, e.fob, e.allowed
            );
        }
        let _ = body.push(']');
        events.front_seq + events.queue.len() as u64
    };

    let mut request: HString<256> = HString::new();
    let _ = write!(
        request,
        "POST /api/fobs HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n",
        host,
        body.len()
    );
    if !etag.is_empty() {
        let _ = write!(request, "If-None-Match: {}\r\n", etag);
    }
    let _ = request.push_str("\r\n");

    let mut socket = TcpSocket::new(stack, &mut buffers.rx, &mut buffers.tx);
    socket.set_timeout(Some(Duration::from_secs(10)));
    let result = exchange(
        &mut socket,
        IpEndpoint::new(host.into(), port),
        &[request.as_bytes(), body.as_bytes()],
        &mut buffers.response,
    )
    .await;
    socket.abort();
    let len = result?;

    let response = core::str::from_utf8(&buffers.response[..len]).map_err(|_| "invalid utf-8")?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or("malformed response")?;
    let status = head.split(' ').nth(1).unwrap_or("");
    match status {
        "304" => {
            EVENTS.lock().await.ack(end_seq);
        }
        "200" => {
            let new_fobs = parse_fob_list(body)?;
            log::info!("sync: received {} fobs", new_fobs.len());
            *FOBS.lock().await = new_fobs.clone();
            EVENTS.lock().await.ack(end_seq);

            // Compare against flash, not RAM, so a failed save is retried.
            // The ETag is only adopted once the list is persisted; until
            // then every sync gets a 200 and tries again.
            etag.clear();
            if !crate::cache_store::is_current(&new_fobs) {
                crate::cache_store::save(&new_fobs).map_err(|e| {
                    log::error!("sync: cache save failed: {}", e);
                    "cache save failed"
                })?;
                log::info!("sync: cache saved");
            }
            let etag_header = head.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim().eq_ignore_ascii_case("etag").then(|| v.trim())
            });
            let _ = etag.push_str(etag_header.unwrap_or(""));
        }
        _ => return Err("unexpected status"),
    }
    Ok(())
}

/// Send `request` and read the full response into `response`, returning its length.
async fn exchange(
    socket: &mut TcpSocket<'_>,
    remote: IpEndpoint,
    request: &[&[u8]],
    response: &mut [u8],
) -> Result<usize, &'static str> {
    socket.connect(remote).await.map_err(|_| "connect failed")?;
    for part in request {
        socket.write_all(part).await.map_err(|_| "write failed")?;
    }
    let mut len = 0;
    loop {
        if len == response.len() {
            return Err("response too large");
        }
        match socket.read(&mut response[len..]).await {
            Ok(0) => return Ok(len),
            Ok(n) => len += n,
            Err(_) => return Err("read failed"),
        }
    }
}

/// Parse a bare JSON array of u32s. Any other element is an error, so a
/// format change can never be mistaken for an empty list.
fn parse_fob_list(json: &str) -> Result<HVec<u32, MAX_FOBS>, &'static str> {
    let inner = json
        .trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .ok_or("fob list is not a JSON array")?;
    let mut fobs = HVec::new();
    for part in inner.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let fob = part.parse().map_err(|_| "fob list element is not a u32")?;
        fobs.push(fob).map_err(|_| "fob list exceeds MAX_FOBS")?;
    }
    Ok(fobs)
}
