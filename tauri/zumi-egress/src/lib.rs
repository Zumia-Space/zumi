//! zumi-egress (T-31-MAUS R3): the one door for outbound HTTP from the agent. A Rust port of the sidecar's `guardedFetch`
//! rule (`tauri/sidecar/egress.mjs`), for the places the agent reaches the network itself: an MCP server over HTTP and a
//! custom OpenAI-compatible endpoint.
//!
//! The rule, in the order a request is refused (each refusal is ONE fixed code word, never a URL, header, body or key):
//!   1. `egress_bad_url`   the text is not an absolute URL
//!   2. `egress_userinfo`  the URL carries a user name or password (credentials go in a header, never in the address)
//!   3. `egress_scheme`    not https; plain http only for an origin the user added that is itself loopback
//!   4. `egress_host`      the origin (scheme, host AND port, compared exactly) is not one the user added
//!   5. `egress_private`   the host resolved to an address the origin may not use: a public origin may reach only public
//!                         addresses (no loopback, private, link-local, CGNAT, unique-local); a loopback origin only loopback
//!   6. `egress_redirect`  the answer is a redirect (never followed: a bearer must not travel to another host). A caller that
//!                         sets `hand_back_redirect` gets the head instead and decides itself, hop by hop, what to add
//! The connection goes to the address checked in step 5 (`resolve_to_addrs`), so a DNS change between the check and the
//! connect cannot move it. No proxy is used. The only way to reach a loopback address is for the user to add that exact
//! origin: nothing here adds one by itself.
//!
//! Sockets and the HTTP stack (`reqwest`, `tokio::net`, std sockets) appear in this crate only
//! (scripts/check-power-egress.mjs).
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Once};
use std::time::Duration;
use url::{Host, Url};

#[cfg(feature = "fixture")]
pub mod fixture;

/// A refusal or failure, one fixed code word. `Network` carries no detail on purpose: a transport message can hold a URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressError {
    Refused(&'static str),
    Cancelled,
    Timeout,
    TooLarge,
    Network,
}

impl EgressError {
    pub fn code(&self) -> &'static str {
        match self {
            EgressError::Refused(c) => c,
            EgressError::Cancelled => "egress_cancelled",
            EgressError::Timeout => "egress_timeout",
            EgressError::TooLarge => "egress_too_large",
            EgressError::Network => "egress_network",
        }
    }
}

/// One origin the user added: scheme, host and port compared exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Allowed {
    scheme: String,
    host: String,
    port: u16,
    /// The user named a loopback host (localhost, 127.x, ::1): the only kind that may use plain http and loopback addresses.
    loopback: bool,
}

impl Allowed {
    fn origin(&self) -> String {
        origin_text(&self.scheme, &self.host, self.port)
    }
}

fn origin_text(scheme: &str, host: &str, port: u16) -> String {
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    format!("{scheme}://{h}:{port}")
}

fn host_text(u: &Url) -> Option<String> {
    match u.host()? {
        Host::Domain(d) => Some(d.to_ascii_lowercase()),
        Host::Ipv4(a) => Some(a.to_string()),
        Host::Ipv6(a) => Some(a.to_string()),
    }
}

fn host_is_loopback(u: &Url) -> bool {
    match u.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(a)) => a.is_loopback(),
        Some(Host::Ipv6(a)) => a.is_loopback(),
        None => false,
    }
}

