//! Minimal RFC 6455 WebSocket server side for `agent serve`.
//!
//! Only what the shared ACP server needs: one HTTP/1.1 upgrade on `/ws`,
//! bearer or `server-key` query authentication, masked client frames,
//! fragmented text messages, ping/pong, and close. Text payloads are single
//! JSON-RPC messages, as with the reference server.

use base64::Engine;
use sha1::{Digest, Sha1};
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEADER_BYTES: usize = 16 * 1024;
/// Same ceiling as the reference server's line buffer.
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Handshake {
    /// Authenticated upgrade; the stream now speaks WebSocket frames.
    Accepted,
    /// A response was written and the connection must be closed.
    Rejected(&'static str),
}

/// Read the HTTP upgrade request, check the secret, and answer it.
pub fn accept(stream: &mut TcpStream, secret: &str) -> io::Result<Handshake> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEADER_BYTES {
            write_status(
                stream,
                431,
                "Request Header Fields Too Large",
                "header too large",
            )?;
            return Ok(Handshake::Rejected("header too large"));
        }
        let read = stream.read(&mut byte)?;
        if read == 0 {
            return Ok(Handshake::Rejected("closed before request"));
        }
        head.push(byte[0]);
    }
    stream.set_read_timeout(None)?;
    let text = String::from_utf8_lossy(&head).into_owned();
    let request = parse_request(&text);
    let Some(request) = request else {
        write_status(stream, 400, "Bad Request", "malformed request")?;
        return Ok(Handshake::Rejected("malformed request"));
    };
    if request.method != "GET" || request.path != "/ws" {
        write_status(stream, 404, "Not Found", "use GET /ws")?;
        return Ok(Handshake::Rejected("wrong path"));
    }
    if !authorized(&request, secret) {
        write_status(
            stream,
            401,
            "Unauthorized",
            "Invalid or missing authorization token",
        )?;
        return Ok(Handshake::Rejected("unauthorized"));
    }
    let upgrade = request
        .header("upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let connection = request.header("connection").is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
    });
    let version = request.header("sec-websocket-version") == Some("13");
    let Some(key) = request.header("sec-websocket-key").filter(|key| {
        base64::engine::general_purpose::STANDARD
            .decode(key)
            .is_ok_and(|bytes| bytes.len() == 16)
    }) else {
        write_status(stream, 400, "Bad Request", "missing Sec-WebSocket-Key")?;
        return Ok(Handshake::Rejected("missing key"));
    };
    if !upgrade || !connection || !version {
        write_status(stream, 400, "Bad Request", "not a WebSocket 13 upgrade")?;
        return Ok(Handshake::Rejected("not an upgrade"));
    }
    let accept = accept_key(key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    Ok(Handshake::Accepted)
}

pub fn accept_key(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.trim().as_bytes());
    hasher.update(GUID.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
}

struct Request {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn parse_request(text: &str) -> Option<Request> {
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?;
    let protocol = parts.next()?;
    if !protocol.starts_with("HTTP/1.") {
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line.split_once(':')?;
        headers.push((key.trim().to_string(), value.trim().to_string()));
    }
    Some(Request {
        method,
        path: path.to_string(),
        query: query.to_string(),
        headers,
    })
}

fn authorized(request: &Request, secret: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    // The reference checks the bearer header first. A present header decides
    // on its own; a wrong header is not rescued by a query key.
    if let Some(value) = request.header("authorization") {
        return value
            .strip_prefix("Bearer ")
            .is_some_and(|token| constant_time_eq(token.as_bytes(), secret.as_bytes()));
    }
    for pair in request.query.split('&') {
        if let Some(value) = pair.strip_prefix("server-key=") {
            let decoded = percent_decode(value);
            return constant_time_eq(decoded.as_bytes(), secret.as_bytes());
        }
    }
    false
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn write_status(stream: &mut TcpStream, code: u16, reason: &str, body: &str) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Text(String),
    Ping(Vec<u8>),
    Close,
}

/// Read one complete message. Control frames are returned as they arrive,
/// including between the fragments of a text message.
pub struct FrameReader {
    partial: Option<Vec<u8>>,
}

impl Default for FrameReader {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameReader {
    pub fn new() -> Self {
        Self { partial: None }
    }

