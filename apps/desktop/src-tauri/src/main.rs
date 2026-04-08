#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use std::fs::OpenOptions;

use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, Manager, RunEvent, Runtime};

const CONTROL_PLANE_STARTUP_POLL_ATTEMPTS: usize = 20;
const CONTROL_PLANE_STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(250);
const CONTROL_PLANE_SUPERVISOR_INTERVAL: Duration = Duration::from_secs(2);
const FILE_TREE_MAX_DEPTH: usize = 4;
const FILE_TREE_MAX_ENTRIES_PER_DIR: usize = 48;
const FILE_PREVIEW_MAX_BYTES: usize = 24 * 1024;
const TERMINAL_OUTPUT_MAX_BYTES: usize = 32 * 1024;
const PROVIDER_KEYCHAIN_SERVICE: &str = "com.acc.desktop.providers";

struct ManagedControlPlane {
    child: Option<Child>,
    app_owned: bool,
    shutting_down: bool,
    last_error: Option<String>,
}

struct ControlPlaneState(Arc<Mutex<ManagedControlPlane>>);

struct ControlPlaneLaunch {
    child: Option<Child>,
    app_owned: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ProviderSettings {
    openai_api_key: Option<String>,
    anthropic_api_key: Option<String>,
    coordination_api_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSettingsStatus {
    openai_configured: bool,
    anthropic_configured: bool,
    coordination_configured: bool,
    applied_to_embedded_control_plane: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SaveProviderSettingsRequest {
    openai_api_key: Option<String>,
    anthropic_api_key: Option<String>,
    coordination_api_key: Option<String>,
    clear_openai: bool,
    clear_anthropic: bool,
    clear_coordination: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlPlaneRuntimeStatus {
    reachable: bool,
    app_owned: bool,
    last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeNode {
    name: String,
    path: String,
    kind: String,
    children: Vec<FileTreeNode>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextFilePreview {
    path: String,
    content: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCommandResult {
    command: String,
    cwd: String,
    exit_code: i32,
    stdout: String,
    stderr: String,
}

fn control_plane_address() -> SocketAddr {
    "127.0.0.1:7711"
        .parse()
        .expect("control plane socket address should be valid")
}

fn control_plane_is_running() -> bool {
    TcpStream::connect_timeout(&control_plane_address(), Duration::from_millis(250)).is_ok()
}

fn wait_for_control_plane_startup(child: &mut Child) -> io::Result<()> {
    for _ in 0..CONTROL_PLANE_STARTUP_POLL_ATTEMPTS {
        if control_plane_is_running() {
            return Ok(());
        }

        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "embedded control plane exited before startup completed: {status}"
            )));
        }

        thread::sleep(CONTROL_PLANE_STARTUP_POLL_INTERVAL);
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "embedded control plane did not become reachable in time",
    ))
}

fn resource_path<R: Runtime>(app: &tauri::AppHandle<R>, relative: &str) -> tauri::Result<PathBuf> {
    let direct = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(relative)
    } else {
        app.path().resolve(relative, BaseDirectory::Resource)?
    };

    if direct.exists() {
        return Ok(direct);
    }

    let nested_relative = PathBuf::from("resources").join(relative);
    let nested = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(&nested_relative)
    } else {
        app.path().resolve(&nested_relative, BaseDirectory::Resource)?
    };

    if nested.exists() {
        return Ok(nested);
    }

    Ok(direct)
}

fn app_data_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> io::Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| io::Error::other(error.to_string()))
}

fn provider_settings_path<R: Runtime>(app: &tauri::AppHandle<R>) -> io::Result<PathBuf> {
    Ok(app_data_dir(app)?.join("settings").join("provider-settings.json"))
}

fn load_legacy_provider_settings<R: Runtime>(app: &tauri::AppHandle<R>) -> io::Result<ProviderSettings> {
    let path = provider_settings_path(app)?;

    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ProviderSettings::default()),
        Err(error) => Err(error),
    }
}

fn delete_legacy_provider_settings<R: Runtime>(app: &tauri::AppHandle<R>) -> io::Result<()> {
    let path = provider_settings_path(app)?;

    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn provider_keychain_account(provider: &str) -> String {
    format!("{}.api-key", provider)
}

fn read_keychain_secret(account: &str) -> io::Result<Option<String>> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            account,
            "-s",
            PROVIDER_KEYCHAIN_SERVICE,
            "-w",
        ])
        .output()?;

    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if value.is_empty() { None } else { Some(value) });
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found") {
        return Ok(None);
    }

    Err(io::Error::other(stderr.trim().to_string()))
}

