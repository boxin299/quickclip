use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::process::{Command, Child};
use std::sync::Mutex;
use std::time::Duration;
use std::net::{TcpStream, TcpListener};
use std::io::Write;
use std::path::PathBuf;
use tokio::time::sleep;
use base64::{Engine as _, engine::general_purpose};

#[derive(Serialize)]
pub struct BilibiliUserInfo {
    pub success: bool,
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    pub uid: Option<String>,
    #[serde(rename = "userName")]
    pub user_name: Option<String>,
    #[serde(rename = "userAvatar")]
    pub user_avatar: Option<String>,
}

struct BackendProcess(Mutex<Option<Child>>);

impl Drop for BackendProcess {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(ref mut child) = *guard {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn stop_backend_process(process_state: &BackendProcess) {
    if let Ok(mut guard) = process_state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn find_backend_python(resource_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // Dev source candidates. resource_dir varies by Tauri version/platform
    // (src-tauri/ or src-tauri/target/debug/), so try several upward depths.
    let dev_venv_candidates = [
        "../../backend/.venv/bin/python",
        "../../../backend/.venv/bin/python",
        "../../../../backend/.venv/bin/python",
    ];
    let bundled_python = resource_dir.join("backend-runtime/python/bin/python3");

    // In debug builds (tauri dev) prefer the dev venv so source changes take
    // effect without recompiling backend-runtime; in release prefer bundled.
    if cfg!(debug_assertions) {
        for relative in &dev_venv_candidates {
            let venv_python = resource_dir.join(relative);
            if venv_python.exists() {
                log::info!("Using dev venv Python: {}", venv_python.display());
                return Some(venv_python);
            }
        }
    }
    if bundled_python.exists() {
        log::info!("Using bundled Python: {}", bundled_python.display());
        return Some(bundled_python);
    }
    if !cfg!(debug_assertions) {
        for relative in &dev_venv_candidates {
            let venv_python = resource_dir.join(relative);
            if venv_python.exists() {
                return Some(venv_python);
            }
        }
    }
    // Fallback: system Python
    find_system_python()
}

fn find_system_python() -> Option<std::path::PathBuf> {
    if let Ok(paths) = std::env::var("PATH") {
        for dir in paths.split(':') {
            for name in &["python3", "python"] {
                let candidate = std::path::PathBuf::from(dir).join(name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    for path in &["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"] {
        let p = std::path::PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn find_backend_main(resource_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // Dev source candidates. resource_dir differs by platform/Tauri version
    // (src-tauri/ or src-tauri/target/debug/), so try 2/3/4-level upward paths.
    let dev_candidates = [
        "../../backend/app/main.py",
        "../../../backend/app/main.py",
        "../../../../backend/app/main.py",
    ];
    let prod_main = resource_dir.join("backend-runtime/app/main.py");

    // Debug builds (tauri dev): prefer source so edits apply without recompiling
    // backend-runtime. Release builds: prefer the bundled compiled backend.
    if cfg!(debug_assertions) {
        for relative in &dev_candidates {
            let candidate = resource_dir.join(relative);
            if candidate.exists() {
                log::info!("Using dev backend source: {}", candidate.display());
                return Some(candidate);
            }
        }
    }
    if prod_main.exists() {
        return Some(prod_main);
    }
    if !cfg!(debug_assertions) {
        for relative in &dev_candidates {
            let candidate = resource_dir.join(relative);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn start_backend(python: &std::path::Path, main_py: &std::path::Path, port: u16) -> Result<Child, String> {
    let app_dir = main_py.parent().unwrap().to_path_buf();
    let backend_dir = app_dir.parent().unwrap().to_path_buf();
    let lib_dir = backend_dir.join("lib");
    let site_packages = lib_dir.join("site-packages");
    let model_cache = backend_dir.join("data").join("modelscope");
    let _ = std::fs::create_dir_all(&model_cache);

    // Build PYTHONPATH to include bundled dependencies BEFORE system paths
    let pythonpath = format!("{}:{}", site_packages.display(), lib_dir.display());

    // Use uvicorn (same as dev mode) for reliable startup
    log::info!(
        "Starting backend: python={}, app_dir={}, port={}, pythonpath={}",
        python.display(),
        app_dir.display(),
        port,
        pythonpath
    );
    let child = Command::new(python)
        .arg("-m")
        .arg("uvicorn")
        .arg("main:app")
        .arg("--app-dir")
        .arg(&app_dir)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("PYTHONPATH", &pythonpath)
        .env("MODELSCOPE_CACHE", &model_cache)
        .env("APP_BACKEND_PORT", port.to_string())
        .env("PYTHONUNBUFFERED", "1")
        .current_dir(&backend_dir)
        .spawn()
        .map_err(|e| format!("spawn failed: {} (python={}, app_dir={})", e, python.display(), app_dir.display()))?;

    log::info!("Backend started with PID {}", child.id());
    Ok(child)
}

#[tauri::command]
async fn open_bilibili_login(app: AppHandle) -> Result<BilibiliUserInfo, String> {
    let window_label = "bilibili_login";
    if let Some(win) = app.get_webview_window(window_label) {
        let _ = win.close();
    }

    let inject_js = r#"
        setInterval(() => {
            if (window.location.href.includes('bilibili.com')) {
                fetch('https://api.bilibili.com/x/web-interface/nav')
                    .then(r => r.json())
                    .then(data => {
                        if (data.code === 0 && data.data.isLogin) {
                            document.title = "BILI_USER|" + data.data.mid + "|" + data.data.uname + "|" + data.data.face;
                        }
                    }).catch(e => {});
            }
        }, 2000);
    "#;

    let win = WebviewWindowBuilder::new(&app, window_label, WebviewUrl::External("https://passport.bilibili.com/login".parse().unwrap()))
        .title("Bilibili Login")
        .inner_size(1000.0, 700.0)
        .initialization_script(inject_js)
        .build()
        .map_err(|e| e.to_string())?;

    for _ in 0..150 {
        sleep(Duration::from_secs(2)).await;
        if app.get_webview_window(window_label).is_none() {
            break; // window closed
        }
        if let Ok(title) = win.title() {
            if title.starts_with("BILI_USER|") {
                let parts: Vec<&str> = title.split('|').collect();
                if parts.len() >= 4 {
                    let mid = parts[1].to_string();
                    let uname = parts[2].to_string();
                    let face_url = parts[3].to_string();
                    let _ = win.close();

                    // Fetch avatar as base64
                    let mut user_avatar = None;
                    if let Ok(client) = reqwest::Client::builder().user_agent("Mozilla/5.0").build() {
                        if let Ok(resp) = client.get(&face_url).send().await {
                            if let Ok(bytes) = resp.bytes().await {
                                let base64_str = general_purpose::STANDARD.encode(&bytes);
                                user_avatar = Some(format!("data:image/jpeg;base64,{}", base64_str));
                            }
                        }
                    }

                    return Ok(BilibiliUserInfo {
                        success: true,
                        user_id: Some(mid.clone()),
                        uid: Some(mid),
                        user_name: Some(uname),
                        user_avatar,
                    });
                }
            }
        }
    }

    let _ = win.close();
    Ok(BilibiliUserInfo { success: false, user_id: None, uid: None, user_name: None, user_avatar: None })
}

#[tauri::command]
fn copy_sound_file(source: String, dest: String) -> Result<String, String> {
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    std::fs::copy(&source, &dest)
        .map_err(|e| format!("copy {} -> {}: {}", source, dest, e))?;
    Ok(dest)
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("open -R {} failed: {}", path, e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("open -R {} failed with status {}", path, status))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn is_quickclip_health_payload(json: &serde_json::Value) -> bool {
    json.get("status").and_then(|v| v.as_str()) == Some("ok")
        && json
            .get("message")
            .and_then(|v| v.as_str())
            .map(|message| message.contains("DaVinci Resolve") || message.contains("QuickClip"))
            .unwrap_or(false)
}

async fn check_backend_health(port: u16) -> bool {
    // 根路径 "/" 返回 {"status":"ok",...}；/api/status 返回的是达芬奇连接状态
    // (无 status 字段)，不能用作健康探测。
    let url = format!("http://127.0.0.1:{}/", port);
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                return false;
            }
            match resp.json::<serde_json::Value>().await {
                Ok(json) => is_quickclip_health_payload(&json),
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

fn kill_process_on_port(port: u16) {
    if let Ok(output) = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let pid_str = line.trim();
            if let Ok(pid) = pid_str.parse::<i32>() {
                log::info!("Killing process {} on port {}", pid, port);
                let _ = Command::new("kill").arg(pid.to_string()).output();
            }
        }
    }
}

fn find_available_port(start: u16, max_attempts: u16) -> Option<u16> {
    for offset in 0..max_attempts {
        let port = start + offset;
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

fn is_backend_port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn find_running_backend_port(start: u16, max_attempts: u16) -> Option<u16> {
    for offset in 0..max_attempts {
        let port = start + offset;
        if is_backend_port_open(port) {
            return Some(port);
        }
    }
    None
}

fn write_backend_port_file(port: u16) {
    let port_file = std::env::temp_dir().join("quickclip_backend_port");
    if let Ok(mut f) = std::fs::File::create(&port_file) {
        let _ = writeln!(f, "{}", port);
        log::info!("Backend port {} written to {}", port, port_file.display());
    }
}

fn should_reuse_running_backend() -> bool {
    false
}

fn parse_ioplatform_uuid(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            let value = line
                .split('=')
                .nth(1)?
                .trim()
                .trim_matches('"')
                .trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[tauri::command]
fn get_machine_id() -> String {
    if let Ok(output) = std::process::Command::new("ioreg")
        .args(["-d2", "-c", "IOPlatformExpertDevice"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(machine_id) = parse_ioplatform_uuid(&stdout) {
            return machine_id;
        }
    }
    "unknown-tauri".to_string()
}

#[cfg(test)]
mod tests {
    use super::{is_quickclip_health_payload, parse_ioplatform_uuid, should_reuse_running_backend};

    #[test]
    fn parses_ioplatform_uuid_value() {
        let sample = r#"
            | |   "IOPlatformUUID" = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
        "#;

        assert_eq!(
            parse_ioplatform_uuid(sample),
            Some("A1B2C3D4-E5F6-7890-ABCD-EF1234567890".to_string())
        );
    }

    #[test]
    fn app_owned_backend_is_not_reused() {
        assert!(!should_reuse_running_backend());
    }

    #[test]
    fn recognizes_only_quickclip_health_payloads() {
        assert!(is_quickclip_health_payload(&serde_json::json!({
            "status": "ok",
            "message": "DaVinci Resolve 剪辑助手后端服务运行中"
        })));
        assert!(is_quickclip_health_payload(&serde_json::json!({
            "status": "ok",
            "message": "QuickClip backend"
        })));
        assert!(!is_quickclip_health_payload(&serde_json::json!({
            "status": "ok"
        })));
        assert!(!is_quickclip_health_payload(&serde_json::json!({
            "status": "ok",
            "message": "other local service"
        })));
    }
}

#[tauri::command]
fn get_backend_port(state: tauri::State<'_, BackendPort>) -> u16 {
    *state.0.lock().unwrap_or_else(|e| e.into_inner())
}

struct BackendPort(Mutex<u16>);

struct BackendPaths {
    python: std::path::PathBuf,
    main_py: std::path::PathBuf,
}

#[tauri::command]
async fn login_and_start_backend(app: AppHandle) -> Result<u16, String> {
    let preferred_port = std::env::var("APP_BACKEND_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(18000);

    // First, check if a backend is already running and verify it's healthy.
    // In `tauri dev`, always restart so start-app.command cannot attach to a
    // stale backend left on port 18000 from an earlier run.
    if let Some(port) = find_running_backend_port(preferred_port, 100) {
        log::info!("Found existing backend on port {}, checking health...", port);
        let is_quickclip_backend = check_backend_health(port).await;
        if should_reuse_running_backend() && is_quickclip_backend {
            log::info!("Backend on port {} is healthy, reusing", port);
            let state_port = app.state::<BackendPort>();
            *state_port.0.lock().unwrap() = port;
            write_backend_port_file(port);
            resize_main_window(&app);
            return Ok(port);
        }
        if is_quickclip_backend {
            log::warn!("QuickClip backend on port {} will be restarted...", port);
            kill_process_on_port(port);
            if let Some(process_state) = app.try_state::<BackendProcess>() {
                let mut guard = process_state.0.lock().unwrap();
                if let Some(mut old_child) = guard.take() {
                    let _ = old_child.kill();
                    let _ = old_child.wait();
                }
            }
            // Small delay to let the OS release the port
            sleep(Duration::from_millis(500)).await;
        } else {
            log::warn!(
                "Port {} is occupied by a non-QuickClip service; starting backend on another port",
                port
            );
        }
    }

    // No backend running — start one
    let expected_port = find_available_port(preferred_port, 100).unwrap_or(preferred_port);
    if expected_port != preferred_port {
        log::info!(
            "Port {} occupied, using port {}",
            preferred_port,
            expected_port
        );
    }

    let state_paths = app.try_state::<BackendPaths>().ok_or_else(|| {
        let resource_dir = app.path().resource_dir().unwrap_or_default();
        let py = find_backend_python(&resource_dir);
        let main = find_backend_main(&resource_dir);
        format!(
            "后端路径未初始化: python={} main={} resource_dir={}",
            py.map(|p| p.display().to_string()).unwrap_or_else(|| "NOT_FOUND".into()),
            main.map(|p| p.display().to_string()).unwrap_or_else(|| "NOT_FOUND".into()),
            resource_dir.display()
        )
    })?;

    // Kill existing backend process if any
    if let Some(process_state) = app.try_state::<BackendProcess>() {
        let mut guard = process_state.0.lock().unwrap();
        if let Some(mut old_child) = guard.take() {
            let _ = old_child.kill();
            let _ = old_child.wait();
        }
    }

    let child = match start_backend(&state_paths.python, &state_paths.main_py, expected_port) {
        Ok(c) => c,
        Err(e) => return Err(format!("启动后端失败: {}", e)),
    };
    if let Some(process_state) = app.try_state::<BackendProcess>() {
        *process_state.0.lock().unwrap() = Some(child);
    } else {
        app.manage(BackendProcess(Mutex::new(Some(child))));
    }

    // Wait for backend to be ready
    let mut resolved_port = None;
    for _ in 0..120 {
        if is_backend_port_open(expected_port) {
            log::info!("Backend ready on port {}", expected_port);
            resolved_port = Some(expected_port);
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }

    let resolved_port = resolved_port.ok_or_else(|| {
        log::warn!("Backend did not become ready within 60s on port {}", expected_port);
        "后端启动超时，请稍后重试".to_string()
    })?;

    {
        let state_port = app.state::<BackendPort>();
        *state_port.0.lock().unwrap() = resolved_port;
    }
    write_backend_port_file(resolved_port);
    resize_main_window(&app);

    Ok(resolved_port)
}

#[derive(Serialize, Deserialize)]
struct WindowSize {
    width: f64,
    height: f64,
}

fn get_window_size_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("window_size.json"))
}

fn load_window_size(app: &AppHandle) -> Option<(f64, f64)> {
    let path = get_window_size_path(app)?;
    let json = std::fs::read_to_string(path).ok()?;
    let size: WindowSize = serde_json::from_str(&json).ok()?;
    if size.width >= 1000.0 && size.height >= 700.0 {
        Some((size.width, size.height))
    } else {
        None
    }
}

fn save_window_size(app: &AppHandle, width: f64, height: f64) {
    if let Some(path) = get_window_size_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&WindowSize { width, height }) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn resize_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_resizable(true);
        let _ = window.set_maximizable(true);
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(1000.0, 700.0)));

        let (width, height) = load_window_size(app).unwrap_or((1000.0, 700.0));
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        let _ = window.center();

        let app_handle = app.clone();
        let _ = window.on_window_event(move |event| {
            match event {
                tauri::WindowEvent::Resized(size) => {
                    // Convert physical pixels to logical — Resized gives physical size
                    let scale = app_handle
                        .get_webview_window("main")
                        .and_then(|w| w.scale_factor().ok())
                        .unwrap_or(1.0);
                    save_window_size(
                        &app_handle,
                        size.width as f64 / scale,
                        size.height as f64 / scale,
                    );
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Some(process_state) = app_handle.try_state::<BackendProcess>() {
                        stop_backend_process(&process_state);
                    }
                    app_handle.exit(0);
                }
                _ => {}
            }
        });
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    // Don't resize here — login page uses the default 800×560.
    // resize_main_window is called later by login_and_start_backend after auth.
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            app.manage(BackendPort(Mutex::new(0))); // Initial placeholder value
            
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let resource_dir = app.path().resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));

            let python = find_backend_python(&resource_dir);
            let main_py = find_backend_main(&resource_dir);

            if let (Some(python), Some(main_py)) = (&python, &main_py) {
                // We no longer auto-start the backend here.
                // We just store the paths in State so that `login_and_start_backend` can use them.
                app.manage(BackendPaths {
                    python: python.clone(),
                    main_py: main_py.clone(),
                });
            }

            let _main_win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("/".into()))
                .title("QuickClip")
                .inner_size(800.0, 560.0) // Matching launcher-frame size
                .min_inner_size(800.0, 560.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(true)
                .visible(false) // Hidden until frontend signals ready
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(19.0, 25.0))
                .build()
                .map_err(|e| log::error!("Failed to create main window: {}", e));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_machine_id,
            open_bilibili_login,
            copy_sound_file,
            reveal_in_finder,
            open_url,
            get_backend_port,
            login_and_start_backend,
            show_main_window,
            fetch_proxy,
            fetch_proxy_test,
            ping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[derive(Deserialize)]
struct FetchProxyArgs {
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
}

#[tauri::command]
async fn fetch_proxy_test(args: FetchProxyArgs) -> Result<serde_json::Value, String> {
    let _ = &args; // same signature, no reqwest
    Ok(serde_json::json!({"status": 200, "ok": true, "body": {"test": true, "url": args.url}}))
}

#[tauri::command]
async fn fetch_proxy(args: FetchProxyArgs) -> Result<serde_json::Value, String> {
    // Step 1: verify we can receive args
    let method = args.method.unwrap_or_else(|| "GET".into());
    // Step 2: make the actual HTTP request via reqwest
    let client = reqwest::Client::builder()
        .user_agent("QuickClip/1.0")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client build error: {}", e))?;
    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(&args.url),
        "PUT" => client.put(&args.url),
        "DELETE" => client.delete(&args.url),
        "PATCH" => client.patch(&args.url),
        _ => client.get(&args.url),
    };
    if let Some(headers) = &args.headers {
        for (k, v) in headers {
            req = req.header(k, v);
        }
    }
    if let Some(body) = &args.body {
        req = req.header("Content-Type", "application/json").body(body.clone());
    }
    let resp = req.send().await.map_err(|e| format!("request failed: {}", e))?;
    let status = resp.status().as_u16();
    let body_text = resp.text().await.map_err(|e| format!("read response: {}", e))?;
    // Try JSON parse, fall back to raw string
    let body_value: serde_json::Value = serde_json::from_str(&body_text)
        .unwrap_or_else(|_| serde_json::Value::String(body_text));
    Ok(serde_json::json!({
        "status": status,
        "ok": status >= 200 && status < 300,
        "body": body_value
    }))
}
