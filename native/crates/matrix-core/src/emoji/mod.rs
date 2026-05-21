use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;

use crate::{
    api::{
        MatrixClientConfig, MatrixCustomEmojiCatalogEntry, MatrixCustomEmojiRef,
        MatrixCustomEmojiRoomStats, MatrixCustomEmojiUsageRequest, MatrixListEmojiRequest,
    },
    state, MatrixResult,
};

const GLOBAL_DECAY_DAYS: f64 = 30.0;
const ROOM_DECAY_DAYS: f64 = 14.0;
const ROOM_SCORE_BOOST: f64 = 1.5;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatrixCustomEmojiCatalogFile {
    version: u32,
    entries: Vec<MatrixCustomEmojiCatalogEntry>,
}

pub fn normalize_shortcode(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let is_wrapped = trimmed.starts_with(':')
        && trimmed.ends_with(':')
        && trimmed.len() > 2
        && !trimmed[1..trimmed.len() - 1].contains(char::is_whitespace);
    if is_wrapped {
        return Some(trimmed.to_string());
    }
    let is_bare = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '+' || ch == '-');
    if is_bare {
        return Some(format!(":{trimmed}:"));
    }
    Some(trimmed.to_string())
}

pub fn record_usage(
    config: &MatrixClientConfig,
    request: &MatrixCustomEmojiUsageRequest,
) -> MatrixResult<()> {
    let now_ms = request.observed_at_ms.unwrap_or_else(now_ms);
    let room_id = request
        .room_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut catalog = load_catalog(config)?;
    let mut entries = BTreeMap::from_iter(
        catalog
            .entries
            .into_iter()
            .map(|entry| (entry_key(&entry.shortcode, &entry.mxc_url), entry)),
    );

    let unique = request
        .emoji
        .iter()
        .filter_map(normalize_ref)
        .collect::<BTreeSet<_>>();

    for emoji in unique {
        let key = entry_key(&emoji.shortcode, &emoji.mxc_url);
        let mut entry = entries
            .remove(&key)
            .unwrap_or(MatrixCustomEmojiCatalogEntry {
                shortcode: emoji.shortcode.clone(),
                mxc_url: emoji.mxc_url.clone(),
                first_seen_ts: now_ms,
                last_seen_ts: now_ms,
                global_message_count: 0,
                global_last_message_ts: now_ms,
                rooms: BTreeMap::new(),
            });
        entry.last_seen_ts = entry.last_seen_ts.max(now_ms);
        entry.global_message_count += 1;
        entry.global_last_message_ts = entry.global_last_message_ts.max(now_ms);
        if let Some(room_id) = &room_id {
            let room_stats =
                entry
                    .rooms
                    .entry(room_id.clone())
                    .or_insert(MatrixCustomEmojiRoomStats {
                        message_count: 0,
                        last_message_ts: now_ms,
                    });
            room_stats.message_count += 1;
            room_stats.last_message_ts = room_stats.last_message_ts.max(now_ms);
        }
        entries.insert(key, entry);
    }

    catalog.entries = entries.into_values().collect();
    save_catalog(config, &catalog)
}

pub fn list_shortcodes(
    config: &MatrixClientConfig,
    request: &MatrixListEmojiRequest,
) -> MatrixResult<Vec<String>> {
    let room_id = request
        .room_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let now_ms = request.now_ms.unwrap_or_else(now_ms);
    let ranked = list_entries_ranked(config, room_id, now_ms)?;
    let mut output = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in ranked {
        if seen.insert(entry.shortcode.clone()) {
            output.push(entry.shortcode);
            if request.limit.is_some_and(|limit| output.len() >= limit) {
                break;
            }
        }
    }
    Ok(output)
}

pub fn resolve_for_shortcode(
    config: &MatrixClientConfig,
    shortcode: &str,
    room_id: Option<&str>,
    now_ms: i64,
) -> MatrixResult<Option<MatrixCustomEmojiCatalogEntry>> {
    let normalized = match normalize_shortcode(shortcode) {
        Some(value) => value,
        None => return Ok(None),
    };
    let ranked = list_entries_ranked(config, room_id, now_ms)?
        .into_iter()
        .filter(|entry| entry.shortcode == normalized)
        .collect::<Vec<_>>();
    let resolved = ranked.into_iter().next();
    Ok(resolved)
}