fn write_keychain_secret(account: &str, value: &str) -> io::Result<()> {
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            account,
            "-s",
            PROVIDER_KEYCHAIN_SERVICE,
            "-w",
            value,
            "-U",
        ])
        .output()?;

    if output.status.success() {
        return Ok(());
    }

    Err(io::Error::other(
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

fn delete_keychain_secret(account: &str) -> io::Result<()> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            account,
            "-s",
            PROVIDER_KEYCHAIN_SERVICE,
        ])
        .output()?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found") {
        return Ok(());
    }

    Err(io::Error::other(stderr.trim().to_string()))
}

fn load_provider_settings<R: Runtime>(app: &tauri::AppHandle<R>) -> io::Result<ProviderSettings> {
    let mut settings = ProviderSettings {
        openai_api_key: read_keychain_secret(&provider_keychain_account("openai"))?,
        anthropic_api_key: read_keychain_secret(&provider_keychain_account("anthropic"))?,
        coordination_api_key: read_keychain_secret(&provider_keychain_account("coordination"))?,
    };
    let legacy = load_legacy_provider_settings(app).unwrap_or_default();
    let mut migrated = false;

    if settings.openai_api_key.is_none() && legacy.openai_api_key.is_some() {
        settings.openai_api_key = legacy.openai_api_key.clone();
        migrated = true;
    }

    if settings.anthropic_api_key.is_none() && legacy.anthropic_api_key.is_some() {
        settings.anthropic_api_key = legacy.anthropic_api_key.clone();
        migrated = true;
    }

    if migrated {
        if let Some(openai_api_key) = settings.openai_api_key.as_deref() {
            write_keychain_secret(&provider_keychain_account("openai"), openai_api_key)?;
        }

        if let Some(anthropic_api_key) = settings.anthropic_api_key.as_deref() {
            write_keychain_secret(
                &provider_keychain_account("anthropic"),
                anthropic_api_key,
            )?;
        }

        delete_legacy_provider_settings(app)?;
    }

    Ok(settings)
}

fn persist_provider_settings<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &ProviderSettings,
) -> io::Result<()> {
    if let Some(openai_api_key) = settings.openai_api_key.as_deref() {
        write_keychain_secret(&provider_keychain_account("openai"), openai_api_key)?;
    } else {
        delete_keychain_secret(&provider_keychain_account("openai"))?;
    }

    if let Some(anthropic_api_key) = settings.anthropic_api_key.as_deref() {
        write_keychain_secret(
            &provider_keychain_account("anthropic"),
            anthropic_api_key,
        )?;
    } else {
        delete_keychain_secret(&provider_keychain_account("anthropic"))?;
    }

    if let Some(coordination_api_key) = settings.coordination_api_key.as_deref() {
        write_keychain_secret(
            &provider_keychain_account("coordination"),
            coordination_api_key,
        )?;
    } else {
        delete_keychain_secret(&provider_keychain_account("coordination"))?;
    }

    delete_legacy_provider_settings(app)?;
    Ok(())
}

fn normalize_secret(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();

        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn trim_output(mut value: String, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value, false);
    }

    value.truncate(limit);
    value.push_str("\n… output truncated …");
    (value, true)
}

fn should_skip_tree_entry(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some(
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".turbo"
                | ".idea"
                | ".DS_Store"
        )
    )
}

fn build_tree_nodes(path: &Path, depth: usize) -> io::Result<Vec<FileTreeNode>> {
    if depth >= FILE_TREE_MAX_DEPTH {
        return Ok(Vec::new());
    }

    let mut entries = fs::read_dir(path)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| !should_skip_tree_entry(&entry.path()))
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        let left_is_dir = left.file_type().map(|value| value.is_dir()).unwrap_or(false);
        let right_is_dir = right.file_type().map(|value| value.is_dir()).unwrap_or(false);
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    let extra_count = entries.len().saturating_sub(FILE_TREE_MAX_ENTRIES_PER_DIR);
    let mut nodes = Vec::new();

    for entry in entries.into_iter().take(FILE_TREE_MAX_ENTRIES_PER_DIR) {
        let entry_path = entry.path();
        let metadata = entry.metadata()?;
        let is_dir = metadata.is_dir();
        let mut children = Vec::new();

        if is_dir {
            children = build_tree_nodes(&entry_path, depth + 1)?;
        }

        nodes.push(FileTreeNode {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry_path.to_string_lossy().to_string(),
            kind: if is_dir {
                "directory".to_string()
            } else {
                "file".to_string()
            },
            children,
            truncated: false,
        });
    }

    if extra_count > 0 {
        nodes.push(FileTreeNode {
            name: format!("{extra_count} more items"),
            path: path.to_string_lossy().to_string(),
            kind: "directory".to_string(),
            children: Vec::new(),
            truncated: true,
        });
    }

    Ok(nodes)
}

