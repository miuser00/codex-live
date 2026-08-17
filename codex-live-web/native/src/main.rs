#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    env,
    error::Error,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use url::Url;
use walkdir::WalkDir;

const INDEX_HTML: &[u8] = include_bytes!("../../public/index.html");
const APP_JS: &[u8] = include_bytes!("../../public/app.js");
const STYLES_CSS: &[u8] = include_bytes!("../../public/styles.css");
const LUCIDE_JS: &[u8] = include_bytes!("../../public/vendor/lucide.min.js");
const MARKDOWN_IT_JS: &[u8] = include_bytes!("../../public/vendor/markdown-it.min.js");
const DEFAULT_PORT: u16 = 17_346;
const MAX_HEADER_SIZE: usize = 16 * 1024;
const MAX_TAIL_CHUNK: u64 = 4 * 1024 * 1024;

type BoxError = Box<dyn Error + Send + Sync>;

#[derive(Clone)]
struct AppState {
    codex_root: Arc<PathBuf>,
    sessions_root: Arc<PathBuf>,
    running: Arc<AtomicBool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    token: String,
    id: String,
    title: String,
    path: String,
    updated_at: String,
    size: u64,
}

fn main() {
    if let Err(error) = run() {
        write_error_log(&error.to_string());
    }
}

fn run() -> Result<(), BoxError> {
    let codex_root = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(|path| PathBuf::from(path).join(".codex")))
        .ok_or("USERPROFILE and CODEX_HOME are both unavailable")?;
    let sessions_root = codex_root.join("sessions");
    let port = env::var("CODEX_LIVE_WEB_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let address = format!("127.0.0.1:{port}");
    let url = format!("http://{address}/");

    let listener = match TcpListener::bind(&address) {
        Ok(listener) => listener,
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            open_browser(&url)?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    listener.set_nonblocking(true)?;

    let running = Arc::new(AtomicBool::new(true));
    let state = AppState {
        codex_root: Arc::new(codex_root),
        sessions_root: Arc::new(sessions_root),
        running: Arc::clone(&running),
    };
    let pid_path = write_pid_file();
    open_browser(&url)?;

    while running.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let state = state.clone();
                thread::spawn(move || {
                    let _ = handle_connection(stream, &state);
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(error.into()),
        }
    }

    if let Some(path) = pid_path {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn handle_connection(mut stream: TcpStream, state: &AppState) -> Result<(), BoxError> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(20)))?;
    let mut request_bytes = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 1024];
    while request_bytes.len() < MAX_HEADER_SIZE {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        request_bytes.extend_from_slice(&chunk[..count]);
        if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut headers);
    if !request.parse(&request_bytes)?.is_complete() {
        return write_json_error(&mut stream, 400, "incomplete request");
    }
    let method = request.method.unwrap_or_default();
    let target = request.path.unwrap_or("/");
    let parsed_url = Url::parse(&format!("http://localhost{target}"))?;
    let path = parsed_url.path();

    if method == "GET" && path == "/api/live" {
        let query = query_map(&parsed_url);
        return serve_live(
            &mut stream,
            state,
            query.get("token").map(String::as_str).unwrap_or_default(),
            query
                .get("offset")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            query
                .get("line")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        );
    }

    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => {
            write_response(&mut stream, 200, "text/html; charset=utf-8", INDEX_HTML)
        }
        ("GET", "/app.js") => {
            write_response(&mut stream, 200, "text/javascript; charset=utf-8", APP_JS)
        }
        ("GET", "/styles.css") => {
            write_response(&mut stream, 200, "text/css; charset=utf-8", STYLES_CSS)
        }
        ("GET", "/vendor/lucide.js") => write_response(
            &mut stream,
            200,
            "text/javascript; charset=utf-8",
            LUCIDE_JS,
        ),
        ("GET", "/vendor/markdown-it.js") => write_response(
            &mut stream,
            200,
            "text/javascript; charset=utf-8",
            MARKDOWN_IT_JS,
        ),
        ("GET", "/favicon.ico") => write_response(&mut stream, 204, "image/x-icon", &[]),
        ("GET", "/api/sessions") => match list_sessions(state) {
            Ok(sessions) => write_json(&mut stream, 200, &json!({ "sessions": sessions })),
            Err(error) => write_json_error(&mut stream, 500, &error.to_string()),
        },
        ("GET", "/api/session") => {
            let query = query_map(&parsed_url);
            let token = query.get("token").map(String::as_str).unwrap_or_default();
            match path_for_token(&state.sessions_root, token)
                .map_err(|error| error.into())
                .and_then(|path| read_history(state, &path))
            {
                Ok(history) => write_json(&mut stream, 200, &history),
                Err(error) => write_json_error(&mut stream, 400, &error.to_string()),
            }
        }
        ("POST", "/api/shutdown") => {
            write_json(&mut stream, 202, &json!({ "stopping": true }))?;
            state.running.store(false, Ordering::Release);
            Ok(())
        }
        _ => write_json_error(&mut stream, 404, "not found"),
    }
}