pub fn resolve_unicode_for_shortcode(shortcode: &str) -> Option<&'static str> {
    let normalized = normalize_shortcode(shortcode)?;
    let bare = normalized.strip_prefix(':')?.strip_suffix(':')?;
    emojis::get_by_shortcode(bare).map(|emoji| emoji.as_str())
}

#[allow(dead_code)]
pub fn extract_usage_from_formatted_html(formatted_html: &str) -> Vec<MatrixCustomEmojiRef> {
    let img_tag_pattern = Regex::new("(?is)<img\\b[^>]*>").expect("valid img regex");
    let attr_pattern =
        Regex::new("(?is)([A-Za-z_:][-A-Za-z0-9_:.]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')")
            .expect("valid attribute regex");
    let mut entries = BTreeSet::new();

    for tag in img_tag_pattern.find_iter(formatted_html) {
        let raw_tag = tag.as_str();
        let lowered = raw_tag.to_ascii_lowercase();
        if !lowered.contains("data-mx-emoticon") {
            continue;
        }

        let mut src: Option<String> = None;
        let mut alt: Option<String> = None;
        let mut title: Option<String> = None;
        for captures in attr_pattern.captures_iter(raw_tag) {
            let Some(name_match) = captures.get(1) else {
                continue;
            };
            let value = captures
                .get(2)
                .or_else(|| captures.get(3))
                .map(|value| value.as_str())
                .unwrap_or("");
            match name_match.as_str().to_ascii_lowercase().as_str() {
                "src" | "data-mx-src" => src = Some(value.to_string()),
                "alt" => alt = Some(value.to_string()),
                "title" => title = Some(value.to_string()),
                _ => {}
            }
        }

        let Some(mxc_url) = src else {
            continue;
        };
        let Some(shortcode) = alt.or(title).and_then(|value| normalize_shortcode(&value)) else {
            continue;
        };
        if mxc_url.starts_with("mxc://") {
            entries.insert(MatrixCustomEmojiRef { shortcode, mxc_url });
        }
    }

    entries.into_iter().collect()
}

pub fn render_text_with_custom_emoji(
    config: &MatrixClientConfig,
    body: &str,
    room_id: Option<&str>,
    now_ms: i64,
) -> MatrixResult<Option<String>> {
    let shortcode_pattern = Regex::new(":[A-Za-z0-9_+\\-]+:").expect("valid shortcode regex");
    let mut rendered = String::new();
    let mut last_index = 0usize;
    let mut replaced = false;

    for matched in shortcode_pattern.find_iter(body) {
        let shortcode = matched.as_str();
        rendered.push_str(&escape_html(&body[last_index..matched.start()]));
        if let Some(entry) = resolve_for_shortcode(config, shortcode, room_id, now_ms)? {
            rendered.push_str(&format!(
                "<img data-mx-emoticon src=\"{}\" alt=\"{}\" title=\"{}\" height=\"32\" />",
                escape_html(&entry.mxc_url),
                escape_html(&entry.shortcode),
                escape_html(&entry.shortcode),
            ));
            replaced = true;
        } else if let Some(unicode) = resolve_unicode_for_shortcode(shortcode) {
            rendered.push_str(unicode);
            replaced = true;
        } else {
            rendered.push_str(&escape_html(shortcode));
        }
        last_index = matched.end();
    }

    if !replaced {
        return Ok(None);
    }

    rendered.push_str(&escape_html(&body[last_index..]));
    Ok(Some(rendered.replace('\n', "<br/>")))
}

pub fn list_entries_ranked(
    config: &MatrixClientConfig,
    room_id: Option<&str>,
    now_ms: i64,
) -> MatrixResult<Vec<MatrixCustomEmojiCatalogEntry>> {
    let mut entries = load_catalog(config)?.entries;
    entries.sort_by(|left, right| compare_entries(left, right, room_id, now_ms));
    Ok(entries)
}

fn compare_entries(
    left: &MatrixCustomEmojiCatalogEntry,
    right: &MatrixCustomEmojiCatalogEntry,
    room_id: Option<&str>,
    now_ms: i64,
) -> std::cmp::Ordering {
    score(right, room_id, now_ms)
        .partial_cmp(&score(left, room_id, now_ms))
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| right.last_seen_ts.cmp(&left.last_seen_ts))
        .then_with(|| left.shortcode.cmp(&right.shortcode))
}