fn provider_settings_status(
    settings: &ProviderSettings,
    applied_to_embedded_control_plane: bool,
) -> ProviderSettingsStatus {
    ProviderSettingsStatus {
        openai_configured: settings.openai_api_key.is_some(),
        anthropic_configured: settings.anthropic_api_key.is_some(),
        coordination_configured: settings.coordination_api_key.is_some(),
        applied_to_embedded_control_plane,
    }
}

fn start_control_plane<R: Runtime>(app: &tauri::AppHandle<R>) -> io::Result<ControlPlaneLaunch> {
    if control_plane_is_running() {
        return Ok(ControlPlaneLaunch {
            child: None,
            app_owned: false,
        });
    }

    let app_data_dir = app_data_dir(app)?;
    let storage_dir = app_data_dir.join("control-plane");
    let database_path = storage_dir.join("control-plane.sqlite");

    fs::create_dir_all(&storage_dir)?;

    let node_path =
        resource_path(app, "bin/acc-node").map_err(|error| io::Error::other(error.to_string()))?;
    let entry_path = resource_path(app, "control-plane/index.cjs")
        .map_err(|error| io::Error::other(error.to_string()))?;
    let provider_settings = load_provider_settings(app).unwrap_or_else(|error| {
        eprintln!("failed to load provider settings: {error}");
        ProviderSettings::default()
    });

    let mut command = Command::new(node_path);
    command
        .arg(entry_path)
        .env("NODE_NO_WARNINGS", "1")
        .env("ACC_HOST", "127.0.0.1")
        .env("ACC_PORT", "7711")
        .env("ACC_STORAGE_DIR", &storage_dir)
        .env("ACC_DATABASE_PATH", &database_path)
        .env("ACC_AUTO_MIGRATE", "true");

    if let Some(openai_api_key) = provider_settings.openai_api_key.as_deref() {
        command.env("OPENAI_API_KEY", openai_api_key);
    }

    if let Some(anthropic_api_key) = provider_settings.anthropic_api_key.as_deref() {
        command.env("ANTHROPIC_API_KEY", anthropic_api_key);
    }

    if let Some(coordination_api_key) = provider_settings.coordination_api_key.as_deref() {
        command.env("ACC_COORDINATION_KEY", coordination_api_key);
    }

    // Always write control-plane output to a log file so diagnostics are accessible.
    let log_path = storage_dir.join("control-plane.log");
    match OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(log_file) => {
            let log_file2 = log_file.try_clone().unwrap_or_else(|_| {
                OpenOptions::new().create(true).append(true).open(&log_path).unwrap()
            });
            command.stdout(Stdio::from(log_file)).stderr(Stdio::from(log_file2));
        }
        Err(_) => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    let mut child = command.spawn()?;

    if let Err(error) = wait_for_control_plane_startup(&mut child) {
        kill_child(&mut child);
        return Err(error);
    }

    Ok(ControlPlaneLaunch {
        child: Some(child),
        app_owned: true,
    })
}

fn update_control_plane_state<R: Runtime>(app: &tauri::AppHandle<R>, launch: ControlPlaneLaunch) {
    let state = app.state::<ControlPlaneState>();
    let mut guard = state.0.lock().unwrap();
    guard.child = launch.child;
    guard.app_owned = launch.app_owned;
    guard.shutting_down = false;
    guard.last_error = None;
}

fn record_control_plane_error<R: Runtime>(app: &tauri::AppHandle<R>, error: impl Into<String>) {
    let state = app.state::<ControlPlaneState>();
    let mut guard = state.0.lock().unwrap();
    guard.child = None;
    guard.app_owned = true;
    guard.shutting_down = false;
    guard.last_error = Some(error.into());
}