fn query_map(url: &Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), BoxError> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    Ok(())
}

fn write_json(stream: &mut TcpStream, status: u16, value: &Value) -> Result<(), BoxError> {
    let body = serde_json::to_vec(value)?;
    write_response(stream, status, "application/json; charset=utf-8", &body)
}

fn write_json_error(stream: &mut TcpStream, status: u16, message: &str) -> Result<(), BoxError> {
    write_json(stream, status, &json!({ "error": message }))
}

fn serve_live(
    stream: &mut TcpStream,
    state: &AppState,
    token: &str,
    mut offset: u64,
    mut line_number: usize,
) -> Result<(), BoxError> {
    let path = match path_for_token(&state.sessions_root, token) {
        Ok(path) => path,
        Err(error) => return write_json_error(stream, 400, &error),
    };
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n"
    )?;
    write_sse(
        stream,
        Some("ready"),
        &json!({ "path": relative_display(&state.codex_root, &path) }).to_string(),
    )?;

    let mut carry = Vec::new();
    let mut last_heartbeat = Instant::now();
    while state.running.load(Ordering::Acquire) {
        if let Ok(metadata) = fs::metadata(&path) {
            if metadata.len() < offset {
                offset = 0;
                line_number = 0;
                carry.clear();
            }
            if metadata.len() > offset {
                let mut file = File::open(&path)?;
                file.seek(SeekFrom::Start(offset))?;
                let length = (metadata.len() - offset).min(MAX_TAIL_CHUNK);
                let mut buffer = Vec::with_capacity(length as usize);
                file.take(length).read_to_end(&mut buffer)?;
                offset += buffer.len() as u64;
                carry.extend_from_slice(&buffer);

                let mut start = 0;
                let mut outbound = Vec::new();
                for index in 0..carry.len() {
                    if carry[index] != b'\n' {
                        continue;
                    }
                    let mut line_bytes = &carry[start..index];
                    if line_bytes.last() == Some(&b'\r') {
                        line_bytes = &line_bytes[..line_bytes.len().saturating_sub(1)];
                    }
                    start = index + 1;
                    if line_bytes.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    line_number += 1;
                    if let Ok(raw_event) = serde_json::from_slice::<Value>(line_bytes) {
                        if let Some(event) = normalize_event(&raw_event, line_number) {
                            outbound.push(event.to_string());
                        }
                    }
                }
                if start > 0 {
                    carry.drain(..start);
                }
                for event in outbound {
                    write_sse(stream, None, &event)?;
                }
            }
        }

        if last_heartbeat.elapsed() >= Duration::from_secs(15) {
            stream.write_all(b": heartbeat\n\n")?;
            stream.flush()?;
            last_heartbeat = Instant::now();
        }
        thread::sleep(Duration::from_millis(350));
    }
    Ok(())
}

fn write_sse(stream: &mut TcpStream, event: Option<&str>, data: &str) -> Result<(), BoxError> {
    if let Some(event) = event {
        writeln!(stream, "event: {event}")?;
    }
    writeln!(stream, "data: {data}\n")?;
    stream.flush()?;
    Ok(())
}

fn list_sessions(state: &AppState) -> Result<Vec<SessionInfo>, BoxError> {
    let titles = load_titles(&state.codex_root);
    let mut sessions = Vec::new();
    if !state.sessions_root.exists() {
        return Ok(sessions);
    }
    for entry in WalkDir::new(state.sessions_root.as_ref())
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let id = session_id(path);
        let title = titles
            .get(&id)
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or_else(|| id.clone());
        let updated_at = metadata
            .modified()
            .map(DateTime::<Utc>::from)
            .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or_default();
        sessions.push(SessionInfo {
            token: token_for_path(&state.sessions_root, path),
            id,
            title,
            path: relative_display(&state.codex_root, path),
            updated_at,
            size: metadata.len(),
        });
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(200);
    Ok(sessions)
}

