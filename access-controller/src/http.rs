//! Minimal single-connection HTTP server on port 80, with no authentication
//! (trusted LAN only).
//!
//! - `GET /`         status page
//! - `POST /unlock`  pulse the door
//! - `POST /ota`     upload a firmware image (`build-ota.sh`) and reboot into it

use core::fmt::Write as _;
use embassy_net::tcp::TcpSocket;
use embassy_net::Stack;
use embassy_time::{Duration, Instant, Timer};
use embedded_io_async::Write;
use heapless::String as HString;

use crate::ota::OtaWriter;
use crate::sync::EVENTS;
use crate::{FOBS, LAST_SWIPE, MANUAL_UNLOCK_FOB};

#[embassy_executor::task]
pub async fn http_task(stack: Stack<'static>) {
    stack.wait_config_up().await;
    let mut rx_buf = [0u8; 4096];
    let mut tx_buf = [0u8; 2048];
    loop {
        let mut socket = TcpSocket::new(stack, &mut rx_buf, &mut tx_buf);
        socket.set_timeout(Some(Duration::from_secs(5)));
        if let Err(e) = socket.accept(80).await {
            log::warn!("http: accept failed: {:?}", e);
            continue;
        }
        handle(&mut socket, stack).await;
        let _ = socket.flush().await;
        socket.close();
    }
}

async fn handle(socket: &mut TcpSocket<'_>, stack: Stack<'static>) {
    let mut buf = [0u8; 2048];
    let mut len = 0;
    let header_end = loop {
        if len == buf.len() {
            return send(
                socket,
                "431 Request Header Fields Too Large",
                "text/plain",
                b"",
            )
            .await;
        }
        match socket.read(&mut buf[len..]).await {
            Ok(0) | Err(_) => return,
            Ok(n) => len += n,
        }
        if let Some(pos) = buf[..len].windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let headers = core::str::from_utf8(&buf[..header_end]).unwrap_or("");
    let mut request_line = headers.split(' ');
    let method = request_line.next().unwrap_or("");
    let path = request_line.next().unwrap_or("");
    log::info!("http: {} {}", method, path);

    match (method, path) {
        ("GET", "/") => send_status_page(socket, stack).await,
        ("POST", "/unlock") => {
            crate::grant(MANUAL_UNLOCK_FOB).await;
            send(socket, "200 OK", "text/plain", b"ok: door pulsed\n").await;
        }
        ("POST", "/ota") => {
            let content_length = headers.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if !name.eq_ignore_ascii_case("content-length") {
                    return None;
                }
                value.trim().parse().ok()
            });
            match content_length {
                Some(n) => handle_ota(socket, n, &buf[header_end..len]).await,
                None => send(socket, "411 Length Required", "text/plain", b"").await,
            }
        }
        _ => send(socket, "404 Not Found", "text/plain", b"not found\n").await,
    }
}

async fn handle_ota(socket: &mut TcpSocket<'_>, content_length: u32, leftover: &[u8]) {
    socket.set_timeout(Some(Duration::from_secs(60)));
    match receive_image(socket, content_length, leftover).await {
        Ok(()) => {
            send(
                socket,
                "200 OK",
                "text/plain",
                b"ok: rebooting into new firmware\n",
            )
            .await;
            let _ = socket.flush().await;
            socket.close();
            log::warn!("ota: complete, rebooting");
            Timer::after(Duration::from_millis(250)).await;
            esp_hal::system::software_reset();
        }
        Err(e) => {
            log::warn!("ota: {}", e);
            let mut msg: HString<96> = HString::new();
            let _ = writeln!(msg, "ota error: {}", e);
            send(socket, "400 Bad Request", "text/plain", msg.as_bytes()).await;
        }
    }
}

async fn receive_image(
    socket: &mut TcpSocket<'_>,
    content_length: u32,
    leftover: &[u8],
) -> Result<(), &'static str> {
    let mut writer = OtaWriter::begin(content_length)?;
    writer.write(leftover)?;
    let mut chunk = [0u8; 2048];
    while writer.remaining() > 0 {
        let want = (writer.remaining() as usize).min(chunk.len());
        match socket.read(&mut chunk[..want]).await {
            Ok(0) | Err(_) => return Err("connection lost mid-upload"),
            Ok(n) => writer.write(&chunk[..n])?,
        }
        // Flash writes block; let the access task run between sectors.
        embassy_futures::yield_now().await;
    }
    writer.finish()
}