fn embedded_control_plane_is_applied<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let state = app.state::<ControlPlaneState>();
    let guard = state.0.lock().unwrap();
    guard.app_owned && guard.last_error.is_none() && control_plane_is_running()
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn restart_managed_control_plane<R: Runtime>(app: &tauri::AppHandle<R>) -> io::Result<bool> {
    let (app_owned, child) = {
        let state = app.state::<ControlPlaneState>();
        let mut guard = state.0.lock().unwrap();
        let child = guard.child.take();
        let app_owned = guard.app_owned;
        guard.app_owned = false;
        (app_owned, child)
    };

    if let Some(mut child) = child {
        kill_child(&mut child);
    }

    if !app_owned {
        return Ok(false);
    }

    let launch = start_control_plane(app)?;
    update_control_plane_state(app, launch);
    Ok(true)
}

fn stop_control_plane<R: Runtime>(app: &tauri::AppHandle<R>) {
    let child = {
        let state = app.state::<ControlPlaneState>();
        let mut guard = state.0.lock().unwrap();
        guard.shutting_down = true;
        guard.app_owned = false;
        guard.child.take()
    };

    if let Some(mut child) = child {
        kill_child(&mut child);
    }
}

fn spawn_control_plane_supervisor<R: Runtime>(app: tauri::AppHandle<R>) {
    let state = app.state::<ControlPlaneState>().0.clone();
    let app_handle = app.clone();

    thread::spawn(move || loop {
        thread::sleep(CONTROL_PLANE_SUPERVISOR_INTERVAL);

        let should_restart = {
            let mut guard = state.lock().unwrap();

            if guard.shutting_down {
                return;
            }

            if !guard.app_owned {
                false
            } else if let Some(child) = guard.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        eprintln!("embedded control plane exited with status {status}; restarting");
                        guard.child.take();
                        true
                    }
                    Ok(None) => false,
                    Err(error) => {
                        eprintln!(
                            "failed to inspect embedded control plane status ({error}); restarting"
                        );
                        if let Some(mut child) = guard.child.take() {
                            kill_child(&mut child);
                        }
                        true
                    }
                }
            } else {
                true
            }
        };

        if !should_restart {
            continue;
        }

        match start_control_plane(&app_handle) {
            Ok(launch) => update_control_plane_state(&app_handle, launch),
            Err(error) => {
                eprintln!("failed to restart embedded control plane: {error}");
                record_control_plane_error(&app_handle, error.to_string());
            }
        }
    });
}

#[tauri::command]
fn get_provider_settings(app: tauri::AppHandle) -> Result<ProviderSettingsStatus, String> {
    let settings = load_provider_settings(&app).map_err(|error| error.to_string())?;
    Ok(provider_settings_status(
        &settings,
        embedded_control_plane_is_applied(&app),
    ))
}

#[tauri::command]
fn save_provider_settings(
    app: tauri::AppHandle,
    request: SaveProviderSettingsRequest,
) -> Result<ProviderSettingsStatus, String> {
    let mut settings = load_provider_settings(&app).map_err(|error| error.to_string())?;

    if request.clear_openai {
        settings.openai_api_key = None;
    } else if let Some(openai_api_key) = normalize_secret(request.openai_api_key) {
        settings.openai_api_key = Some(openai_api_key);
    }

    if request.clear_anthropic {
        settings.anthropic_api_key = None;
    } else if let Some(anthropic_api_key) = normalize_secret(request.anthropic_api_key) {
        settings.anthropic_api_key = Some(anthropic_api_key);
    }

    if request.clear_coordination {
        settings.coordination_api_key = None;
    } else if let Some(coordination_api_key) = normalize_secret(request.coordination_api_key) {
        settings.coordination_api_key = Some(coordination_api_key);
    }

    persist_provider_settings(&app, &settings).map_err(|error| error.to_string())?;
    let applied_to_embedded_control_plane =
        restart_managed_control_plane(&app).map_err(|error| error.to_string())?;

    Ok(provider_settings_status(
        &settings,
        applied_to_embedded_control_plane,
    ))
}

#[tauri::command]
fn get_control_plane_runtime_status(app: tauri::AppHandle) -> ControlPlaneRuntimeStatus {
    let state = app.state::<ControlPlaneState>();
    let guard = state.0.lock().unwrap();

    ControlPlaneRuntimeStatus {
        reachable: control_plane_is_running(),
        app_owned: guard.app_owned,
        last_error: guard.last_error.clone(),
    }
}

