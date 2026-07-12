//! Outbound Matrix mention rendering.
//!
//! When the agent writes a bare user reference like `@atomictiger:matrix.org` in a
//! message body, that plain text is *not* a mention: Matrix clients only pill-render
//! and notify on a `matrix.to` link in `formatted_body` plus the target in the
//! event's `m.mentions.user_ids` (intentional mentions, spec §"User and room
//! mentions"). This module scans an outgoing plain-text body for MXID-shaped tokens,
//! validates each with ruma's grammar (`UserId::parse`), and produces both halves:
//! the HTML pill and the `m.mentions` user-id set. It composes with the custom-emoji
//! renderer (`crate::emoji`) so a body can carry both pills and `:shortcode:` emoji.

use matrix_sdk::ruma::{OwnedUserId, UserId};
use regex::Regex;

use crate::{api::MatrixClientConfig, emoji, MatrixResult};

/// Result of rendering an outgoing body: the `formatted_body` HTML (present when a
/// pill or emoji was produced; `None` means "send as plain text") and the distinct
/// user ids to advertise in `m.mentions` (already excluding the sender itself).
pub struct RenderedMessage {
    pub formatted: Option<String>,
    pub user_ids: Vec<OwnedUserId>,
}

struct MentionSpan {
    start: usize,
    end: usize,
    user_id: OwnedUserId,
}

/// Locate MXID-shaped tokens in `body` and validate each against the user-id
/// grammar. The regex over-captures: its server-name class greedily eats a trailing
/// `.`/`-` that a real hostname can't legitimately end with — most often the
/// sentence-ending dot in "…ping @a:matrix.org." (which ruma actually *accepts* as a
/// root-FQDN server name, so it must be trimmed rather than relied on to fail
/// validation). We strip trailing `.`/`-` before parsing so the pill and mention
/// cover exactly the intended MXID. Captures that still don't parse are left as plain
/// text. Spans are returned in order and never overlap.
fn detect_mentions(body: &str) -> Vec<MentionSpan> {
    let pattern = Regex::new(r"@[A-Za-z0-9._=/+\-]+:[A-Za-z0-9.\-]+(?::[0-9]{1,5})?")
        .expect("valid mxid regex");
    let bytes = body.as_bytes();
    let mut spans = Vec::new();
    for matched in pattern.find_iter(body) {
        let start = matched.start();
        let mut end = matched.end();
        while end > start && matches!(bytes[end - 1], b'.' | b'-') {
            end -= 1;
        }
        if let Ok(user_id) = UserId::parse(&body[start..end]) {
            spans.push(MentionSpan { start, end, user_id });
        }
    }
    spans
}

/// Push a `matrix.to` pill for `user_id` (displaying `label`, the exact text the
/// author wrote, so `body`/`formatted_body` stay consistent) onto `out`.
fn push_pill(out: &mut String, user_id: &UserId, label: &str) {
    out.push_str("<a href=\"https://matrix.to/#/");
    out.push_str(&emoji::escape_html(user_id.as_str()));
    out.push_str("\">");
    out.push_str(&emoji::escape_html(label));
    out.push_str("</a>");
}

/// Render `body` into `formatted_body` HTML with mention pills and custom emoji, and
/// collect the mentioned user ids for `m.mentions`. `own_user_id`, when supplied, is
/// dropped from the id set — the spec forbids self-notification. `formatted` is
/// `None` when neither a pill nor an emoji was produced, so a plain body still sends
/// as `m.text` without an HTML body.
pub fn render_message_html(
    config: &MatrixClientConfig,
    body: &str,
    room_id: Option<&str>,
    own_user_id: Option<&UserId>,
    now_ms: i64,
) -> MatrixResult<RenderedMessage> {
    let spans = detect_mentions(body);
    // Fast path: the overwhelmingly common message carries no MXID. Fall straight
    // through to the emoji renderer — byte-identical to the pre-mention behaviour —
    // without walking segments or allocating a user-id set.
    if spans.is_empty() {
        return Ok(RenderedMessage {
            formatted: emoji::render_text_with_custom_emoji(config, body, room_id, now_ms)?,
            user_ids: Vec::new(),
        });
    }
    // With at least one mention span a pill is always emitted, so `formatted` is
    // always present here — no need to track whether an emoji also fired. Gap
    // segments still run through the emoji renderer for its escaping + shortcode side
    // effects on `out`.
    let mut out = String::new();
    let mut user_ids: Vec<OwnedUserId> = Vec::new();
    let mut cursor = 0usize;

    for span in &spans {
        if span.start > cursor {
            emoji::append_shortcode_rendered(
                config,
                &body[cursor..span.start],
                room_id,
                now_ms,
                &mut out,
            )?;
        }
        push_pill(&mut out, &span.user_id, &body[span.start..span.end]);
        collect_user_id(&mut user_ids, &span.user_id, own_user_id);
        cursor = span.end;
    }

    if cursor < body.len() {
        emoji::append_shortcode_rendered(config, &body[cursor..], room_id, now_ms, &mut out)?;
    }

    Ok(RenderedMessage {
        formatted: Some(out.replace('\n', "<br/>")),
        user_ids,
    })
}