async fn send(socket: &mut TcpSocket<'_>, status: &str, content_type: &str, body: &[u8]) {
    let mut header: HString<192> = HString::new();
    let _ = write!(
        header,
        "HTTP/1.1 {}\r\nContent-Type: {}; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        content_type,
        body.len()
    );
    let _ = socket.write_all(header.as_bytes()).await;
    let _ = socket.write_all(body).await;
}

async fn send_status_page(socket: &mut TcpSocket<'_>, stack: Stack<'static>) {
    let now = Instant::now();
    let (host, port) = crate::conway_server();

    let mut ip: HString<32> = HString::new();
    match stack.config_v4() {
        Some(cfg) => {
            let _ = write!(ip, "{}", cfg.address);
        }
        None => {
            let _ = ip.push_str("n/a");
        }
    }

    let mut last: HString<96> = HString::new();
    match *LAST_SWIPE.lock().await {
        None => {
            let _ = last.push_str("(none)");
        }
        Some(s) => {
            let (class, text) = if s.allowed {
                ("ok", "Granted")
            } else {
                ("err", "Denied")
            };
            if s.fob == MANUAL_UNLOCK_FOB {
                let _ = last.push_str("manual unlock");
            } else {
                let _ = write!(last, "fob {}", s.fob);
            }
            let _ = write!(
                last,
                " &middot; <span class=\"{}\">{}</span> &middot; {}s ago",
                class,
                text,
                (now - s.at).as_secs()
            );
        }
    }

    let heap = esp_alloc::HEAP.stats();
    let mut body: HString<3072> = HString::new();
    let _ = write!(
        body,
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Access Controller</title>\
<style>body{{font-family:system-ui,sans-serif;margin:2rem;max-width:40rem}}\
table{{border-collapse:collapse}}th,td{{text-align:left;padding:.25rem .75rem;border-bottom:1px solid #ddd}}\
progress{{width:100%}}.err{{color:#b00}}.ok{{color:#070}}</style></head><body>\
<h1>Access Controller</h1><table>\
<tr><th>Firmware</th><td>v{firmware}</td></tr>\
<tr><th>Uptime</th><td>{uptime} s</td></tr>\
<tr><th>WiFi</th><td>{ssid} ({ip})</td></tr>\
<tr><th>Conway server</th><td>{host}:{port}</td></tr>\
<tr><th>Cached fobs</th><td>{fobs}</td></tr>\
<tr><th>Pending events</th><td>{events}</td></tr>\
<tr><th>Heap</th><td>{heap_used} / {heap_size} bytes (peak {heap_peak})</td></tr>\
<tr><th>Last swipe</th><td>{last}</td></tr>\
</table>\
<h2>Door</h2><p><button id=\"unlock\">Unlock door</button> <span id=\"unlockstatus\"></span></p>\
<h2>Firmware update</h2>\
<form id=\"ota\"><input type=\"file\" id=\"otafile\" accept=\".bin\" required> <button>Upload</button></form>\
<p><progress id=\"otaprog\" value=\"0\" max=\"100\"></progress></p><p id=\"otastatus\"></p>\
<script>\
const $=id=>document.getElementById(id);\
$('unlock').onclick=()=>{{$('unlockstatus').textContent='unlocking...';\
fetch('/unlock',{{method:'POST'}}).then(r=>r.text()).then(t=>{{$('unlockstatus').textContent=t;setTimeout(()=>location.reload(),800);}})\
.catch(()=>$('unlockstatus').textContent='unlock failed');}};\
$('ota').onsubmit=e=>{{e.preventDefault();const f=$('otafile').files[0],x=new XMLHttpRequest();\
x.open('POST','/ota');x.upload.onprogress=ev=>$('otaprog').value=ev.loaded/ev.total*100;\
x.onload=()=>$('otastatus').textContent=x.responseText;\
x.onerror=()=>$('otastatus').textContent='upload failed';x.send(f);}};\
</script></body></html>",
        firmware = env!("CARGO_PKG_VERSION"),
        uptime = now.as_secs(),
        ssid = crate::SSID,
        ip = ip,
        host = host,
        port = port,
        fobs = FOBS.lock().await.len(),
        events = EVENTS.lock().await.len(),
        heap_used = heap.current_usage,
        heap_size = heap.size,
        heap_peak = heap.max_usage,
        last = last,
    );
    send(socket, "200 OK", "text/html", body.as_bytes()).await;
}