#[tauri::command]
fn list_project_tree(root: String) -> Result<Vec<FileTreeNode>, String> {
    let root_path = PathBuf::from(root);
    let canonical_root = fs::canonicalize(&root_path).map_err(|error| error.to_string())?;

    if !canonical_root.is_dir() {
        return Err("Project root must be a directory.".to_string());
    }

    build_tree_nodes(&canonical_root, 0).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_text_file(path: String, allowed_roots: Vec<String>) -> Result<TextFilePreview, String> {
    let canonical_path = fs::canonicalize(PathBuf::from(&path)).map_err(|error| error.to_string())?;

    if !canonical_path.is_file() {
        return Err("The selected path is not a file.".to_string());
    }

    if !allowed_roots.is_empty() && !is_within_any_root(&canonical_path, &allowed_roots) {
        return Err("Access denied: path is outside allowed roots".into());
    }

    let bytes = fs::read(&canonical_path).map_err(|error| error.to_string())?;
    let slice = bytes
        .get(..bytes.len().min(FILE_PREVIEW_MAX_BYTES))
        .ok_or_else(|| "Failed to read the selected file.".to_string())?;
    let content = String::from_utf8_lossy(slice).to_string();

    Ok(TextFilePreview {
        path: canonical_path.to_string_lossy().to_string(),
        content,
        truncated: bytes.len() > FILE_PREVIEW_MAX_BYTES,
    })
}

#[tauri::command]
fn write_text_file(path: String, content: String, allowed_roots: Vec<String>) -> Result<TextFilePreview, String> {
    let canonical_path = fs::canonicalize(PathBuf::from(&path)).map_err(|error| error.to_string())?;

    if !canonical_path.is_file() {
        return Err("The selected path is not a file.".to_string());
    }

    if !is_within_any_root(&canonical_path, &allowed_roots) {
        return Err("File path is outside the allowed workspace root.".to_string());
    }

    fs::write(&canonical_path, content.as_bytes()).map_err(|error| error.to_string())?;

    let bytes = fs::read(&canonical_path).map_err(|error| error.to_string())?;
    let slice = bytes
        .get(..bytes.len().min(FILE_PREVIEW_MAX_BYTES))
        .ok_or_else(|| "Failed to read the saved file.".to_string())?;
    let saved_content = String::from_utf8_lossy(slice).to_string();

    Ok(TextFilePreview {
        path: canonical_path.to_string_lossy().to_string(),
        content: saved_content,
        truncated: bytes.len() > FILE_PREVIEW_MAX_BYTES,
    })
}

fn is_within_any_root(cwd: &std::path::Path, allowed_roots: &[String]) -> bool {
    allowed_roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|canonical_root| cwd.starts_with(&canonical_root))
            .unwrap_or(false)
    })
}

#[tauri::command]
fn run_terminal_command(cwd: String, command: String, allowed_roots: Vec<String>) -> Result<TerminalCommandResult, String> {
    let canonical_cwd = fs::canonicalize(PathBuf::from(&cwd)).map_err(|error| error.to_string())?;

    if !canonical_cwd.is_dir() {
        return Err("Terminal cwd must be a directory.".to_string());
    }

    if !is_within_any_root(&canonical_cwd, &allowed_roots) {
        return Err("Terminal cwd is outside the allowed workspace root.".to_string());
    }

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", command.as_str()])
            .current_dir(&canonical_cwd)
            .output()
    } else {
        Command::new("sh")
            .args(["-lc", command.as_str()])
            .current_dir(&canonical_cwd)
            .output()
    }
    .map_err(|error| error.to_string())?;

    let (stdout, _) = trim_output(String::from_utf8_lossy(&output.stdout).to_string(), TERMINAL_OUTPUT_MAX_BYTES);
    let (stderr, _) = trim_output(String::from_utf8_lossy(&output.stderr).to_string(), TERMINAL_OUTPUT_MAX_BYTES);

    Ok(TerminalCommandResult {
        command,
        cwd: canonical_cwd.to_string_lossy().to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

fn main() {
    let app = tauri::Builder::default()
        .manage(ControlPlaneState(Arc::new(Mutex::new(ManagedControlPlane {
            child: None,
            app_owned: false,
            shutting_down: false,
            last_error: None,
        }))))
        .invoke_handler(tauri::generate_handler![
            get_provider_settings,
            save_provider_settings,
            get_control_plane_runtime_status,
            list_project_tree,
            read_text_file,
            write_text_file,
            run_terminal_command
        ])
        .setup(|app| {
            match start_control_plane(&app.handle()) {
                Ok(launch) => update_control_plane_state(&app.handle(), launch),
                Err(error) => {
                    eprintln!("failed to start embedded control plane during app setup: {error}");
                    record_control_plane_error(&app.handle(), error.to_string());
                }
            }

            spawn_control_plane_supervisor(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build desktop shell");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_control_plane(app_handle);
        }
    });
}