fn score(entry: &MatrixCustomEmojiCatalogEntry, room_id: Option<&str>, now_ms: i64) -> f64 {
    let global_age = (now_ms - entry.global_last_message_ts).max(0) as f64;
    let global_score = entry.global_message_count as f64 * decay(global_age, GLOBAL_DECAY_DAYS);
    let room_score = room_id
        .and_then(|room_id| entry.rooms.get(room_id))
        .map(|room| {
            room.message_count as f64
                * decay(
                    (now_ms - room.last_message_ts).max(0) as f64,
                    ROOM_DECAY_DAYS,
                )
                * ROOM_SCORE_BOOST
        })
        .unwrap_or(0.0);
    global_score + room_score
}

fn decay(age_ms: f64, decay_days: f64) -> f64 {
    if age_ms <= 0.0 {
        return 1.0;
    }
    let age_days = age_ms / (24.0 * 60.0 * 60.0 * 1000.0);
    (-age_days / decay_days).exp()
}

fn entry_key(shortcode: &str, mxc_url: &str) -> String {
    format!("{shortcode}\u{0}{mxc_url}")
}

fn normalize_ref(value: &MatrixCustomEmojiRef) -> Option<MatrixCustomEmojiRef> {
    let shortcode = normalize_shortcode(&value.shortcode)?;
    let mxc_url = value.mxc_url.trim();
    if !mxc_url.starts_with("mxc://") {
        return None;
    }
    Some(MatrixCustomEmojiRef {
        shortcode,
        mxc_url: mxc_url.to_string(),
    })
}

fn load_catalog(config: &MatrixClientConfig) -> MatrixResult<MatrixCustomEmojiCatalogFile> {
    Ok(
        state::read_json::<MatrixCustomEmojiCatalogFile>(&config.state_layout.emoji_catalog_file)?
            .unwrap_or(MatrixCustomEmojiCatalogFile {
                version: 1,
                entries: Vec::new(),
            }),
    )
}