/// An address a public origin may reach. Everything that points back into this machine or its LAN is not.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(a) => {
            let o = a.octets();
            !(a.is_loopback()
                || o[0] >= 240 // 240.0.0.0/4 reserved (and the broadcast address)
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15 benchmarking
                || a.is_private()
                || a.is_link_local()
                || a.is_unspecified()
                || a.is_broadcast()
                || a.is_multicast()
                || a.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)) // 100.64.0.0/10 carrier-grade NAT
        }
        IpAddr::V6(a) => {
            let seg = a.segments();
            let s = seg[0];
            !(a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || (s & 0xfe00) == 0xfc00 // unique-local
                || (s & 0xffc0) == 0xfe80 // link-local
                || (s & 0xffc0) == 0xfec0 // site-local (deprecated, still routed on some LANs)
                || seg[..6].iter().all(|x| *x == 0) // ::/96, IPv4-compatible: ::127.0.0.1 is ::7f00:1
                || (s == 0x64 && seg[1] == 0xff9b) // NAT64: a gateway turns it into an IPv4 connect to the embedded address
                || s == 0x2002 // 6to4: embeds an IPv4 address, may be a private one
                || (s == 0x2001 && seg[1] == 0)) // Teredo
        }
    }
}

/// True when the URL names a loopback host (localhost, 127.x, ::1): the only kind of origin a user adds for a model on this PC.
/// A URL that does not parse is not loopback.
pub fn is_loopback_origin(url: &str) -> bool {
    Url::parse(url).map(|u| host_is_loopback(&u)).unwrap_or(false)
}

/// Which interfaces a listener may bind (R7, roadmap 1.6: this crate owns the only listener API). `Loopback` is 127.0.0.1 only; `Lan` is every
/// interface and is a separate grant the caller must have checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bind {
    Loopback,
    Lan,
}

/// An open door. Dropping it closes the port.
#[derive(Debug)]
pub struct Listener {
    inner: std::net::TcpListener,
}

impl Listener {
    pub fn port(&self) -> u16 {
        self.inner.local_addr().map(|a| a.port()).unwrap_or(0)
    }
}

/// Opens a TCP listener. Port 0 is refused: a pack names its port, so the door it opens is the one it declared.
pub fn listen(bind: Bind, port: u16) -> std::io::Result<Listener> {
    if port == 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "listen_port_zero"));
    }
    let ip = match bind {
        Bind::Loopback => std::net::Ipv4Addr::LOCALHOST,
        Bind::Lan => std::net::Ipv4Addr::UNSPECIFIED,
    };
    std::net::TcpListener::bind((ip, port)).map(|inner| Listener { inner })
}

fn is_loopback_ip(ip: IpAddr) -> bool {
    ip.to_canonical().is_loopback()
}

#[derive(Debug, Clone)]
pub struct Request<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: &'a [(String, String)],
    pub body: Option<Vec<u8>>,
    /// The whole call, connect to last byte.
    pub timeout: Duration,
    /// The most response bytes `send` keeps; `send_streaming` hands every chunk to the caller and keeps none.
    pub max_body: usize,
    /// A redirect answer is returned as the head (status and `location`), not refused. It is still never followed here: the
    /// caller decides, per hop, whether the next origin may be added (a download from a CDN that signs its own address).
    pub hand_back_redirect: bool,
}

impl<'a> Request<'a> {
    pub fn new(method: &'a str, url: &'a str) -> Request<'a> {
        Request { method, url, headers: &[], body: None, timeout: Duration::from_secs(30), max_body: 4 * 1024 * 1024, hand_back_redirect: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    /// Lower-case names.
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub head: Head,
    pub body: Vec<u8>,
}

type AuditFn = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Egress {
    allowed: Vec<Allowed>,
    audit: AuditFn,
    rt: tokio::runtime::Runtime,
}

static PROVIDER: Once = Once::new();

impl Egress {
    /// An egress with no origin: every request is refused until the user adds one. `audit` gets one line per request:
    /// `egress <origin> <status | code word>` (never a path, query, header, body or key).
    pub fn new(audit: AuditFn) -> Egress {
        PROVIDER.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a current-thread runtime");
        Egress { allowed: Vec::new(), audit, rt }
    }

