use crate::exports::{validate_request, NativeExports};
use crate::files::{FileInfo, NativeFiles, StoreInfo};
use std::sync::atomic::Ordering;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Manager, State,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
fn native_store_info(store: State<'_, NativeFiles>) -> StoreInfo {
    store.info()
}
#[tauri::command]
fn native_store_begin(
    store: State<'_, NativeFiles>,
    key: String,
    size_bytes: u64,
) -> Result<String, String> {
    store.begin(key, size_bytes)
}
#[tauri::command]
fn native_store_append(store: State<'_, NativeFiles>, request: Request<'_>) -> Result<(), String> {
    let token = request
        .headers()
        .get("x-book-token")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing native write token")?;
    let offset = request
        .headers()
        .get("x-book-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or("Invalid native write offset")?;
    match request.body() {
        InvokeBody::Raw(bytes) => store.append(token, offset, bytes),
        InvokeBody::Json(_) => Err("Native write requires bounded binary data".into()),
    }
}
#[tauri::command]
fn native_store_commit(store: State<'_, NativeFiles>, token: String) -> Result<FileInfo, String> {
    store.commit(&token)
}
#[tauri::command]
fn native_store_abort(store: State<'_, NativeFiles>, token: String) -> Result<(), String> {
    store.abort(&token)
}
#[tauri::command]
fn native_store_read(
    store: State<'_, NativeFiles>,
    key: String,
    offset: u64,
    length: usize,
) -> Result<Response, String> {
    store.read(&key, offset, length).map(Response::new)
}
#[tauri::command]
fn native_store_stat(
    store: State<'_, NativeFiles>,
    key: String,
) -> Result<Option<FileInfo>, String> {
    store.stat(&key)
}
#[tauri::command]
fn native_store_remove(store: State<'_, NativeFiles>, key: String) -> Result<(), String> {
    store.remove(&key)
}
#[tauri::command]
fn native_store_keys(store: State<'_, NativeFiles>) -> Result<Vec<String>, String> {
    store.keys()
}

#[tauri::command]
async fn native_export_begin(
    app: tauri::AppHandle,
    filename: String,
    size_bytes: u64,
    sha256: String,
) -> Result<Option<String>, String> {
    validate_request(&filename, size_bytes, &sha256)?;
    tauri::async_runtime::spawn_blocking(move || {
        let exports = app.state::<NativeExports>();
        if exports.dialog_open.swap(true, Ordering::SeqCst) {
            return Err("Another save dialog is already open".into());
        }
        let result = (|| {
            if exports.is_busy()? {
                return Err("Another export is already being saved".into());
            }
            let window = app
                .get_webview_window("main")
                .ok_or("Reader window is unavailable")?;
            let selected = app
                .dialog()
                .file()
                .set_parent(&window)
                .set_title("Save Book Reader export")
                .set_file_name(&filename)
                .blocking_save_file();
            match selected {
                None => Ok(None),
                Some(selected) => {
                    let destination = selected
                        .into_path()
                        .map_err(|_| "Select a local file destination")?;
                    exports.begin(destination, size_bytes, sha256).map(Some)
                }
            }
        })();
        exports.dialog_open.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| format!("Save dialog failed: {e}"))?
}
#[tauri::command]
fn native_export_append(
    exports: State<'_, NativeExports>,
    request: Request<'_>,
) -> Result<(), String> {
    let token = request
        .headers()
        .get("x-book-token")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing export token")?;
    let offset = request
        .headers()
        .get("x-book-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or("Invalid export offset")?;
    match request.body() {
        InvokeBody::Raw(bytes) => exports.append(token, offset, bytes),
        InvokeBody::Json(_) => Err("Export requires bounded binary data".into()),
    }
}
#[tauri::command]
async fn native_export_commit(app: tauri::AppHandle, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<NativeExports>().commit(&token))
        .await
        .map_err(|e| format!("Export failed: {e}"))?
}
#[tauri::command]
fn native_export_abort(exports: State<'_, NativeExports>, token: String) -> Result<(), String> {
    exports.abort(&token)
}
#[tauri::command]
async fn native_confirm_close(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let window = app.get_webview_window("main").ok_or("Reader window is unavailable")?;
        Ok(app.dialog().message("Some local changes could not finish saving. Closing now may lose unsaved reading time or interrupt an export. Your latest position may be recoverable from the local journal. Close anyway?")
            .parent(&window).title("Changes are still saving").kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Close anyway".into(), "Keep open".into())).blocking_show())
    }).await.map_err(|e| format!("Close dialog failed: {e}"))?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(NativeExports::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let store =
                NativeFiles::open(app_data.join("book-files-v1")).map_err(std::io::Error::other)?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_store_info,
            native_store_begin,
            native_store_append,
            native_store_commit,
            native_store_abort,
            native_store_read,
            native_store_stat,
            native_store_remove,
            native_store_keys,
            native_export_begin,
            native_export_append,
            native_export_commit,
            native_export_abort,
            native_confirm_close
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start Book Reader desktop");
}
