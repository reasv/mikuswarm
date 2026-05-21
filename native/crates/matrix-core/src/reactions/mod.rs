use crate::{
    api::{MatrixClientConfig, MatrixReactionInfo, MatrixReactionKeyKind},
    emoji, MatrixError, MatrixResult,
};
use serde_json::Value;

pub fn resolve_reaction_key_info(
    config: &MatrixClientConfig,
    raw: &str,
    room_id: Option<&str>,
    now_ms: i64,
) -> MatrixResult<MatrixReactionInfo> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(MatrixError::State("reaction key is required".to_string()));
    }

    let normalized_shortcode = emoji::normalize_shortcode(trimmed);
    let resolved_custom = normalized_shortcode
        .as_deref()
        .map(|shortcode| emoji::resolve_for_shortcode(config, shortcode, room_id, now_ms))
        .transpose()?
        .flatten();
    let resolved_unicode = if resolved_custom.is_none() {
        normalized_shortcode
            .as_deref()
            .and_then(emoji::resolve_unicode_for_shortcode)
    } else {
        None
    };

    let reaction_raw = resolved_custom
        .as_ref()
        .map(|entry| entry.mxc_url.clone())
        .or_else(|| resolved_unicode.map(str::to_string))
        .unwrap_or_else(|| trimmed.to_string());
    let shortcode = resolved_custom
        .as_ref()
        .map(|entry| entry.shortcode.clone())
        .or(normalized_shortcode.clone());
    let decoded = decode_matrix_to_target(&reaction_raw);
    let normalized = normalize_reaction_key(&decoded);
    let kind = if decoded.starts_with("mxc://") {
        MatrixReactionKeyKind::Custom
    } else if normalized.is_empty() {
        MatrixReactionKeyKind::Text
    } else if normalized.chars().any(|ch| ch.is_alphanumeric()) {
        MatrixReactionKeyKind::Text
    } else {
        MatrixReactionKeyKind::Unicode
    };
    let display = if kind == MatrixReactionKeyKind::Custom {
        shortcode
            .clone()
            .unwrap_or_else(|| format!("[custom reaction {}]", describe_mxc_uri(&decoded)))
    } else {
        normalized.clone()
    };

    Ok(MatrixReactionInfo {
        raw: reaction_raw,
        normalized,
        display,
        kind,
        shortcode,
    })
}

pub fn serialize_shortcode_metadata(shortcode: Option<&str>) -> Option<String> {
    let normalized = shortcode.and_then(emoji::normalize_shortcode)?;
    Some(
        normalized
            .trim_start_matches(':')
            .trim_end_matches(':')
            .to_string(),
    )
}

pub fn read_reaction_shortcode(content: &Value) -> Option<String> {
    let relates_to = content.get("m.relates_to");
    let raw = relates_to
        .and_then(|value| value.get("shortcode"))
        .or_else(|| relates_to.and_then(|value| value.get("com.beeper.reaction.shortcode")))
        .or_else(|| relates_to.and_then(|value| value.get("org.matrix.msc4027.shortcode")))
        .or_else(|| content.get("shortcode"))
        .or_else(|| content.get("com.beeper.reaction.shortcode"))
        .or_else(|| content.get("org.matrix.msc4027.shortcode"))
        .and_then(Value::as_str)?;
    emoji::normalize_shortcode(raw)
}

fn decode_matrix_to_target(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(target) = trimmed.strip_prefix("https://matrix.to/#/") {
        return percent_decode(target);
    }
    if let Some(target) = trimmed.strip_prefix("http://matrix.to/#/") {
        return percent_decode(target);
    }
    trimmed.to_string()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                output.push(value as char);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index] as char);
        index += 1;
    }
    output
}

fn normalize_reaction_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("mxc://") {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .filter(|ch| *ch != '\u{FE0E}' && *ch != '\u{FE0F}')
        .collect()
}

