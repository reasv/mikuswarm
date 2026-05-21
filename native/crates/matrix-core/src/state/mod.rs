use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{de::DeserializeOwned, Serialize};

use crate::{api::MatrixStateLayout, MatrixResult};

pub fn ensure_layout(layout: &MatrixStateLayout) -> MatrixResult<()> {
    for dir in [
        &layout.root_dir,
        &layout.sdk_store_dir,
        &layout.crypto_store_dir,
        &layout.media_cache_dir,
        &layout.logs_dir,
    ] {
        fs::create_dir_all(dir)?;
    }
    if let Some(parent) = Path::new(&layout.session_file).parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = Path::new(&layout.emoji_catalog_file).parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

pub fn read_json<T: DeserializeOwned>(path: &str) -> MatrixResult<Option<T>> {
    let resolved = PathBuf::from(path);
    if !resolved.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(resolved)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

pub fn write_json<T: Serialize>(path: &str, value: &T) -> MatrixResult<()> {
    let resolved = PathBuf::from(path);
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(value)?;
    fs::write(resolved, raw)?;
    Ok(())
}
