use native_tls::Certificate;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_EXTRA_CA_BUNDLE_BYTES: u64 = 1024 * 1024;
pub const ENV_GROK_EXTRA_CA_BUNDLE: &str = "GROK_EXTRA_CA_BUNDLE";
pub const ENV_SSL_CERT_FILE: &str = "SSL_CERT_FILE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub location: Option<String>,
}

#[derive(Debug)]
pub enum HttpError {
    Network(String),
    CertificateUntrusted(String),
    CertificateInvalid(String),
    Status(u16, String),
    Other(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(message) => write!(f, "network error: {message}"),
            Self::CertificateUntrusted(message) => {
                write!(
                    f,
                    "Can't verify the server's security certificate. {message}"
                )
            }
            Self::CertificateInvalid(message) => {
                write!(
                    f,
                    "The server's security certificate is invalid (wrong host, expired, or mismatched). {message}"
                )
            }
            Self::Status(status, body) => write!(f, "HTTP {status}: {body}"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for HttpError {}

/// `GROK_EXTRA_CA_BUNDLE` wins over `SSL_CERT_FILE`; an explicitly empty value disables both.
pub fn select_bundle(
    bundle: Option<OsString>,
    ssl: Option<OsString>,
) -> Option<(&'static str, PathBuf)> {
    match bundle {
        Some(path) if !path.is_empty() => Some((ENV_GROK_EXTRA_CA_BUNDLE, path.into())),
        Some(_) => None,
        None => match ssl {
            Some(path) if !path.is_empty() => Some((ENV_SSL_CERT_FILE, path.into())),
            _ => None,
        },
    }
}

pub fn configured_bundle(
    env: &std::collections::BTreeMap<String, String>,
) -> Option<(String, PathBuf)> {
    select_bundle(
        env.get(ENV_GROK_EXTRA_CA_BUNDLE).map(OsString::from),
        env.get(ENV_SSL_CERT_FILE).map(OsString::from),
    )
    .map(|(source, path)| (source.to_string(), path))
}

pub fn load_extra_certificates(path: &Path) -> (Vec<Certificate>, Vec<String>) {
    let mut warnings = Vec::new();
    let bytes = match read_bundle_capped(path) {
        Ok(bytes) => bytes,
        Err(message) => {
            warnings.push(message);
            return (Vec::new(), warnings);
        }
    };
    let pem =
        String::from_utf8_lossy(&bytes).replace("BEGIN TRUSTED CERTIFICATE", "BEGIN CERTIFICATE");
    let pem = pem.replace("END TRUSTED CERTIFICATE", "END CERTIFICATE");
    if !pem.contains("BEGIN CERTIFICATE") {
        warnings.push(format!(
            "extra CA bundle {} contains no PEM certificate blocks; continuing without extra roots",
            path.display()
        ));
        return (Vec::new(), warnings);
    }
    let mut accepted = Vec::new();
    let mut rejected = 0usize;
    for block in split_pem_certs(&pem) {
        match Certificate::from_pem(block.as_bytes()) {
            Ok(cert) => accepted.push(cert),
            Err(_) => rejected += 1,
        }
    }
    if rejected > 0 {
        warnings.push(format!(
            "extra CA bundle {}: dropped {rejected} unusable certificate block(s)",
            path.display()
        ));
    }
    if accepted.is_empty() {
        warnings.push(format!(
            "extra CA bundle {} produced zero usable certificates; continuing without extra roots",
            path.display()
        ));
    }
    (accepted, warnings)
}

fn read_bundle_capped(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|error| {
        format!(
            "extra CA bundle {} unreadable ({error}); continuing without extra roots",
            path.display()
        )
    })?;
    let mut buf = Vec::new();
    let n = file
        .take(MAX_EXTRA_CA_BUNDLE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|error| {
            format!(
                "extra CA bundle {} unreadable ({error}); continuing without extra roots",
                path.display()
            )
        })?;
    if n as u64 > MAX_EXTRA_CA_BUNDLE_BYTES {
        return Err(format!(
            "extra CA bundle {} exceeds {MAX_EXTRA_CA_BUNDLE_BYTES} bytes; continuing without extra roots",
            path.display()
        ));
    }
    Ok(buf)
}

fn split_pem_certs(pem: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
        rest = &rest[start..];
        match rest.find("-----END CERTIFICATE-----") {
            Some(end) => {
                let finish = end + "-----END CERTIFICATE-----".len();
                blocks.push(rest[..finish].to_string());
                rest = &rest[finish..];
            }
            None => break,
        }
    }
    blocks
}

fn classify_tls(error: &ureq::Error) -> HttpError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    if lower.contains("host")
        || lower.contains("expired")
        || lower.contains("name")
        || lower.contains("mismatch")
    {
        HttpError::CertificateInvalid(message)
    } else if lower.contains("certificate")
        || lower.contains("cert")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("pkix")
        || lower.contains("unknown ca")
        || lower.contains("trust")
    {
        HttpError::CertificateUntrusted(message)
    } else {
        HttpError::Network(message)
    }
}