fn load_titles(codex_root: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let Ok(file) = File::open(codex_root.join("session_index.jsonl")) else {
        return titles;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(item) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let title = item
            .get("thread_name")
            .or_else(|| item.get("title"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        titles.insert(id.to_owned(), title.to_owned());
    }
    titles
}

fn read_history(state: &AppState, path: &Path) -> Result<Value, BoxError> {
    let file = File::open(path)?;
    let mut events = Vec::new();
    let mut line_count = 0;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        line_count += 1;
        let Ok(raw_event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(event) = normalize_event(&raw_event, line_count) {
            events.push(event);
        }
    }
    Ok(json!({
        "events": events,
        "fileSize": fs::metadata(path)?.len(),
        "lineCount": line_count,
        "token": token_for_path(&state.sessions_root, path),
        "path": relative_display(&state.codex_root, path),
    }))
}

fn token_for_path(sessions_root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(sessions_root).unwrap_or(path);
    URL_SAFE_NO_PAD.encode(relative.to_string_lossy().replace('\\', "/"))
}

fn path_for_token(sessions_root: &Path, token: &str) -> Result<PathBuf, String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| "invalid session token")?;
    let relative = String::from_utf8(decoded).map_err(|_| "invalid session token")?;
    let relative_path = Path::new(&relative);
    if relative_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        || relative_path.extension().and_then(|value| value.to_str()) != Some("jsonl")
    {
        return Err("invalid session path".to_owned());
    }
    Ok(sessions_root.join(relative_path))
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn session_id(path: &Path) -> String {
    static SESSION_ID: OnceLock<Regex> = OnceLock::new();
    let matcher = SESSION_ID.get_or_init(|| {
        Regex::new(r"(?i)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$")
            .expect("session id regex")
    });
    let display = path.to_string_lossy();
    matcher
        .captures(&display)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_owned()
        })
}

fn normalize_event(event: &Value, line: usize) -> Option<Value> {
    let payload = event.get("payload")?;
    let timestamp = event
        .get("timestamp")
        .or_else(|| payload.get("timestamp"))
        .or_else(|| payload.get("time"))
        .cloned()
        .unwrap_or(Value::Null);
    let event_type = event.get("type").and_then(Value::as_str)?;
    let payload_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if event_type == "event_msg" {
        return match payload_type {
            "user_message" => {
                message_event(line, "user", text_field(payload, "message"), timestamp)
            }
            "agent_message" => {
                message_event(line, "assistant", text_field(payload, "message"), timestamp)
            }
            "task_started" => Some(json!({
                "id": format!("line-{line}"), "line": line, "kind": "turn-start",
                "timestamp": timestamp, "turnId": payload.get("turn_id").cloned().unwrap_or(Value::Null),
            })),
            "task_complete" => Some(json!({
                "id": format!("line-{line}"), "line": line, "kind": "turn-complete",
                "timestamp": timestamp, "durationMs": payload.get("duration_ms").cloned().unwrap_or(Value::Null),
            })),
            "token_count" => Some(json!({
                "id": format!("line-{line}"), "line": line, "kind": "token",
                "timestamp": timestamp, "usage": token_usage(payload.get("info")),
            })),
            _ => None,
        };
    }
    if event_type != "response_item" {
        return None;
    }

    match payload_type {
        "message" if payload.get("role").and_then(Value::as_str) == Some("developer") => {
            message_event(
                line,
                "developer",
                as_text(payload.get("content")),
                timestamp,
            )
        }
        "reasoning" => {
            let summary = as_text(payload.get("summary"));
            if summary.is_empty() {
                return None;
            }
            Some(json!({
                "id": id_or_line(payload, line), "line": line, "kind": "reasoning-summary",
                "timestamp": timestamp, "markdown": summary, "searchText": summary,
            }))
        }
        "function_call" | "custom_tool_call" => {
            let is_function = payload_type == "function_call";
            let source = if is_function {
                payload.get("arguments")
            } else {
                payload.get("input")
            };
            let formatted = format_json_or_text(source);
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(if is_function { "function" } else { "tool" });
            let language = if is_function {
                "json"
            } else {
                infer_language(&formatted)
            };
            Some(json!({
                "id": id_or_line(payload, line), "line": line, "kind": "tool-call",
                "timestamp": timestamp, "name": name, "callId": call_id(payload),
                "codeText": formatted, "language": language, "searchText": format!("{name} {formatted}"),
            }))
        }
        "function_call_output" | "custom_tool_call_output" => {
            let formatted = format_json_or_text(payload.get("output"));
            let language = infer_language(&formatted);
            Some(json!({
                "id": id_or_line(payload, line), "line": line, "kind": "tool-output",
                "timestamp": timestamp, "callId": call_id(payload),
                "codeText": formatted, "language": language, "searchText": formatted,
            }))
        }
        _ => None,
    }
}