/// Distinct mentioned user ids in `body` (sender excluded) without rebuilding HTML —
/// used for the custom-HTML send path, where the author supplied `formatted_body`
/// themselves but `m.mentions` must still reflect the MXIDs they wrote so the
/// mentioned users are actually notified.
pub fn detect_user_ids(body: &str, own_user_id: Option<&UserId>) -> Vec<OwnedUserId> {
    let mut user_ids = Vec::new();
    for span in detect_mentions(body) {
        collect_user_id(&mut user_ids, &span.user_id, own_user_id);
    }
    user_ids
}

fn collect_user_id(user_ids: &mut Vec<OwnedUserId>, user_id: &UserId, own_user_id: Option<&UserId>) {
    if own_user_id.is_some_and(|own| own == user_id) {
        return;
    }
    if !user_ids.iter().any(|existing| existing == user_id) {
        user_ids.push(user_id.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use uuid::Uuid;

    use crate::api::{MatrixAuthConfig, MatrixClientConfig, MatrixStateLayout};

    use super::{detect_user_ids, render_message_html};

    fn sample_config() -> MatrixClientConfig {
        let root: PathBuf =
            std::env::temp_dir().join(format!("openclaw-matrix-rust-mentions-{}", Uuid::new_v4()));
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

    fn user(id: &str) -> matrix_sdk::ruma::OwnedUserId {
        matrix_sdk::ruma::UserId::parse(id).expect("valid test user id")
    }

    #[test]
    fn converts_exact_mxid_into_pill_and_mention() {
        let config = sample_config();
        let rendered =
            render_message_html(&config, "@atomictiger:matrix.org lmao", None, None, 0).unwrap();
        assert_eq!(
            rendered.formatted.as_deref(),
            Some(
                "<a href=\"https://matrix.to/#/@atomictiger:matrix.org\">@atomictiger:matrix.org</a> lmao"
            )
        );
        assert_eq!(rendered.user_ids, vec![user("@atomictiger:matrix.org")]);
    }

    #[test]
    fn plain_text_without_mxid_stays_plain() {
        let config = sample_config();
        let rendered = render_message_html(&config, "just a normal message", None, None, 0).unwrap();
        assert!(rendered.formatted.is_none());
        assert!(rendered.user_ids.is_empty());
    }

    #[test]
    fn escapes_surrounding_text_and_dedupes_ids() {
        let config = sample_config();
        let rendered = render_message_html(
            &config,
            "hi @a:example.org & @a:example.org <3",
            None,
            None,
            0,
        )
        .unwrap();
        let html = rendered.formatted.expect("html produced");
        assert!(html.contains("&amp; "));
        assert!(html.contains("&lt;3"));
        assert_eq!(rendered.user_ids, vec![user("@a:example.org")]);
    }

    #[test]
    fn trims_trailing_sentence_dot_from_server_name() {
        let config = sample_config();
        let rendered =
            render_message_html(&config, "ping @a:matrix.org.", None, None, 0).unwrap();
        let html = rendered.formatted.expect("html produced");
        // The pill covers the MXID; the sentence-ending dot stays outside the anchor.
        assert!(html.contains("<a href=\"https://matrix.to/#/@a:matrix.org\">@a:matrix.org</a>."));
        assert_eq!(rendered.user_ids, vec![user("@a:matrix.org")]);
    }

    #[test]
    fn excludes_own_user_id_from_mentions() {
        let config = sample_config();
        let own = user("@bot:example.org");
        let rendered = render_message_html(
            &config,
            "cc @bot:example.org and @carol:example.org",
            None,
            Some(&own),
            0,
        )
        .unwrap();
        // Both still get a pill, but the bot itself is not advertised in m.mentions.
        let html = rendered.formatted.expect("html produced");
        assert!(html.contains("https://matrix.to/#/@bot:example.org"));
        assert_eq!(rendered.user_ids, vec![user("@carol:example.org")]);
    }

    #[test]
    fn detect_user_ids_matches_render_ids() {
        let ids = detect_user_ids("look @dave:example.org", None);
        assert_eq!(ids, vec![user("@dave:example.org")]);
        let none = detect_user_ids("nobody here", None);
        assert!(none.is_empty());
    }
}