    /// The user adds an origin (`https://host`, or `http://127.0.0.1:11434` for a local engine). A path is ignored.
    /// A public origin must be https and must not name a private or loopback address; plain http is accepted only for a
    /// loopback host, and only because the user typed it.
    pub fn add_user_origin(&mut self, text: &str) -> Result<(), EgressError> {
        let u = Url::parse(text).map_err(|_| EgressError::Refused("egress_bad_url"))?;
        if !u.username().is_empty() || u.password().is_some() {
            return Err(EgressError::Refused("egress_userinfo"));
        }
        let loopback = host_is_loopback(&u);
        match (u.scheme(), loopback) {
            ("https", _) | ("http", true) => {}
            _ => return Err(EgressError::Refused("egress_scheme")),
        }
        let host = host_text(&u).ok_or(EgressError::Refused("egress_bad_url"))?;
        if !loopback {
            let literal = match u.host() {
                Some(Host::Ipv4(a)) => Some(IpAddr::V4(a)),
                Some(Host::Ipv6(a)) => Some(IpAddr::V6(a)),
                _ => None,
            };
            if literal.is_some_and(|ip| !is_public_ip(ip)) {
                return Err(EgressError::Refused("egress_private"));
            }
        }
        let port = u.port_or_known_default().ok_or(EgressError::Refused("egress_bad_url"))?;
        let entry = Allowed { scheme: u.scheme().to_string(), host, port, loopback };
        if !self.allowed.contains(&entry) {
            self.allowed.push(entry);
        }
        Ok(())
    }

    pub fn origins(&self) -> Vec<String> {
        self.allowed.iter().map(Allowed::origin).collect()
    }

    /// Steps 1-4 of the rule only (well formed, no userinfo, scheme, origin added), with no network and no DNS: the same refusal
    /// word `send` would give, so a caller can log a refusal before it acts (R7: the pack broker).
    pub fn check_url(&self, text: &str) -> Result<(), EgressError> {
        self.admit(text).map(|_| ())
    }

    fn log(&self, origin: &str, what: &str) {
        (self.audit)(&format!("egress {origin} {what}"));
    }

    fn refuse(&self, origin: &str, code: &'static str) -> EgressError {
        self.log(origin, code);
        EgressError::Refused(code)
    }

    /// Steps 1-4: the URL is well formed and its origin is one the user added. Returns the URL and the matching entry.
    fn admit(&self, text: &str) -> Result<(Url, Allowed), EgressError> {
        let u = Url::parse(text).map_err(|_| self.refuse("-", "egress_bad_url"))?;
        let Some(host) = host_text(&u) else {
            // file:, data: and the like have no host: they are a wrong scheme before they are a bad address
            return Err(self.refuse("-", if matches!(u.scheme(), "http" | "https") { "egress_bad_url" } else { "egress_scheme" }));
        };
        let port = u.port_or_known_default().ok_or_else(|| self.refuse("-", "egress_bad_url"))?;
        let origin = origin_text(u.scheme(), &host, port);
        if !u.username().is_empty() || u.password().is_some() {
            return Err(self.refuse(&origin, "egress_userinfo"));
        }
        if u.scheme() != "https" && !(u.scheme() == "http" && host_is_loopback(&u)) {
            return Err(self.refuse(&origin, "egress_scheme"));
        }
        let hit = self.allowed.iter().find(|a| a.scheme == u.scheme() && a.host == host && a.port == port);
        match hit {
            Some(a) => Ok((u.clone(), a.clone())),
            None => Err(self.refuse(&origin, "egress_host")),
        }
    }

    /// Run `fut` on this egress's runtime, checking `cancel` every 25 ms.
    fn drive<F: std::future::Future>(&self, fut: F, cancel: &dyn Fn() -> bool) -> Result<F::Output, EgressError> {
        let mut fut = std::pin::pin!(fut);
        self.rt.block_on(async {
            loop {
                match tokio::time::timeout(Duration::from_millis(25), &mut fut).await {
                    Ok(v) => return Ok(v),
                    Err(_) if cancel() => return Err(EgressError::Cancelled),
                    Err(_) => {}
                }
            }
        })
    }

