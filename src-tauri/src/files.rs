use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tempfile::NamedTempFile;

pub const MAX_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_ORIGINAL_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_UPLOADS: usize = 4;
const MAX_FILES: usize = 100_000;

type StoreResult<T> = Result<T, String>;
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub key: String,
    pub size_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    pub version: u8,
    pub chunk_bytes: usize,
    pub max_original_bytes: u64,
    pub max_cover_bytes: u64,
}
struct Upload {
    key: String,
    expected: u64,
    received: u64,
    digest: Sha256,
    file: NamedTempFile,
}

/// Commands accept validated logical keys, never filesystem paths. The process
/// lock prevents a second native instance from racing the shared original store.
pub struct NativeFiles {
    root: PathBuf,
    uploads: Mutex<HashMap<String, Upload>>,
    _process_lock: File,
}

fn failure(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}
fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub fn validate_key(key: &str) -> StoreResult<(&str, &str, u64)> {
    let (directory, name) = key.split_once('/').ok_or("Invalid storage key")?;
    match directory {
        "books"
            if name.len() == 68
                && name.ends_with(".bin")
                && name.as_bytes()[..64]
                    .iter()
                    .copied()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) =>
        {
            Ok((directory, name, MAX_ORIGINAL_BYTES))
        }
        "covers" => {
            let (id, extension) = name.rsplit_once('.').ok_or("Invalid cover key")?;
            if safe_component(id)
                && !extension.is_empty()
                && extension.len() <= 12
                && extension
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            {
                Ok((directory, name, MAX_COVER_BYTES))
            } else {
                Err("Invalid cover key".into())
            }
        }
        _ => Err("Invalid storage key".into()),
    }
}
fn ensure_directory(path: &Path) -> StoreResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_symlink() && meta.is_dir() => {}
        Ok(_) => return Err("The app-owned file directory is not a regular directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|e| failure("Cannot create file directory", e))?;
        }
        Err(error) => return Err(failure("Cannot inspect file directory", error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| failure("Cannot protect file directory", e))?;
    }
    Ok(())
}