fn message_event(line: usize, role: &str, text: String, timestamp: Value) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    let kind = match role {
        "user" => "user",
        "developer" => "developer",
        _ => "assistant",
    };
    Some(json!({
        "id": format!("line-{line}"), "line": line, "kind": kind, "role": role,
        "timestamp": timestamp, "markdown": text, "searchText": text,
    }))
}

fn as_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn format_json_or_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|parsed| serde_json::to_string_pretty(&parsed).ok())
            .unwrap_or_else(|| text.to_owned());
    }
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn infer_language(text: &str) -> &'static str {
    let trimmed = text.trim_start();
    if trimmed.starts_with("diff --git ") || text.contains("\n+++ ") || text.contains("\n--- ") {
        "diff"
    } else if [
        "const ",
        "let ",
        "var ",
        "await ",
        "async ",
        "function ",
        "import ",
        "export ",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        "javascript"
    } else if [
        "PS ",
        "Get-",
        "Set-",
        "New-",
        "Remove-",
        "Start-Process",
        "Write-Host",
    ]
    .iter()
    .any(|needle| trimmed.starts_with(needle))
    {
        "powershell"
    } else if [
        "npm ", "node ", "git ", "cd ", "ls ", "rg ", "curl ", "ffmpeg ", "winget ",
    ]
    .iter()
    .any(|needle| trimmed.starts_with(needle))
    {
        "bash"
    } else {
        "text"
    }
}

fn token_usage(info: Option<&Value>) -> Value {
    let info = info.unwrap_or(&Value::Null);
    let total = info.get("total_token_usage").unwrap_or(&Value::Null);
    let last = info.get("last_token_usage").unwrap_or(&Value::Null);
    json!({
        "total": {
            "input": number(total, "input_tokens"), "cached": number(total, "cached_input_tokens"),
            "output": number(total, "output_tokens"), "reasoning": number(total, "reasoning_output_tokens"),
            "all": number(total, "total_tokens"),
        },
        "last": {
            "input": number(last, "input_tokens"), "cached": number(last, "cached_input_tokens"),
            "output": number(last, "output_tokens"), "reasoning": number(last, "reasoning_output_tokens"),
            "all": number(last, "total_tokens"),
        },
        "contextWindow": info.get("model_context_window").cloned().unwrap_or(Value::Null),
    })
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn id_or_line(payload: &Value, line: usize) -> String {
    payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("line-{line}"))
}

fn call_id(payload: &Value) -> String {
    payload
        .get("call_id")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn runtime_dir() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("CodexLiveWeb"))
}

fn write_pid_file() -> Option<PathBuf> {
    let directory = runtime_dir()?;
    fs::create_dir_all(&directory).ok()?;
    let path = directory.join("codex-live-web.pid");
    fs::write(&path, std::process::id().to_string()).ok()?;
    Some(path)
}

fn write_error_log(message: &str) {
    let Some(directory) = runtime_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&directory);
    let _ = fs::write(directory.join("codex-live-web-error.log"), message);
}

#[cfg(windows)]
fn open_browser(url: &str) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn open_browser(url: &str) -> io::Result<()> {
    Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_message_markdown_without_rendering_html() {
        let event = normalize_event(
            &json!({
                "timestamp": "2026-08-16T00:00:00Z",
                "type": "event_msg",
                "payload": { "type": "agent_message", "message": "第一段\n\n```js\nconst value = 42;\n```" },
            }),
            2,
        )
        .unwrap();
        assert_eq!(event["kind"], "assistant");
        assert!(event.get("html").is_none());
        assert!(event["markdown"].as_str().unwrap().contains("```js"));
    }

    #[test]
    fn never_exposes_encrypted_reasoning_without_summary() {
        let event = normalize_event(
            &json!({
                "type": "response_item",
                "payload": { "type": "reasoning", "summary": [], "encrypted_content": "secret" },
            }),
            3,
        );
        assert!(event.is_none());
    }

    #[test]
    fn normalizes_token_usage() {
        let event = normalize_event(
            &json!({
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": { "input_tokens": 120, "total_tokens": 160 },
                        "last_token_usage": { "input_tokens": 30, "total_tokens": 45 },
                        "model_context_window": 1000
                    }
                }
            }),
            4,
        )
        .unwrap();
        assert_eq!(event["usage"]["total"]["all"], 160);
        assert_eq!(event["usage"]["contextWindow"], 1000);
    }

    #[test]
    fn rejects_parent_components_in_session_tokens() {
        let token = URL_SAFE_NO_PAD.encode("../outside.jsonl");
        assert!(path_for_token(Path::new("sessions"), &token).is_err());
    }
}