    /// One request; the whole body is kept (at most `max_body` bytes).
    pub fn send(&self, req: &Request, cancel: &dyn Fn() -> bool) -> Result<Response, EgressError> {
        let mut body = Vec::new();
        let (max, mut overflow) = (req.max_body, false);
        let head = self.send_streaming(req, cancel, &mut |chunk| {
            if body.len() + chunk.len() > max {
                overflow = true;
                return false;
            }
            body.extend_from_slice(chunk);
            true
        })?;
        if overflow {
            return Err(EgressError::TooLarge);
        }
        Ok(Response { head, body })
    }

    /// One request whose body is handed to `on_chunk` as it arrives. `on_chunk` returns false to stop reading: the call
    /// then ends `Ok` with the head (the caller knows why it stopped, and the connection is dropped).
    pub fn send_streaming(&self, req: &Request, cancel: &dyn Fn() -> bool, on_chunk: &mut dyn FnMut(&[u8]) -> bool) -> Result<Head, EgressError> {
        self.send_streaming_head(req, cancel, &mut |_| true, on_chunk)
    }

    /// As `send_streaming`, and `on_head` sees the status and headers first: false stops the call there (`Ok` with the head, no
    /// body read), so a caller can refuse a body it did not ask for (a full answer to a range request).
    pub fn send_streaming_head(&self, req: &Request, cancel: &dyn Fn() -> bool, on_head: &mut dyn FnMut(&Head) -> bool, on_chunk: &mut dyn FnMut(&[u8]) -> bool) -> Result<Head, EgressError> {
        let (url, entry) = self.admit(req.url)?;
        let origin = entry.origin();
        if cancel() {
            return Err(EgressError::Cancelled);
        }
        let mut headers = HeaderMap::new();
        for (k, v) in req.headers {
            let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) else {
                return Err(self.refuse(&origin, "egress_bad_header"));
            };
            headers.append(name, value);
        }
        let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|_| self.refuse(&origin, "egress_bad_url"))?;
        let host = host_text(&url).unwrap_or_default();
        let port = entry.port;
        let work = async {
            // Step 5: resolve once, check every address, connect only to what was checked.
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| EgressError::Network)?.collect();
            if addrs.is_empty() {
                return Err(EgressError::Network);
            }
            let ok = addrs.iter().all(|a| if entry.loopback { is_loopback_ip(a.ip()) } else { is_public_ip(a.ip()) });
            if !ok {
                return Err(EgressError::Refused("egress_private"));
            }
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .resolve_to_addrs(&host, &addrs)
                .connect_timeout(req.timeout)
                .timeout(req.timeout)
                .build()
                .map_err(|_| EgressError::Network)?;
            let mut rb = client.request(method, url.as_str()).headers(headers);
            if let Some(b) = &req.body {
                rb = rb.body(b.clone());
            }
            let mut resp = rb.send().await.map_err(|e| if e.is_timeout() { EgressError::Timeout } else { EgressError::Network })?;
            let status = resp.status().as_u16();
            let redirect = resp.status().is_redirection();
            if redirect && !req.hand_back_redirect {
                return Err(EgressError::Refused("egress_redirect"));
            }
            let head = Head { status, headers: resp.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string()))).collect() };
            // A handed-back redirect has no body to read; otherwise the caller may stop the call on the head alone.
            if redirect || !on_head(&head) {
                return Ok(head);
            }
            loop {
                match resp.chunk().await {
                    Ok(Some(c)) => {
                        if !on_chunk(&c) {
                            return Ok(head);
                        }
                    }
                    Ok(None) => return Ok(head),
                    Err(e) => return Err(if e.is_timeout() { EgressError::Timeout } else { EgressError::Network }),
                }
            }
        };
        let out = match self.drive(work, cancel) {
            Ok(r) => r,
            Err(e) => Err(e),
        };
        match &out {
            Ok(h) => self.log(&origin, &h.status.to_string()),
            Err(e) => self.log(&origin, e.code()),
        }
        out
    }
}
