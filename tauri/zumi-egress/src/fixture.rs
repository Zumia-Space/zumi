//! A loopback HTTP/1.1 server for tests and goal harnesses (feature `fixture`). One thread per connection, `Connection:
//! close`, a handler closure answers each request. It counts every request it received, so a test can prove that a
//! refused request never reached it.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct FixtureReq {
    pub method: String,
    pub path: String,
    /// Lower-case names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl FixtureReq {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

pub enum FixtureResp {
    /// A whole body with a Content-Length.
    Full { status: u16, headers: Vec<(String, String)>, body: Vec<u8> },
    /// `Transfer-Encoding: chunked`; each chunk is sent after its delay (ms), so a reader sees them arrive one by one.
    Chunked { status: u16, headers: Vec<(String, String)>, chunks: Vec<(u64, Vec<u8>)> },
}

impl FixtureResp {
    pub fn json(status: u16, body: &str) -> FixtureResp {
        FixtureResp::Full { status, headers: vec![("content-type".into(), "application/json".into())], body: body.as_bytes().to_vec() }
    }
    pub fn empty(status: u16) -> FixtureResp {
        FixtureResp::Full { status, headers: Vec::new(), body: Vec::new() }
    }
}

pub struct Server {
    addr: SocketAddr,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

fn read_request(s: &mut TcpStream) -> Option<FixtureReq> {
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let end = loop {
        let n = s.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    let mut body = buf[end..].to_vec();
    while body.len() < len {
        let n = s.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some(FixtureReq { method, path, headers, body })
}

fn write_head(s: &mut TcpStream, status: u16, headers: &[(String, String)], extra: &str) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n{extra}");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes())
}

fn answer(mut s: TcpStream, resp: FixtureResp) {
    let _ = match resp {
        FixtureResp::Full { status, headers, body } => write_head(&mut s, status, &headers, &format!("Content-Length: {}\r\n", body.len())).and_then(|_| s.write_all(&body)),
        FixtureResp::Chunked { status, headers, chunks } => (|| {
            write_head(&mut s, status, &headers, "Transfer-Encoding: chunked\r\n")?;
            for (delay, c) in chunks {
                std::thread::sleep(Duration::from_millis(delay));
                s.write_all(format!("{:x}\r\n", c.len()).as_bytes())?;
                s.write_all(&c)?;
                s.write_all(b"\r\n")?;
                s.flush()?;
            }
            s.write_all(b"0\r\n\r\n")
        })(),
    };
    let _ = s.flush();
}

impl Server {
    /// Listens on 127.0.0.1, an ephemeral port.
    pub fn start(handler: impl Fn(&FixtureReq) -> FixtureResp + Send + Sync + 'static) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let (hits, stop) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
        let (h2, s2, handler) = (hits.clone(), stop.clone(), Arc::new(handler));
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut s) = conn else { continue };
                let (h3, handler) = (h2.clone(), handler.clone());
                std::thread::spawn(move || {
                    if let Some(req) = read_request(&mut s) {
                        h3.fetch_add(1, Ordering::SeqCst);
                        answer(s, handler(&req));
                    }
                });
            }
        });
        Server { addr, hits, stop }
    }

    /// `http://127.0.0.1:<port>`
    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }
    pub fn port(&self) -> u16 {
        self.addr.port()
    }
    /// Requests received so far.
    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr); // wakes the accept loop so it can end
    }
}