/// Native-tls agent used by substitute HTTP calls.
///
/// ureq is built with `default-features = false` and `native-tls`, so HTTPS
/// stays unavailable until this connector is installed. Configured extra roots
/// are added; invalid certificates and hostnames stay rejected. Redirects stay
/// off and the overall deadline stays 15s.
pub fn agent(extra_bundle: Option<&Path>) -> Result<(ureq::Agent, Vec<String>), HttpError> {
    let mut warnings = Vec::new();
    let mut builder = native_tls::TlsConnector::builder();
    builder.danger_accept_invalid_certs(false);
    builder.danger_accept_invalid_hostnames(false);
    if let Some(path) = extra_bundle {
        let (certs, extra_warnings) = load_extra_certificates(path);
        warnings.extend(extra_warnings);
        for cert in certs {
            builder.add_root_certificate(cert);
        }
    }
    let tls = builder
        .build()
        .map_err(|error| HttpError::Other(error.to_string()))?;
    let agent = ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(tls))
        .redirects(0)
        .timeout(Duration::from_secs(15))
        .build();
    Ok((agent, warnings))
}

fn agent_for(extra_bundle: Option<&Path>) -> Result<(ureq::Agent, Vec<String>), HttpError> {
    agent(extra_bundle)
}

pub fn http_get(
    url: &str,
    extra_bundle: Option<&Path>,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<HttpResponse, HttpError> {
    let (agent, _) = agent_for(extra_bundle)?;
    let mut request = agent.get(url).timeout(timeout);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    match request.call() {
        Ok(response) => read_response(response),
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(HttpError::Status(status, body))
        }
        Err(error) => Err(classify_tls(&error)),
    }
}

pub fn http_post_form(
    url: &str,
    extra_bundle: Option<&Path>,
    timeout: Duration,
    headers: &[(&str, &str)],
    form: &[(&str, &str)],
) -> Result<HttpResponse, HttpError> {
    let (agent, _) = agent_for(extra_bundle)?;
    let mut request = agent.post(url).timeout(timeout);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    match request.send_form(form) {
        Ok(response) => read_response(response),
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(HttpError::Status(status, body))
        }
        Err(error) => Err(classify_tls(&error)),
    }
}