fn describe_mxc_uri(raw: &str) -> String {
    decode_matrix_to_target(raw)
        .strip_prefix("mxc://")
        .unwrap_or(raw)
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use uuid::Uuid;

    use crate::api::{
        MatrixAuthConfig, MatrixClientConfig, MatrixCustomEmojiRef, MatrixCustomEmojiUsageRequest,
        MatrixStateLayout,
    };

    use serde_json::json;

    use super::{read_reaction_shortcode, resolve_reaction_key_info, serialize_shortcode_metadata};

    fn unique_root() -> PathBuf {
        std::env::temp_dir().join(format!("openclaw-matrix-rust-reactions-{}", Uuid::new_v4()))
    }

    fn sample_config(root: &PathBuf) -> MatrixClientConfig {
        MatrixClientConfig {
            account_id: "default".to_string(),
            homeserver: "https://matrix.example".to_string(),
            user_id: "@bot:example.org".to_string(),
            auth: MatrixAuthConfig::Password {
                password: "secret".to_string(),
            },
            recovery_key: None,
            device_name: Some("OpenClaw Matrix Rust".to_string()),
            initial_sync_limit: 50,
            encryption_enabled: true,
            default_thread_replies: "inbound".to_string(),
            reply_to_mode: "off".to_string(),
            state_layout: MatrixStateLayout {
                root_dir: root.display().to_string(),
                session_file: root.join("session.json").display().to_string(),
                sdk_store_dir: root.join("sdk-store").display().to_string(),
                crypto_store_dir: root.join("crypto-store").display().to_string(),
                media_cache_dir: root.join("media-cache").display().to_string(),
                emoji_catalog_file: root.join("emoji.json").display().to_string(),
                reactions_file: root.join("reactions.json").display().to_string(),
                logs_dir: root.join("logs").display().to_string(),
            },
            room_overrides: Default::default(),
        }
    }

    #[test]
    fn normalizes_unicode_variants() {
        let root = unique_root();
        let config = sample_config(&root);
        let reaction = resolve_reaction_key_info(&config, "⚡️", None, 0).unwrap();
        assert_eq!(reaction.normalized, "⚡");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_custom_shortcodes_through_catalog() {
        let root = unique_root();
        let config = sample_config(&root);
        crate::emoji::record_usage(
            &config,
            &MatrixCustomEmojiUsageRequest {
                emoji: vec![MatrixCustomEmojiRef {
                    shortcode: ":blobwave:".to_string(),
                    mxc_url: "mxc://example/blobwave".to_string(),
                }],
                room_id: Some("!room:example".to_string()),
                observed_at_ms: Some(100),
            },
        )
        .unwrap();

        let reaction =
            resolve_reaction_key_info(&config, ":blobwave:", Some("!room:example"), 200).unwrap();
        assert_eq!(reaction.kind, crate::api::MatrixReactionKeyKind::Custom);
        assert_eq!(reaction.normalized, "mxc://example/blobwave");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_unicode_shortcodes_when_custom_catalog_misses() {
        let root = unique_root();
        fs::create_dir_all(&root).unwrap();
        let config = sample_config(&root);
        let reaction = resolve_reaction_key_info(&config, ":joy:", None, 0).unwrap();
        assert_eq!(reaction.kind, crate::api::MatrixReactionKeyKind::Unicode);
        assert_eq!(reaction.raw, "😂");
        assert_eq!(reaction.normalized, "😂");
        assert_eq!(reaction.shortcode.as_deref(), Some(":joy:"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn serializes_reaction_shortcode_without_colons() {
        assert_eq!(
            serialize_shortcode_metadata(Some(":blobwave:")),
            Some("blobwave".to_string())
        );
        assert_eq!(
            serialize_shortcode_metadata(Some("blobwave")),
            Some("blobwave".to_string())
        );
    }

    #[test]
    fn reads_nested_and_top_level_reaction_shortcode_metadata() {
        assert_eq!(
            read_reaction_shortcode(&json!({
                "m.relates_to": {
                    "shortcode": "blobwave"
                }
            })),
            Some(":blobwave:".to_string())
        );
        assert_eq!(
            read_reaction_shortcode(&json!({
                "org.matrix.msc4027.shortcode": "ohman"
            })),
            Some(":ohman:".to_string())
        );
    }
}