    pub fn next<R: Read>(&mut self, reader: &mut R) -> io::Result<Incoming> {
        loop {
            let mut head = [0u8; 2];
            reader.read_exact(&mut head)?;
            let fin = head[0] & 0x80 != 0;
            if head[0] & 0x70 != 0 {
                return Err(protocol("reserved bits set"));
            }
            let opcode = head[0] & 0x0f;
            let masked = head[1] & 0x80 != 0;
            if !masked {
                return Err(protocol("client frames must be masked"));
            }
            let mut length = u64::from(head[1] & 0x7f);
            if length == 126 {
                let mut extended = [0u8; 2];
                reader.read_exact(&mut extended)?;
                length = u64::from(u16::from_be_bytes(extended));
            } else if length == 127 {
                let mut extended = [0u8; 8];
                reader.read_exact(&mut extended)?;
                length = u64::from_be_bytes(extended);
            }
            let control = opcode & 0x08 != 0;
            if control && (length > 125 || !fin) {
                return Err(protocol("invalid control frame"));
            }
            let already = self.partial.as_ref().map_or(0, Vec::len) as u64;
            if length + already > MAX_MESSAGE_BYTES as u64 {
                return Err(protocol("message too large"));
            }
            let mut mask = [0u8; 4];
            reader.read_exact(&mut mask)?;
            let mut payload = vec![0u8; length as usize];
            reader.read_exact(&mut payload)?;
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
            match opcode {
                0x0 => {
                    let Some(partial) = self.partial.as_mut() else {
                        return Err(protocol("continuation without a first frame"));
                    };
                    partial.extend_from_slice(&payload);
                    if fin {
                        let bytes = self.partial.take().unwrap_or_default();
                        return text(bytes);
                    }
                }
                0x1 => {
                    if self.partial.is_some() {
                        return Err(protocol("new message inside a fragmented message"));
                    }
                    if fin {
                        return text(payload);
                    }
                    self.partial = Some(payload);
                }
                // The reference also accepts JSON sent as a binary message.
                0x2 => {
                    if self.partial.is_some() {
                        return Err(protocol("new message inside a fragmented message"));
                    }
                    if fin {
                        return text(payload);
                    }
                    self.partial = Some(payload);
                }
                0x8 => return Ok(Incoming::Close),
                0x9 => return Ok(Incoming::Ping(payload)),
                0xA => {}
                _ => return Err(protocol("unknown opcode")),
            }
        }
    }
}

fn text(bytes: Vec<u8>) -> io::Result<Incoming> {
    String::from_utf8(bytes)
        .map(Incoming::Text)
        .map_err(|_| protocol("text frame is not UTF-8"))
}

fn protocol(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Server frames are never masked.
pub fn encode(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | (opcode & 0x0f));
    let length = payload.len();
    if length < 126 {
        frame.push(length as u8);
    } else if length <= u16::MAX as usize {
        frame.push(126);
        frame.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(length as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

pub fn text_frame(text: &str) -> Vec<u8> {
    encode(0x1, text.as_bytes())
}

pub fn pong_frame(payload: &[u8]) -> Vec<u8> {
    encode(0xA, payload)
}

pub fn ping_frame() -> Vec<u8> {
    encode(0x9, b"")
}

/// Close with a status code and a short reason.
pub fn close_frame(code: u16, reason: &str) -> Vec<u8> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(&reason.as_bytes()[..reason.len().min(120)]);
    encode(0x8, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mask = [0x11, 0x22, 0x33, 0x44];
        let mut frame = vec![if fin { 0x80 } else { 0 } | opcode];
        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        frame
    }

    #[test]
    fn accept_key_matches_rfc_example() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn reassembles_fragments_and_surfaces_control_frames() {
        let mut bytes = masked(0x1, false, b"{\"a\":");
        bytes.extend(masked(0x9, true, b"hi"));
        bytes.extend(masked(0x0, true, b"1}"));
        bytes.extend(masked(0x8, true, &1000u16.to_be_bytes()));
        let mut reader = io::Cursor::new(bytes);
        let mut frames = FrameReader::new();
        assert_eq!(
            frames.next(&mut reader).unwrap(),
            Incoming::Ping(b"hi".to_vec())
        );
        assert_eq!(
            frames.next(&mut reader).unwrap(),
            Incoming::Text("{\"a\":1}".into())
        );
        assert_eq!(frames.next(&mut reader).unwrap(), Incoming::Close);
    }

    #[test]
    fn refuses_unmasked_and_oversized_frames() {
        let mut reader = io::Cursor::new(vec![0x81, 0x02, b'h', b'i']);
        assert!(FrameReader::new().next(&mut reader).is_err());
        let mut huge = vec![0x81, 0x80 | 127];
        huge.extend_from_slice(&((MAX_MESSAGE_BYTES as u64) + 1).to_be_bytes());
        huge.extend_from_slice(&[0, 0, 0, 0]);
        let mut reader = io::Cursor::new(huge);
        let error = FrameReader::new().next(&mut reader).unwrap_err();
        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn bearer_header_wins_over_query_and_compares_whole_secret() {
        let request = parse_request(
            "GET /ws?server-key=right HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n",
        )
        .unwrap();
        assert!(!authorized(&request, "right"));
        let request = parse_request("GET /ws?server-key=right HTTP/1.1\r\n\r\n").unwrap();
        assert!(authorized(&request, "right"));
        assert!(!authorized(&request, "righ"));
        assert!(!authorized(&request, ""));
        let request =
            parse_request("GET /ws HTTP/1.1\r\nauthorization: Bearer s%20x\r\n\r\n").unwrap();
        assert!(authorized(&request, "s%20x"));
        let request = parse_request("GET /ws?server-key=a%2Bb HTTP/1.1\r\n\r\n").unwrap();
        assert!(authorized(&request, "a+b"));
    }

    #[test]
    fn server_frames_use_extended_lengths() {
        let long = "x".repeat(70_000);
        let frame = text_frame(&long);
        assert_eq!(frame[0], 0x81);
        assert_eq!(frame[1], 127);
        assert_eq!(frame.len(), 70_000 + 10);
        let medium = text_frame(&"y".repeat(300));
        assert_eq!(medium[1], 126);
    }
}