fn read_response(response: ureq::Response) -> Result<HttpResponse, HttpError> {
    let status = response.status();
    let location = response.header("location").map(str::to_string);
    let body = response
        .into_string()
        .map_err(|error| HttpError::Network(error.to_string()))?;
    Ok(HttpResponse {
        status,
        body,
        location,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn extra_ca_bundle_wins_and_empty_disables_ssl_cert_file() {
        assert_eq!(
            select_bundle(
                Some(OsString::from("/tmp/extra.pem")),
                Some(OsString::from("/tmp/ssl.pem"))
            ),
            Some((ENV_GROK_EXTRA_CA_BUNDLE, PathBuf::from("/tmp/extra.pem")))
        );
        assert_eq!(
            select_bundle(Some(OsString::new()), Some(OsString::from("/tmp/ssl.pem"))),
            None
        );
        assert_eq!(
            select_bundle(None, Some(OsString::from("/tmp/ssl.pem"))),
            Some((ENV_SSL_CERT_FILE, PathBuf::from("/tmp/ssl.pem")))
        );
        assert_eq!(select_bundle(None, Some(OsString::new())), None);
    }

    #[test]
    fn oversized_and_empty_bundles_warn_without_usable_roots() {
        let dir = tempfile::TempDir::new().unwrap();
        let huge = dir.path().join("huge.pem");
        std::fs::write(&huge, vec![b'A'; (MAX_EXTRA_CA_BUNDLE_BYTES as usize) + 8]).unwrap();
        let (certs, warnings) = load_extra_certificates(&huge);
        assert!(certs.is_empty());
        assert!(warnings.iter().any(|warning| warning.contains("exceeds")));

        let empty = dir.path().join("empty.pem");
        std::fs::write(&empty, "not-a-cert\n").unwrap();
        let (certs, warnings) = load_extra_certificates(&empty);
        assert!(certs.is_empty());
        assert!(warnings.iter().any(|warning| warning.contains("no PEM")));
    }

    fn openssl_p12(dir: &std::path::Path, cn: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let key = dir.join("key.pem");
        let cert = dir.join("cert.pem");
        let p12 = dir.join("server.p12");
        assert!(
            std::process::Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-keyout",
                    key.to_str().unwrap(),
                    "-out",
                    cert.to_str().unwrap(),
                    "-days",
                    "1",
                    "-nodes",
                    "-subj",
                    &format!("/CN={cn}"),
                ])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::process::Command::new("openssl")
                .args([
                    "pkcs12",
                    "-export",
                    "-out",
                    p12.to_str().unwrap(),
                    "-inkey",
                    key.to_str().unwrap(),
                    "-in",
                    cert.to_str().unwrap(),
                    "-passout",
                    "pass:test",
                ])
                .status()
                .unwrap()
                .success()
        );
        (cert, p12)
    }

    fn spawn_tls(p12: &std::path::Path) -> (String, std::thread::JoinHandle<()>) {
        let bytes = std::fs::read(p12).unwrap();
        let identity = native_tls::Identity::from_pkcs12(&bytes, "test").unwrap();
        let acceptor = native_tls::TlsAcceptor::new(identity).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept()
                && let Ok(mut tls) = acceptor.accept(stream)
            {
                use std::io::{Read, Write};
                let mut buf = [0u8; 1024];
                let _ = tls.read(&mut buf);
                let _ = tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });
        (format!("https://127.0.0.1:{}", addr.port()), handle)
    }

    #[test]
    fn extra_ca_trusts_custom_root_and_wrong_host_stays_invalid() {
        let dir = tempfile::TempDir::new().unwrap();
        let (cert, p12) = openssl_p12(dir.path(), "localhost");
        let (certs, warnings) = load_extra_certificates(&cert);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(certs.len(), 1);

        let (url, handle) = spawn_tls(&p12);
        let untrusted = http_get(&url, None, Duration::from_secs(3), &[]).unwrap_err();
        assert!(
            matches!(
                untrusted,
                HttpError::CertificateUntrusted(_) | HttpError::Network(_)
            ),
            "{untrusted}"
        );
        let _ = handle.join();

        let (url, handle) = spawn_tls(&p12);
        let host_err = http_get(&url, Some(&cert), Duration::from_secs(3), &[]).unwrap_err();
        assert!(
            matches!(
                host_err,
                HttpError::CertificateInvalid(_) | HttpError::CertificateUntrusted(_)
            ),
            "{host_err}"
        );
        let _ = handle.join();
    }
}