impl NativeFiles {
    pub fn open(root: PathBuf) -> StoreResult<Self> {
        ensure_directory(&root)?;
        for directory in ["books", "covers", ".staging"] {
            ensure_directory(&root.join(directory))?;
        }
        let lock_path = root.join(".instance.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("Native lock must not be a symbolic link".into());
        }
        let process_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|e| failure("Cannot open native store lock", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            process_lock
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| failure("Cannot protect native store lock", e))?;
        }
        process_lock
            .try_lock_exclusive()
            .map_err(|_| "This library is already open in another desktop instance".to_string())?;
        // The exclusive process lock makes all matching staging files stale.
        // Unknown entries and symlinks are left untouched for manual inspection.
        for entry in fs::read_dir(root.join(".staging"))
            .map_err(|e| failure("Cannot inspect interrupted writes", e))?
        {
            let entry = entry.map_err(|e| failure("Cannot inspect interrupted write", e))?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("book-reader-write-")
                && entry.file_type().is_ok_and(|kind| kind.is_file())
            {
                fs::remove_file(entry.path())
                    .map_err(|e| failure("Cannot remove interrupted write", e))?;
            }
        }
        Ok(Self {
            root,
            uploads: Mutex::new(HashMap::new()),
            _process_lock: process_lock,
        })
    }
    pub fn info(&self) -> StoreInfo {
        StoreInfo {
            version: 1,
            chunk_bytes: MAX_CHUNK_BYTES,
            max_original_bytes: MAX_ORIGINAL_BYTES,
            max_cover_bytes: MAX_COVER_BYTES,
        }
    }
    fn path(&self, key: &str) -> StoreResult<PathBuf> {
        let (directory, name, _) = validate_key(key)?;
        ensure_directory(&self.root)?;
        ensure_directory(&self.root.join(directory))?;
        let path = self.root.join(directory).join(name);
        if fs::symlink_metadata(&path)
            .is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_file())
        {
            return Err("Stored entry is not a regular file".into());
        }
        Ok(path)
    }
    pub fn stat(&self, key: &str) -> StoreResult<Option<FileInfo>> {
        let path = self.path(key)?;
        match fs::metadata(path) {
            Ok(meta) => {
                let (_, _, limit) = validate_key(key)?;
                if meta.len() > limit {
                    return Err("Stored file exceeds the supported size limit".into());
                }
                Ok(Some(FileInfo {
                    key: key.to_string(),
                    size_bytes: meta.len(),
                }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(failure("Cannot inspect original", error)),
        }
    }
    pub fn begin(&self, key: String, expected: u64) -> StoreResult<String> {
        let (_, _, limit) = validate_key(&key)?;
        self.path(&key)?;
        if expected > limit {
            return Err(format!(
                "File exceeds native storage limit of {} MiB",
                limit / 1024 / 1024
            ));
        }
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Native upload lock failed")?;
        if uploads.len() >= MAX_UPLOADS {
            return Err(
                "Too many native file writes; retry when the current write finishes".into(),
            );
        }
        ensure_directory(&self.root.join(".staging"))?;
        let file = tempfile::Builder::new()
            .prefix("book-reader-write-")
            .tempfile_in(self.root.join(".staging"))
            .map_err(|e| failure("Cannot stage original", e))?;
        let token = uuid::Uuid::new_v4().to_string();
        uploads.insert(
            token.clone(),
            Upload {
                key,
                expected,
                received: 0,
                digest: Sha256::new(),
                file,
            },
        );
        Ok(token)
    }
    pub fn append(&self, token: &str, offset: u64, bytes: &[u8]) -> StoreResult<()> {
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err("Native write chunk exceeds 256 KiB".into());
        }
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Native upload lock failed")?;
        let upload = uploads.get_mut(token).ok_or("Unknown native write token")?;
        if offset != upload.received
            || bytes.is_empty()
            || upload.received + bytes.len() as u64 > upload.expected
        {
            return Err("Native write offset or size mismatch".into());
        }
        upload
            .file
            .write_all(bytes)
            .map_err(|e| failure("Cannot write original", e))?;
        upload.digest.update(bytes);
        upload.received += bytes.len() as u64;
        Ok(())
    }
    pub fn commit(&self, token: &str) -> StoreResult<FileInfo> {
        let mut upload = self
            .uploads
            .lock()
            .map_err(|_| "Native upload lock failed")?
            .remove(token)
            .ok_or("Unknown native write token")?;
        if upload.received != upload.expected {
            return Err("Native write is incomplete; existing original was preserved".into());
        }
        let hash = format!("{:x}", upload.digest.finalize());
        if upload.key.starts_with("books/") && upload.key[6..70] != hash {
            return Err(
                "Original SHA-256 does not match its key; existing original was preserved".into(),
            );
        }
        upload
            .file
            .flush()
            .map_err(|e| failure("Cannot flush staged original", e))?;
        upload
            .file
            .as_file()
            .sync_all()
            .map_err(|e| failure("Cannot persist staged original", e))?;
        let path = self.path(&upload.key)?;
        upload
            .file
            .persist(path)
            .map_err(|e| failure("Cannot commit original", e.error))?;
        File::open(
            self.root
                .join(upload.key.split('/').next().unwrap_or("books")),
        )
        .and_then(|dir| dir.sync_all())
        .map_err(|e| failure("Cannot persist original directory", e))?;
        Ok(FileInfo {
            key: upload.key,
            size_bytes: upload.received,
        })
    }
    pub fn abort(&self, token: &str) -> StoreResult<()> {
        self.uploads
            .lock()
            .map_err(|_| "Native upload lock failed")?
            .remove(token);
        Ok(())
    }
    pub fn read(&self, key: &str, offset: u64, length: usize) -> StoreResult<Vec<u8>> {
        if length > MAX_CHUNK_BYTES || length == 0 {
            return Err("Native read must be between 1 byte and 256 KiB".into());
        }
        let info = self
            .stat(key)?
            .ok_or("Original is missing from native storage")?;
        if offset > info.size_bytes {
            return Err("Native read offset exceeds file size".into());
        }
        let mut file =
            File::open(self.path(key)?).map_err(|e| failure("Cannot open original", e))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| failure("Cannot seek original", e))?;
        let mut bytes = vec![0; length.min((info.size_bytes - offset) as usize)];
        file.read_exact(&mut bytes)
            .map_err(|e| failure("Cannot read original", e))?;
        Ok(bytes)
    }
    pub fn remove(&self, key: &str) -> StoreResult<()> {
        match fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failure("Cannot remove original", error)),
        }
    }
    pub fn keys(&self) -> StoreResult<Vec<String>> {
        let mut keys = Vec::new();
        let mut visited = 0;
        for directory in ["books", "covers"] {
            ensure_directory(&self.root.join(directory))?;
            for entry in fs::read_dir(self.root.join(directory))
                .map_err(|e| failure("Cannot list native originals", e))?
            {
                visited += 1;
                if visited > MAX_FILES {
                    return Err("Native file count exceeds the supported limit".into());
                }
                let entry = entry.map_err(|e| failure("Cannot inspect native original", e))?;
                let key = format!("{}/{}", directory, entry.file_name().to_string_lossy());
                if validate_key(&key).is_err() {
                    continue;
                }
                self.path(&key)?;
                keys.push(key);
            }
        }
        keys.sort();
        Ok(keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, NativeFiles) {
        let dir = tempfile::tempdir().unwrap();
        let store = NativeFiles::open(dir.path().join("store")).unwrap();
        (dir, store)
    }
    fn key(bytes: &[u8]) -> String {
        format!("books/{:x}.bin", Sha256::digest(bytes))
    }
    fn put(store: &NativeFiles, key: &str, bytes: &[u8]) -> StoreResult<FileInfo> {
        let token = store.begin(key.into(), bytes.len() as u64)?;
        for (index, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            store.append(&token, (index * MAX_CHUNK_BYTES) as u64, chunk)?;
        }
        store.commit(&token)
    }
    #[test]
    fn original_round_trip_and_idempotent_remove() {
        let (_dir, store) = store();
        let bytes = vec![42; MAX_CHUNK_BYTES + 7];
        let key = key(&bytes);
        assert_eq!(
            put(&store, &key, &bytes).unwrap().size_bytes,
            bytes.len() as u64
        );
        assert_eq!(
            store.read(&key, MAX_CHUNK_BYTES as u64, 7).unwrap(),
            vec![42; 7]
        );
        assert_eq!(store.keys().unwrap(), vec![key.clone()]);
        store.remove(&key).unwrap();
        store.remove(&key).unwrap();
        assert!(store.stat(&key).unwrap().is_none());
    }
    #[test]
    fn invalid_paths_cannot_escape() {
        let (_dir, store) = store();
        for key in [
            "../secret",
            "/tmp/book",
            "books/../../secret",
            "covers/../x",
            "covers/a.png/other",
            "covers/a.PnG",
            "books/probe.bin",
        ] {
            assert!(store.begin(key.into(), 1).is_err(), "{key}");
            assert!(store.read(key, 0, 1).is_err());
            assert!(store.remove(key).is_err());
        }
    }
    #[test]
    fn malformed_multibyte_keys_never_panic() {
        let invalid = format!("books/{}éé.bin", "a".repeat(60));
        assert_eq!(invalid.len(), 74);
        assert!(validate_key(&invalid).is_err());
        // Multibyte text is never accepted as a hexadecimal content hash.
        let invalid = format!("books/{}é.bin", "a".repeat(62));
        assert!(validate_key(&invalid).is_err());
    }
    #[test]
    fn restart_removes_only_owned_interrupted_staging_after_lock() {
        let (dir, store) = store();
        let staging = store.root.join(".staging");
        fs::write(staging.join("book-reader-write-interrupted"), b"partial").unwrap();
        fs::write(staging.join("unknown"), b"keep").unwrap();
        assert!(NativeFiles::open(dir.path().join("store")).is_err());
        assert!(staging.join("book-reader-write-interrupted").exists());
        drop(store);
        let _reopened = NativeFiles::open(dir.path().join("store")).unwrap();
        assert!(!staging.join("book-reader-write-interrupted").exists());
        assert_eq!(fs::read(staging.join("unknown")).unwrap(), b"keep");
    }
    #[test]
    fn incomplete_and_bad_hash_never_replace_existing_original() {
        let (_dir, store) = store();
        let key = key(b"original");
        put(&store, &key, b"original").unwrap();
        let token = store.begin(key.clone(), 8).unwrap();
        store.append(&token, 0, b"short").unwrap();
        assert!(store.commit(&token).is_err());
        let token = store.begin(key.clone(), 8).unwrap();
        store.append(&token, 0, b"tampered").unwrap();
        assert!(store.commit(&token).is_err());
        assert_eq!(store.read(&key, 0, 8).unwrap(), b"original");
    }
    #[test]
    fn chunk_order_and_size_limits_are_enforced() {
        let (_dir, store) = store();
        let token = store.begin(key(b"abc"), 3).unwrap();
        assert!(store.append(&token, 1, b"abc").is_err());
        assert!(store.append(&token, 0, b"abcd").is_err());
        store.append(&token, 0, b"abc").unwrap();
        assert!(store.append(&token, 0, b"abc").is_err());
        store.abort(&token).unwrap();
        assert!(store.commit(&token).is_err());
        assert!(store.begin(key(b"x"), MAX_ORIGINAL_BYTES + 1).is_err());
    }
    #[test]
    fn second_instance_cannot_mutate_shared_store() {
        let (dir, _store) = store();
        assert!(NativeFiles::open(dir.path().join("store")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let (dir, store) = store();
        let outside = dir.path().join("private");
        fs::write(&outside, b"private").unwrap();
        let key = key(b"private");
        symlink(&outside, store.root.join(&key)).unwrap();
        assert!(store.read(&key, 0, 7).is_err());
        assert!(store.remove(&key).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"private");
    }
}