fn save_catalog(
    config: &MatrixClientConfig,
    payload: &MatrixCustomEmojiCatalogFile,
) -> MatrixResult<()> {
    state::write_json(&config.state_layout.emoji_catalog_file, payload)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn escape_html(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(ch),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::PathBuf};

    use uuid::Uuid;

    use crate::api::{
        MatrixAuthConfig, MatrixClientConfig, MatrixCustomEmojiCatalogEntry, MatrixCustomEmojiRef,
        MatrixCustomEmojiUsageRequest, MatrixListEmojiRequest, MatrixStateLayout,
    };

    use super::{
        extract_usage_from_formatted_html, list_entries_ranked, list_shortcodes,
        normalize_shortcode, record_usage, render_text_with_custom_emoji, resolve_for_shortcode,
        resolve_unicode_for_shortcode,
    };

    fn unique_root() -> PathBuf {
        std::env::temp_dir().join(format!("openclaw-matrix-rust-emoji-{}", Uuid::new_v4()))
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
            room_overrides: BTreeMap::new(),
        }
    }

    #[test]
    fn normalizes_bare_shortcodes() {
        assert_eq!(
            normalize_shortcode("party_parrot"),
            Some(":party_parrot:".to_string())
        );
    }

    #[test]
    fn ranks_room_local_recent_usage_first() {
        let root = unique_root();
        let config = sample_config(&root);
        record_usage(
            &config,
            &MatrixCustomEmojiUsageRequest {
                emoji: vec![MatrixCustomEmojiRef {
                    shortcode: ":ohman:".to_string(),
                    mxc_url: "mxc://matrix.example.org/legacy".to_string(),
                }],
                room_id: Some("!legacy:example.org".to_string()),
                observed_at_ms: Some(1000),
            },
        )
        .unwrap();
        record_usage(
            &config,
            &MatrixCustomEmojiUsageRequest {
                emoji: vec![MatrixCustomEmojiRef {
                    shortcode: ":ohman:".to_string(),
                    mxc_url: "mxc://matrix.example.org/current".to_string(),
                }],
                room_id: Some("!room:example.org".to_string()),
                observed_at_ms: Some(2000),
            },
        )
        .unwrap();

        let resolved = resolve_for_shortcode(&config, ":ohman:", Some("!room:example.org"), 3000)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.mxc_url, "mxc://matrix.example.org/current");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_unique_shortcodes() {
        let root = unique_root();
        let config = sample_config(&root);
        record_usage(
            &config,
            &MatrixCustomEmojiUsageRequest {
                emoji: vec![
                    MatrixCustomEmojiRef {
                        shortcode: ":ohman:".to_string(),
                        mxc_url: "mxc://matrix.example.org/ohman".to_string(),
                    },
                    MatrixCustomEmojiRef {
                        shortcode: ":ohman:".to_string(),
                        mxc_url: "mxc://matrix.example.org/ohman".to_string(),
                    },
                    MatrixCustomEmojiRef {
                        shortcode: ":catjam:".to_string(),
                        mxc_url: "mxc://matrix.example.org/catjam".to_string(),
                    },
                ],
                room_id: Some("!room:example.org".to_string()),
                observed_at_ms: Some(1000),
            },
        )
        .unwrap();

        let shortcodes = list_shortcodes(
            &config,
            &MatrixListEmojiRequest {
                room_id: Some("!room:example.org".to_string()),
                limit: None,
                now_ms: Some(2000),
            },
        )
        .unwrap();
        assert_eq!(
            shortcodes,
            vec![":catjam:".to_string(), ":ohman:".to_string()]
        );

        let ranked = list_entries_ranked(&config, Some("!room:example.org"), 2000).unwrap();
        assert_eq!(ranked.len(), 2);
        assert_eq!(
            ranked[0],
            MatrixCustomEmojiCatalogEntry {
                shortcode: ":catjam:".to_string(),
                mxc_url: "mxc://matrix.example.org/catjam".to_string(),
                first_seen_ts: 1000,
                last_seen_ts: 1000,
                global_message_count: 1,
                global_last_message_ts: 1000,
                rooms: BTreeMap::from([(
                    "!room:example.org".to_string(),
                    crate::api::MatrixCustomEmojiRoomStats {
                        message_count: 1,
                        last_message_ts: 1000,
                    },
                )]),
            }
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_custom_emoji_from_formatted_html() {
        let entries = extract_usage_from_formatted_html(
            r#"<p>Hello <img data-mx-emoticon src="mxc://example/wave" alt=":wave:" /></p>"#,
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].shortcode, ":wave:");
        assert_eq!(entries[0].mxc_url, "mxc://example/wave");
    }

    #[test]
    fn extracts_custom_emoji_from_title_only_markup() {
        let entries = extract_usage_from_formatted_html(
            r#"<p>Hello <img data-mx-emoticon src="mxc://example/ohman" title="ohman" /></p>"#,
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].shortcode, ":ohman:");
        assert_eq!(entries[0].mxc_url, "mxc://example/ohman");
    }

    #[test]
    fn renders_known_shortcodes_as_matrix_emoticons() {
        let root = unique_root();
        let config = sample_config(&root);
        record_usage(
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

        let html =
            render_text_with_custom_emoji(&config, "hello :blobwave:", Some("!room:example"), 200)
                .unwrap()
                .unwrap();
        assert!(html.contains("data-mx-emoticon"));
        assert!(html.contains("mxc://example/blobwave"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_unicode_shortcode_fallbacks() {
        assert_eq!(resolve_unicode_for_shortcode(":joy:"), Some("😂"));
        assert_eq!(resolve_unicode_for_shortcode("eyes"), Some("👀"));
        assert_eq!(resolve_unicode_for_shortcode(":not_a_real_emoji:"), None);
    }

    #[test]
    fn renders_unicode_shortcodes_without_custom_catalog_entries() {
        let root = unique_root();
        fs::create_dir_all(&root).unwrap();
        let config = sample_config(&root);

        let html = render_text_with_custom_emoji(
            &config,
            "hello :joy: :unknown:",
            Some("!room:example"),
            200,
        )
        .unwrap()
        .unwrap();
        assert_eq!(html, "hello 😂 :unknown:");

        fs::remove_dir_all(root).unwrap();
    }
}
