use crate::files::{MAX_CHUNK_BYTES, MAX_ORIGINAL_BYTES};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::{atomic::AtomicBool, Mutex},
};
use tempfile::NamedTempFile;

struct PendingExport {
    token: String,
    destination: PathBuf,
    file: NamedTempFile,
    expected: u64,
    received: u64,
    expected_hash: String,
    digest: Sha256,
}

/// The destination is selected by the OS dialog in Rust and never returned to JS.
#[derive(Default)]
pub struct NativeExports {
    pending: Mutex<Option<PendingExport>>,
    pub dialog_open: AtomicBool,
}

pub fn validate_request(filename: &str, size: u64, hash: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.len() > 512
        || (filename == "." || filename == "..")
        || filename
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("Invalid export filename".into());
    }
    if size > MAX_ORIGINAL_BYTES {
        return Err("Native exports are limited to 256 MiB".into());
    }
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Invalid export checksum".into());
    }
    Ok(())
}

impl NativeExports {
    pub fn is_busy(&self) -> Result<bool, String> {
        Ok(self
            .pending
            .lock()
            .map_err(|_| "Export state failed")?
            .is_some())
    }

    // This method is deliberately not a Tauri command. The webview cannot supply paths.
    pub fn begin(
        &self,
        destination: PathBuf,
        expected: u64,
        expected_hash: String,
    ) -> Result<String, String> {
        validate_request("export", expected, &expected_hash)?;
        let mut pending = self.pending.lock().map_err(|_| "Export state failed")?;
        if pending.is_some() {
            return Err("Another export is already being saved".into());
        }
        if !destination.is_absolute() {
            return Err("Export destination must be absolute".into());
        }
        reject_special_destination(&destination)?;
        let parent = destination
            .parent()
            .ok_or("Export destination has no parent directory")?;
        let file = tempfile::Builder::new()
            .prefix(".book-reader-export-")
            .tempfile_in(parent)
            .map_err(|e| format!("Cannot create export in the selected folder: {e}"))?;
        let token = uuid::Uuid::new_v4().to_string();
        *pending = Some(PendingExport {
            token: token.clone(),
            destination,
            file,
            expected,
            received: 0,
            expected_hash,
            digest: Sha256::new(),
        });
        Ok(token)
    }

    pub fn append(&self, token: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
            return Err("Invalid export chunk size".into());
        }
        let mut state = self.pending.lock().map_err(|_| "Export state failed")?;
        let pending = state
            .as_mut()
            .filter(|p| p.token == token)
            .ok_or("Unknown export token")?;
        if offset != pending.received || pending.received + bytes.len() as u64 > pending.expected {
            return Err("Export offset or length mismatch".into());
        }
        pending
            .file
            .write_all(bytes)
            .map_err(|e| format!("Cannot write export: {e}"))?;
        pending.digest.update(bytes);
        pending.received += bytes.len() as u64;
        Ok(())
    }

    pub fn abort(&self, token: &str) -> Result<(), String> {
        let mut state = self.pending.lock().map_err(|_| "Export state failed")?;
        if state.as_ref().is_some_and(|p| p.token == token) {
            state.take();
        }
        Ok(())
    }

    pub fn commit(&self, token: &str) -> Result<(), String> {
        let mut state = self.pending.lock().map_err(|_| "Export state failed")?;
        if !state.as_ref().is_some_and(|p| p.token == token) {
            return Err("Unknown export token".into());
        }
        let mut pending = state.take().ok_or("Unknown export token")?;
        if pending.expected != pending.received
            || format!("{:x}", pending.digest.finalize()) != pending.expected_hash
        {
            return Err(
                "Export is incomplete or failed its checksum; previous destination was preserved"
                    .into(),
            );
        }
        pending
            .file
            .flush()
            .map_err(|e| format!("Cannot flush export: {e}"))?;
        pending
            .file
            .as_file()
            .sync_all()
            .map_err(|e| format!("Cannot persist export: {e}"))?;
        reject_special_destination(&pending.destination)?;
        let parent = pending
            .destination
            .parent()
            .ok_or("Export destination has no parent directory")?
            .to_path_buf();
        pending
            .file
            .persist(&pending.destination)
            .map_err(|e| format!("Cannot publish export: {}", e.error))?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| format!("Cannot persist export directory: {e}"))?;
        Ok(())
    }
}

fn reject_special_destination(path: &PathBuf) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            Err("Export destination must be a regular file, not a link or directory".into())
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot inspect export destination: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    #[test]
    fn verifies_and_atomically_replaces_only_complete_exports() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.zip");
        fs::write(&path, b"old backup").unwrap();
        let exports = NativeExports::default();
        let token = exports.begin(path.clone(), 4, hash(b"book")).unwrap();
        exports.append(&token, 0, b"bad").unwrap();
        assert!(exports.commit(&token).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old backup");
        let token = exports.begin(path.clone(), 4, hash(b"book")).unwrap();
        exports.append(&token, 0, b"fake").unwrap();
        assert!(exports.commit(&token).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old backup");
        let token = exports.begin(path.clone(), 4, hash(b"book")).unwrap();
        exports.append(&token, 0, b"book").unwrap();
        exports.commit(&token).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"book");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn bounds_writes_and_cleans_up_on_abort() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.zip");
        let exports = NativeExports::default();
        let token = exports.begin(path.clone(), 4, hash(b"book")).unwrap();
        assert!(exports.begin(path.clone(), 4, hash(b"book")).is_err());
        assert!(exports.append(&token, 1, b"book").is_err());
        assert!(exports
            .append(&token, 0, &[1; MAX_CHUNK_BYTES + 1])
            .is_err());
        assert!(exports.append("invalid", 0, b"book").is_err());
        exports.abort(&token).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(validate_request("../secret", 4, &hash(b"book")).is_err());
        assert!(validate_request("export", MAX_ORIGINAL_BYTES + 1, &hash(b"book")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_destinations_including_replacement_during_staging() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("private");
        let path = dir.path().join("export");
        fs::write(&target, b"private").unwrap();
        let exports = NativeExports::default();
        let token = exports.begin(path.clone(), 4, hash(b"book")).unwrap();
        exports.append(&token, 0, b"book").unwrap();
        symlink(&target, &path).unwrap();
        assert!(exports.commit(&token).is_err());
        assert!(exports.begin(path, 4, hash(b"book")).is_err());
        assert_eq!(fs::read(target).unwrap(), b"private");
    }
}
