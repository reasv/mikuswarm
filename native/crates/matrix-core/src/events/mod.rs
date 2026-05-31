use chrono::{DateTime, Utc};
use matrix_sdk::{
    deserialized_responses::{TimelineEvent, TimelineEventKind, UnableToDecryptReason},
    ruma::events::{
        room::message::{
            FormattedBody, MessageType, OriginalSyncRoomMessageEvent, Relation,
            RoomMessageEventContent, RoomMessageEventContentWithoutRelation, SyncRoomMessageEvent,
        },
        AnySyncMessageLikeEvent, AnySyncTimelineEvent,
    },
    Room,
};
use serde_json::Value;

use crate::api::{
    MatrixChatType, MatrixInboundEvent, MatrixInboundMedia, MatrixInboundMentions, MatrixMediaKind,
    MatrixMessageRelatesTo, MatrixMessageSummary,
};

fn timestamp_from_millis(millis: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(millis).unwrap_or_else(Utc::now)
}

fn timestamp_from_event(event: &OriginalSyncRoomMessageEvent) -> DateTime<Utc> {
    timestamp_from_millis(i64::from(event.origin_server_ts.get()))
}

fn formatted_body(msgtype: &MessageType) -> Option<String> {
    fn html_body(formatted: Option<&FormattedBody>) -> Option<String> {
        formatted.map(|value| value.body.clone())
    }

    match msgtype {
        MessageType::Audio(content) => html_body(content.formatted_caption()),
        MessageType::Emote(content) => html_body(content.formatted.as_ref()),
        MessageType::File(content) => html_body(content.formatted_caption()),
        MessageType::Image(content) => html_body(content.formatted_caption()),
        MessageType::Notice(content) => html_body(content.formatted.as_ref()),
        MessageType::Text(content) => html_body(content.formatted.as_ref()),
        MessageType::Video(content) => html_body(content.formatted_caption()),
        MessageType::Location(_)
        | MessageType::ServerNotice(_)
        | MessageType::VerificationRequest(_)
        | MessageType::_Custom(_)
        | _ => None,
    }
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn read_html_attribute(attrs: &str, name: &str) -> Option<String> {
    let double_quoted = regex::Regex::new(&format!(r#"{name}\s*=\s*"([^"]*)""#))
        .expect("valid html attribute regex");
    if let Some(value) = double_quoted
        .captures(attrs)
        .and_then(|captures| captures.get(1))
        .map(|value| decode_html_entities(value.as_str()))
    {
        return Some(value);
    }
    let single_quoted = regex::Regex::new(&format!(r#"{name}\s*=\s*'([^']*)'"#))
        .expect("valid html attribute regex");
    single_quoted
        .captures(attrs)
        .and_then(|captures| captures.get(1))
        .map(|value| decode_html_entities(value.as_str()))
}

fn normalize_matrix_emoji_label(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let shortcode_pattern = regex::Regex::new(r"^:[^:\s]+:$").expect("valid shortcode regex");
    if shortcode_pattern.is_match(trimmed) {
        return trimmed.to_string();
    }
    let bare_shortcode_pattern =
        regex::Regex::new(r"^[A-Za-z0-9_+-]+$").expect("valid bare shortcode regex");
    if bare_shortcode_pattern.is_match(trimmed) {
        return format!(":{trimmed}:");
    }
    trimmed.to_string()
}

fn describe_matrix_mxc_uri(raw: &str) -> String {
    raw.trim_start_matches("mxc://").to_string()
}

fn build_custom_emoji_placeholder(attrs: &str) -> String {
    let alt = read_html_attribute(attrs, "alt").unwrap_or_default();
    let title = read_html_attribute(attrs, "title").unwrap_or_default();
    let src = read_html_attribute(attrs, "src").unwrap_or_default();
    let preferred = if !alt.trim().is_empty() {
        alt
    } else if !title.trim().is_empty() {
        title
    } else {
        String::new()
    };
    if !preferred.is_empty() && preferred != src {
        return normalize_matrix_emoji_label(&preferred);
    }
    if src.starts_with("mxc://") {
        return format!("[custom emoji {}]", describe_matrix_mxc_uri(&src));
    }
    "[custom emoji]".to_string()
}

fn render_formatted_body_text(formatted_body: Option<&str>) -> (String, bool) {
    let Some(formatted_body) = formatted_body
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (String::new(), false);
    };

    let custom_img_pattern = regex::Regex::new(r#"(?is)<img\b([^>]*\bdata-mx-emoticon\b[^>]*)>"#)
        .expect("valid custom emoji image regex");
    let generic_mxc_img_pattern =
        regex::Regex::new(r#"(?is)<img\b([^>]*\bsrc\s*=\s*["']mxc://[^"']+["'][^>]*)>"#)
            .expect("valid generic mxc image regex");
    let line_break_pattern = regex::Regex::new(r"(?i)<br\s*/?>").expect("valid br regex");
    let block_close_pattern =
        regex::Regex::new(r"(?i)</(?:p|div|li|ul|ol|blockquote|pre|h[1-6]|table|tr)>")
            .expect("valid block close regex");
    let list_item_open_pattern =
        regex::Regex::new(r"(?i)<li\b[^>]*>").expect("valid list item regex");
    let tag_pattern = regex::Regex::new(r"<[^>]+>").expect("valid html tag regex");
    let whitespace_newline_pattern =
        regex::Regex::new(r"[ \t]+\n").expect("valid whitespace newline regex");
    let newline_pattern = regex::Regex::new(r"\n{3,}").expect("valid newline collapse regex");
    let spaces_pattern = regex::Regex::new(r"[ \t]{2,}").expect("valid space collapse regex");

    let mut has_custom_emoji = false;
    let custom_replaced = custom_img_pattern
        .replace_all(formatted_body, |captures: &regex::Captures| {
            has_custom_emoji = true;
            format!(
                " {} ",
                build_custom_emoji_placeholder(
                    captures
                        .get(1)
                        .map(|value| value.as_str())
                        .unwrap_or_default()
                )
            )
        })
        .to_string();
    let generic_replaced = generic_mxc_img_pattern
        .replace_all(&custom_replaced, |captures: &regex::Captures| {
            has_custom_emoji = true;
            format!(
                " {} ",
                build_custom_emoji_placeholder(
                    captures
                        .get(1)
                        .map(|value| value.as_str())
                        .unwrap_or_default()
                )
            )
        })
        .to_string();
    let text = decode_html_entities(
        &tag_pattern
            .replace_all(
                &list_item_open_pattern.replace_all(
                    &block_close_pattern.replace_all(
                        &line_break_pattern.replace_all(&generic_replaced, "\n"),
                        "\n",
                    ),
                    "- ",
                ),
                " ",
            )
            .to_string(),
    );
    let collapsed_newlines = whitespace_newline_pattern.replace_all(&text, "\n");
    let collapsed_paragraphs = newline_pattern.replace_all(&collapsed_newlines, "\n\n");
    let collapsed_spaces = spaces_pattern.replace_all(&collapsed_paragraphs, " ");
    (collapsed_spaces.trim().to_string(), has_custom_emoji)
}

fn media_items(msgtype: &MessageType) -> Vec<MatrixInboundMedia> {
    match msgtype {
        MessageType::Audio(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::Audio,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        MessageType::File(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::File,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        MessageType::Image(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::Image,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        MessageType::Video(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::Video,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        _ => Vec::new(),
    }
}

/// Resolved relation metadata for a decrypted message: `(reply_to_id,
/// thread_root_id, replaces_event_id)`. `replaces_event_id` is `Some(target)`
/// for an `m.replace` edit — the id of the event this message edits. Edits are
/// surfaced (not dropped) so the agent sees the timeline like a normal client;
/// the live path routes the edit to the store's edit-application primitive.
fn relation_details(
    content: &RoomMessageEventContent,
) -> (Option<String>, Option<String>, Option<String>) {
    match content.relates_to.as_ref() {
        Some(Relation::Replacement(replacement)) => {
            (None, None, Some(replacement.event_id.to_string()))
        }
        Some(Relation::Reply { in_reply_to }) => {
            (Some(in_reply_to.event_id.to_string()), None, None)
        }
        Some(Relation::Thread(thread)) => (
            thread
                .in_reply_to
                .as_ref()
                .map(|value| value.event_id.to_string()),
            Some(thread.event_id.to_string()),
            None,
        ),
        Some(Relation::_Custom(_)) | Some(_) | None => (None, None, None),
    }
}

/// The replacement (`m.new_content`) for an `m.replace` edit, if present. Matrix
/// edits put the post-edit message under `m.new_content`; the top-level `body`
/// is only the `* fallback` and must NOT be used for display.
fn replacement_new_content(
    content: &RoomMessageEventContent,
) -> Option<&RoomMessageEventContentWithoutRelation> {
    match content.relates_to.as_ref() {
        Some(Relation::Replacement(replacement)) => Some(&replacement.new_content),
        _ => None,
    }
}

/// The replacement (`m.new_content`) object for an `m.replace` edit, read from a
/// raw `serde_json::Value` content. Mirrors the typed `replacement_new_content`
/// for the summarize path, which works on untyped `Value`s. Returns `None` for
/// non-edits (no `m.relates_to`, a non-`m.replace` rel_type, or a missing
/// `m.new_content`), so callers fall back to the top-level content unchanged.
fn replacement_new_content_value(content: &Value) -> Option<&Value> {
    let is_replace = content
        .get("m.relates_to")
        .and_then(|relates_to| relates_to.get("rel_type"))
        .and_then(Value::as_str)
        == Some("m.replace");
    if !is_replace {
        return None;
    }
    content.get("m.new_content")
}

fn readable_body(content: &Value) -> String {
    let msgtype = content
        .get("msgtype")
        .and_then(Value::as_str)
        .map(str::trim);
    let body = content
        .get("body")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let formatted_body = content
        .get("formatted_body")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let filename = content
        .get("filename")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let (formatted_text, has_custom_emoji) = render_formatted_body_text(formatted_body);

    let resolved = if (has_custom_emoji || body.is_empty()) && !formatted_text.is_empty() {
        formatted_text
    } else if !body.is_empty() {
        body.to_string()
    } else if !filename.is_empty() {
        filename.to_string()
    } else {
        String::new()
    };

    match msgtype {
        Some("m.emote") if !resolved.is_empty() => format!("/me {resolved}"),
        Some("m.emote") => "/me".to_string(),
        Some("m.sticker") if !resolved.is_empty() => format!("[matrix sticker] {resolved}"),
        Some("m.sticker") => "[matrix sticker]".to_string(),
        _ => resolved,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        formatted_body, media_from_timeline, media_items, readable_body, relation_details,
        replacement_new_content, summarize_message_value, summarize_timeline_event,
    };
    use crate::api::MatrixMediaKind;
    use matrix_sdk::deserialized_responses::{
        TimelineEvent, UnableToDecryptInfo, UnableToDecryptReason,
    };
    use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
    use matrix_sdk::ruma::events::AnySyncTimelineEvent;
    use matrix_sdk::ruma::serde::Raw;
    use serde_json::{json, Value};

    fn raw_event(value: Value) -> Raw<AnySyncTimelineEvent> {
        Raw::from_json(serde_json::value::to_raw_value(&value).expect("to raw value"))
    }

    #[test]
    fn summarizes_utd_event_as_placeholder() {
        let raw = raw_event(json!({
            "type": "m.room.encrypted",
            "event_id": "$utd:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1_700_000_000_000i64,
            "content": {
                "algorithm": "m.megolm.v1.aes-sha2",
                "session_id": "session-abc",
                "ciphertext": "AwgAEnABCDEF",
            },
        }));
        let event = TimelineEvent::from_utd(
            raw,
            UnableToDecryptInfo {
                session_id: Some("session-abc".to_string()),
                reason: UnableToDecryptReason::MissingMegolmSession { withheld_code: None },
            },
        );
        let summary = summarize_timeline_event(&event).expect("utd summary surfaced");
        assert_eq!(summary.event_id, "$utd:example.org");
        assert_eq!(summary.sender, "@alice:example.org");
        assert_eq!(summary.timestamp.timestamp_millis(), 1_700_000_000_000);
        assert!(summary.body.is_empty());
        assert_eq!(summary.undecryptable, Some(true));
        assert_eq!(summary.session_id.as_deref(), Some("session-abc"));
        // The structured UTD reason is mapped to a stable lowercase code.
        assert_eq!(summary.utd_reason.as_deref(), Some("missing_megolm_session"));
        assert!(summary.media.is_empty());
        // The placeholder must never carry plaintext or ciphertext material.
        let serialized = serde_json::to_string(&summary).expect("serialize summary");
        assert!(!serialized.contains("ciphertext"));
    }

    #[test]
    fn utd_summary_serializes_camelcase_wire_keys() {
        // Pins the native -> TS wire contract: the TS re-decryption / inbound
        // layer parses these exact camelCase keys, but the Rust struct fields are
        // snake_case and depend on `#[serde(rename_all = "camelCase")]` plus the
        // per-field renames. A serde-rename regression here would be caught by
        // neither side's existing tests (TS tests hand-build camelCase objects),
        // silently breaking UTD recovery in production (issue #13).
        let raw = raw_event(json!({
            "type": "m.room.encrypted",
            "event_id": "$utd:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1_700_000_000_000i64,
            "content": {
                "algorithm": "m.megolm.v1.aes-sha2",
                "session_id": "session-abc",
                "ciphertext": "AwgAEnABCDEF",
            },
        }));
        let event = TimelineEvent::from_utd(
            raw,
            UnableToDecryptInfo {
                session_id: Some("session-abc".to_string()),
                reason: UnableToDecryptReason::MissingMegolmSession { withheld_code: None },
            },
        );
        let summary = summarize_timeline_event(&event).expect("utd summary surfaced");
        let value: Value =
            serde_json::from_str(&serde_json::to_string(&summary).expect("serialize summary"))
                .expect("reparse serialized summary");
        let obj = value.as_object().expect("summary serializes to a JSON object");

        // The wire keys the TS side reads must be present in camelCase form.
        assert_eq!(obj.get("undecryptable").and_then(Value::as_bool), Some(true));
        assert_eq!(
            obj.get("sessionId").and_then(Value::as_str),
            Some("session-abc"),
            "session_id must serialize as sessionId",
        );
        assert_eq!(
            obj.get("utdReason").and_then(Value::as_str),
            Some("missing_megolm_session"),
            "utd_reason must serialize as utdReason",
        );
        // relates_to is None for a UTD placeholder (serializes as null since the
        // field has no skip_serializing_if); the camelCase key must still appear
        // so a populated edit/thread relation reaches TS under `relatesTo`.
        assert!(
            obj.contains_key("relatesTo"),
            "relates_to must serialize as relatesTo (never the snake_case name)",
        );
        assert!(obj.get("relatesTo").map_or(false, Value::is_null), "relatesTo is null for a UTD");
        // The snake_case field names must NOT leak onto the wire.
        assert!(!obj.contains_key("session_id"), "snake_case session_id must not appear");
        assert!(!obj.contains_key("utd_reason"), "snake_case utd_reason must not appear");
        assert!(!obj.contains_key("relates_to"), "snake_case relates_to must not appear");
    }

    #[test]
    fn summarizes_normal_message_without_utd_flag() {
        let raw = raw_event(json!({
            "type": "m.room.message",
            "event_id": "$msg:example.org",
            "sender": "@bob:example.org",
            "origin_server_ts": 1_700_000_001_000i64,
            "content": { "msgtype": "m.text", "body": "hello world" },
        }));
        let event = TimelineEvent::from_plaintext(raw);
        let summary = summarize_timeline_event(&event).expect("normal summary");
        assert_eq!(summary.event_id, "$msg:example.org");
        assert_eq!(summary.body, "hello world");
        assert_eq!(summary.undecryptable, None);
        assert_eq!(summary.session_id, None);
        assert_eq!(summary.utd_reason, None);
    }

    #[test]
    fn uses_formatted_body_for_custom_emoji_in_summaries() {
        let content = json!({
            "msgtype": "m.text",
            "body": "mxc://matrix.example.org/party",
            "formatted_body": "hello <img data-mx-emoticon src=\"mxc://matrix.example.org/party\" alt=\":party_parrot:\">"
        });
        assert_eq!(readable_body(&content), "hello :party_parrot:");
    }

    fn message_event(content: Value) -> Value {
        json!({
            "type": "m.room.message",
            "event_id": "$event:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1_000,
            "content": content,
        })
    }

    fn media_from_json(event: Value) -> Vec<super::MatrixInboundMedia> {
        let timeline: AnySyncTimelineEvent =
            serde_json::from_value(event).expect("deserialize timeline event");
        media_from_timeline(timeline)
    }

    #[test]
    fn extracts_image_media_from_summary() {
        let media = media_from_json(message_event(json!({
            "msgtype": "m.image",
            "body": "cat.png",
            "filename": "cat.png",
            "url": "mxc://example.org/abc",
            "info": { "mimetype": "image/png", "size": 1234 },
        })));
        assert_eq!(media.len(), 1);
        let item = &media[0];
        assert_eq!(item.index, 0);
        assert!(matches!(item.kind, MatrixMediaKind::Image));
        assert_eq!(item.filename.as_deref(), Some("cat.png"));
        assert_eq!(item.content_type.as_deref(), Some("image/png"));
        assert_eq!(item.size_bytes, Some(1234));
    }

    #[test]
    fn extracts_file_media_from_summary() {
        let media = media_from_json(message_event(json!({
            "msgtype": "m.file",
            "body": "report.pdf",
            "filename": "report.pdf",
            "url": "mxc://example.org/file",
            "info": { "mimetype": "application/pdf", "size": 4096 },
        })));
        assert_eq!(media.len(), 1);
        assert!(matches!(media[0].kind, MatrixMediaKind::File));
        assert_eq!(media[0].filename.as_deref(), Some("report.pdf"));
        assert_eq!(media[0].content_type.as_deref(), Some("application/pdf"));
        assert_eq!(media[0].size_bytes, Some(4096));
    }

    #[test]
    fn extracts_video_media_from_summary() {
        let media = media_from_json(message_event(json!({
            "msgtype": "m.video",
            "body": "clip.mp4",
            "filename": "clip.mp4",
            "url": "mxc://example.org/vid",
            "info": { "mimetype": "video/mp4", "size": 8192 },
        })));
        assert_eq!(media.len(), 1);
        assert!(matches!(media[0].kind, MatrixMediaKind::Video));
        assert_eq!(media[0].content_type.as_deref(), Some("video/mp4"));
        assert_eq!(media[0].size_bytes, Some(8192));
    }

    #[test]
    fn extracts_audio_media_from_summary() {
        let media = media_from_json(message_event(json!({
            "msgtype": "m.audio",
            "body": "voice.ogg",
            "filename": "voice.ogg",
            "url": "mxc://example.org/aud",
            "info": { "mimetype": "audio/ogg", "size": 256 },
        })));
        assert_eq!(media.len(), 1);
        assert!(matches!(media[0].kind, MatrixMediaKind::Audio));
        assert_eq!(media[0].content_type.as_deref(), Some("audio/ogg"));
        assert_eq!(media[0].size_bytes, Some(256));
    }

    #[test]
    fn extracts_encrypted_media_descriptor_without_leaking_keys() {
        // Encrypted m.image: the URL is replaced by an encrypted `file` block
        // carrying key/iv. The descriptor must still be populated, but it carries
        // NONE of the encryption material — keys are resolved later at download.
        let media = media_from_json(message_event(json!({
            "msgtype": "m.image",
            "body": "secret.png",
            "filename": "secret.png",
            "file": {
                "url": "mxc://example.org/enc",
                "key": {
                    "kty": "oct",
                    "key_ops": ["encrypt", "decrypt"],
                    "alg": "A256CTR",
                    "k": "aWQ_onEl40OZQ_aWQ_onEl40OZQ_aWQ_onEl40OZQ_a",
                    "ext": true
                },
                "iv": "w+sE15fzSSw0Kg==",
                "hashes": { "sha256": "fdSLu/YkRx3Wyh3KQabP3rd6+SFiKg5lsJZQHtkSAYA" },
                "v": "v2"
            },
            "info": { "mimetype": "image/png", "size": 2048 },
        })));
        assert_eq!(media.len(), 1);
        assert!(matches!(media[0].kind, MatrixMediaKind::Image));
        assert_eq!(media[0].filename.as_deref(), Some("secret.png"));
        assert_eq!(media[0].content_type.as_deref(), Some("image/png"));
        assert_eq!(media[0].size_bytes, Some(2048));
        // The descriptor type structurally cannot carry keys; serializing it must
        // not surface any encryption material.
        let serialized = serde_json::to_string(&media[0]).expect("serialize descriptor");
        assert!(!serialized.contains("key"));
        assert!(!serialized.contains("iv"));
    }

    #[test]
    fn text_message_yields_no_media() {
        let media = media_from_json(message_event(json!({
            "msgtype": "m.text",
            "body": "just text",
        })));
        assert!(media.is_empty());
    }

    #[test]
    fn redacted_message_yields_no_media() {
        // A redacted m.room.message deserializes to the `Redacted` variant, which
        // is not `Original`, so no media is extracted (matches the live path).
        let event = json!({
            "type": "m.room.message",
            "event_id": "$redacted:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1_000,
            "content": {},
            "unsigned": {
                "redacted_because": {
                    "type": "m.room.redaction",
                    "event_id": "$redaction:example.org",
                    "sender": "@mod:example.org",
                    "origin_server_ts": 2_000,
                    "content": {},
                    "redacts": "$redacted:example.org"
                }
            }
        });
        assert!(media_from_json(event).is_empty());
    }

    fn message_content(content: Value) -> RoomMessageEventContent {
        serde_json::from_value(content).expect("deserialize message content")
    }

    #[test]
    fn edit_relation_surfaces_target_and_new_content() {
        // A real `m.replace` payload: the top-level body is the `* fallback`, and
        // the post-edit message lives under `m.new_content`. Normalization must
        // surface the target id and read the new content (never the fallback).
        let content = message_content(json!({
            "msgtype": "m.text",
            "body": "* edited text",
            "m.new_content": { "msgtype": "m.text", "body": "edited text" },
            "m.relates_to": { "rel_type": "m.replace", "event_id": "$target:example.org" },
        }));

        let (reply_to_id, thread_root_id, replaces_event_id) = relation_details(&content);
        assert_eq!(reply_to_id, None);
        assert_eq!(thread_root_id, None);
        assert_eq!(replaces_event_id.as_deref(), Some("$target:example.org"));

        let new_content = replacement_new_content(&content).expect("new content present");
        // The replacement body — not the `* fallback` — is what reaches the agent.
        assert_eq!(new_content.msgtype.body(), "edited text");
        assert_eq!(formatted_body(&new_content.msgtype), None);
        assert!(media_items(&new_content.msgtype).is_empty());
    }

    #[test]
    fn edit_relation_surfaces_replacement_media() {
        // An edit can replace the message with media; the descriptor must come
        // from `m.new_content`, mirroring the live non-edit media path.
        let content = message_content(json!({
            "msgtype": "m.text",
            "body": "* see image",
            "m.new_content": {
                "msgtype": "m.image",
                "body": "cat.png",
                "filename": "cat.png",
                "url": "mxc://example.org/abc",
                "info": { "mimetype": "image/png", "size": 1234 },
            },
            "m.relates_to": { "rel_type": "m.replace", "event_id": "$target:example.org" },
        }));

        let (_, _, replaces_event_id) = relation_details(&content);
        assert_eq!(replaces_event_id.as_deref(), Some("$target:example.org"));
        let new_content = replacement_new_content(&content).expect("new content present");
        let media = media_items(&new_content.msgtype);
        assert_eq!(media.len(), 1);
        assert!(matches!(media[0].kind, MatrixMediaKind::Image));
        assert_eq!(media[0].filename.as_deref(), Some("cat.png"));
    }

    #[test]
    fn non_edit_relations_have_no_replacement() {
        // A plain reply is not an edit: no replacement target, no new content.
        let reply = message_content(json!({
            "msgtype": "m.text",
            "body": "sure",
            "m.relates_to": { "m.in_reply_to": { "event_id": "$orig:example.org" } },
        }));
        let (reply_to_id, thread_root_id, replaces_event_id) = relation_details(&reply);
        assert_eq!(reply_to_id.as_deref(), Some("$orig:example.org"));
        assert_eq!(thread_root_id, None);
        assert_eq!(replaces_event_id, None);
        assert!(replacement_new_content(&reply).is_none());

        // A plain message has no relation at all.
        let plain = message_content(json!({ "msgtype": "m.text", "body": "hi" }));
        let (reply, thread, replaces) = relation_details(&plain);
        assert_eq!(reply, None);
        assert_eq!(thread, None);
        assert_eq!(replaces, None);
        assert!(replacement_new_content(&plain).is_none());
    }

    #[test]
    fn summary_edit_uses_new_content_body_not_fallback() {
        // The summarize path (used by `messageSummary` and the re-decryption
        // sweeper) must resolve `m.new_content` for an `m.replace` edit, just like
        // the live `normalize_inbound_event`. The top-level body is the
        // `* fallback`; the post-edit message lives under `m.new_content`.
        let event = message_event(json!({
            "msgtype": "m.text",
            "body": "* edited",
            "m.new_content": { "msgtype": "m.text", "body": "edited" },
            "m.relates_to": { "rel_type": "m.replace", "event_id": "$target:example.org" },
        }));
        let summary = summarize_message_value(&event).expect("edit summary");
        // The new-content body, NOT the `*`-prefixed fallback.
        assert_eq!(summary.body, "edited");
        assert_eq!(summary.msgtype.as_deref(), Some("m.text"));
        // The relation must still carry the replace target so downstream applies
        // the edit to the original message.
        let relates_to = summary.relates_to.expect("relates_to present");
        assert_eq!(relates_to.rel_type.as_deref(), Some("m.replace"));
        assert_eq!(relates_to.event_id.as_deref(), Some("$target:example.org"));
    }

    #[test]
    fn summary_edit_uses_new_content_media_not_fallback() {
        // An edit can replace text with media; the summarize media path must draw
        // the descriptor from `m.new_content`, not the top-level `* fallback`.
        let raw = raw_event(message_event(json!({
            "msgtype": "m.text",
            "body": "* see image",
            "m.new_content": {
                "msgtype": "m.image",
                "body": "cat.png",
                "filename": "cat.png",
                "url": "mxc://example.org/abc",
                "info": { "mimetype": "image/png", "size": 1234 },
            },
            "m.relates_to": { "rel_type": "m.replace", "event_id": "$target:example.org" },
        })));
        let event = TimelineEvent::from_plaintext(raw);
        let summary = summarize_timeline_event(&event).expect("edit summary");
        // Body resolves to the new-content fallback (an image's filename), not the
        // top-level `* see image`.
        assert_eq!(summary.body, "cat.png");
        assert_eq!(summary.msgtype.as_deref(), Some("m.image"));
        // Media is drawn from `m.new_content`'s image, not the top-level text
        // (which would yield no media at all).
        assert_eq!(summary.media.len(), 1);
        assert!(matches!(summary.media[0].kind, MatrixMediaKind::Image));
        assert_eq!(summary.media[0].filename.as_deref(), Some("cat.png"));
        assert_eq!(summary.media[0].content_type.as_deref(), Some("image/png"));
    }

    #[test]
    fn summary_non_edit_body_is_unchanged() {
        // Regression guard: a plain (non-edit) message's summary body and msgtype
        // come from the top-level content exactly as before.
        let event = message_event(json!({
            "msgtype": "m.text",
            "body": "hello world",
        }));
        let summary = summarize_message_value(&event).expect("plain summary");
        assert_eq!(summary.body, "hello world");
        assert_eq!(summary.msgtype.as_deref(), Some("m.text"));
        assert!(summary.relates_to.is_none());
    }
}

fn summary_relation(value: &Value) -> Option<MatrixMessageRelatesTo> {
    let relates_to = value
        .get("content")
        .and_then(|content| content.get("m.relates_to"))?;
    let rel_type = relates_to
        .get("rel_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let event_id = relates_to
        .get("event_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            relates_to
                .get("m.in_reply_to")
                .and_then(|value| value.get("event_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });

    if rel_type.is_none() && event_id.is_none() {
        return None;
    }

    Some(MatrixMessageRelatesTo { rel_type, event_id })
}

fn summarize_message_value(value: &Value) -> Option<MatrixMessageSummary> {
    if value.get("type").and_then(Value::as_str) != Some("m.room.message") {
        return None;
    }
    if value
        .get("unsigned")
        .and_then(|value| value.get("redacted_because"))
        .is_some()
    {
        return None;
    }

    let event_id = value.get("event_id").and_then(Value::as_str)?.to_string();
    let sender = value.get("sender").and_then(Value::as_str)?.to_string();
    let timestamp = value
        .get("origin_server_ts")
        .and_then(Value::as_i64)
        .map(timestamp_from_millis)
        .unwrap_or_else(Utc::now);
    let content = value.get("content")?;
    // For an `m.replace` edit the post-edit message lives under `m.new_content`;
    // the top-level body/msgtype are only the `* fallback`. Resolve to the
    // replacement content so the summarize path (used by the re-decryption
    // sweeper) surfaces the same body/msgtype/formatted as the live path. Keep
    // the top-level content for every non-edit message so all other behavior is
    // unchanged. `relates_to` below stays sourced from the top-level
    // `m.relates_to` so the edit is still detected downstream.
    let display_content = replacement_new_content_value(content).unwrap_or(content);
    let msgtype = display_content
        .get("msgtype")
        .and_then(Value::as_str)
        .map(str::to_string);

    Some(MatrixMessageSummary {
        event_id,
        sender,
        sender_name: None,
        body: readable_body(display_content),
        msgtype,
        timestamp,
        relates_to: summary_relation(value),
        // Default empty; the typed media extraction (when available) is layered
        // on by `summarize_timeline_event`. Non-media messages stay empty,
        // matching the live path where `media_items` returns `Vec::new()`.
        media: Vec::new(),
        // A decrypted m.room.message is never UTD.
        undecryptable: None,
        session_id: None,
        utd_reason: None,
    })
}

/// Build a UTD (undecryptable) summary placeholder from a timeline event whose
/// `kind` is `UnableToDecrypt`. Pulls `event_id`/`sender`/`origin_server_ts` from
/// the raw `m.room.encrypted` value (the only metadata available without the
/// session key) and the megolm `session_id` from the SDK's UTD info. Body and
/// media are intentionally empty — there is no plaintext to leak. Returns `None`
/// only if the raw event lacks the basic event_id/sender envelope.
fn summarize_utd_event(event: &TimelineEvent) -> Option<MatrixMessageSummary> {
    let value: Value = event.raw().deserialize_as_unchecked().ok()?;
    let event_id = value.get("event_id").and_then(Value::as_str)?.to_string();
    let sender = value.get("sender").and_then(Value::as_str)?.to_string();
    let timestamp = value
        .get("origin_server_ts")
        .and_then(Value::as_i64)
        .map(timestamp_from_millis)
        .unwrap_or_else(Utc::now);

    Some(MatrixMessageSummary {
        event_id,
        sender,
        sender_name: None,
        body: String::new(),
        msgtype: None,
        timestamp,
        relates_to: None,
        media: Vec::new(),
        undecryptable: Some(true),
        session_id: event.kind.session_id().map(str::to_owned),
        utd_reason: utd_reason_code(&event.kind),
    })
}

/// Map the SDK's `UnableToDecryptReason` to a stable lowercase string for
/// diagnostics. `None` for non-UTD kinds. The set of codes is part of the
/// native↔TS contract; keep it in sync with `MatrixMessageSummary.utdReason`
/// consumers on the TS side. `Unknown` (the SDK's deserialization fallback for
/// old records) maps to `"unknown"`.
fn utd_reason_code(kind: &TimelineEventKind) -> Option<String> {
    let TimelineEventKind::UnableToDecrypt { utd_info, .. } = kind else {
        return None;
    };
    let code = match &utd_info.reason {
        UnableToDecryptReason::MalformedEncryptedEvent => "malformed_encrypted_event",
        UnableToDecryptReason::MissingMegolmSession { .. } => "missing_megolm_session",
        UnableToDecryptReason::UnknownMegolmMessageIndex => "unknown_megolm_message_index",
        UnableToDecryptReason::MegolmDecryptionFailure => "megolm_decryption_failure",
        UnableToDecryptReason::PayloadDeserializationFailure => "payload_deserialization_failure",
        UnableToDecryptReason::MismatchedIdentityKeys => "mismatched_identity_keys",
        UnableToDecryptReason::SenderIdentityNotTrusted(_) => "sender_identity_not_trusted",
        UnableToDecryptReason::Unknown => "unknown",
        // `UnableToDecryptReason` is not `#[non_exhaustive]` and its only other
        // variant (`StateKeyVerificationFailed`) is behind a matrix-sdk feature we
        // don't enable, so this match is exhaustive. A future SDK variant will
        // break the build here rather than be silently mislabeled — surface it
        // explicitly when that happens.
    };
    Some(code.to_string())
}

pub fn summarize_timeline_event(event: &TimelineEvent) -> Option<MatrixMessageSummary> {
    // Undecryptable events carry no plaintext, so they never deserialize as an
    // `m.room.message`. Surface them as a placeholder instead of dropping them so
    // they reach the timeline like a human client shows them. Re-fetching the
    // same event id once keys arrive returns a normal summary (the path the
    // re-decryption sweeper relies on).
    if event.kind.is_utd() {
        return summarize_utd_event(event);
    }
    let value: Value = event.raw().deserialize_as_unchecked().ok()?;
    let mut summary = summarize_message_value(&value)?;
    summary.media = media_from_raw(event);
    Some(summary)
}

/// Extract media descriptors from a timeline event by deserializing into the
/// typed `MessageType` and reusing the live `media_items` converter, so backfill
/// and live reception produce identical media. Best-effort: returns an empty vec
/// on typed-deserialize failure or non-`Original` (e.g. redacted) events — media
/// is additive and must never cause the surrounding summary to be dropped.
fn media_from_raw(event: &TimelineEvent) -> Vec<MatrixInboundMedia> {
    match event.raw().deserialize_as_unchecked::<AnySyncTimelineEvent>() {
        Ok(timeline) => media_from_timeline(timeline),
        Err(_) => Vec::new(),
    }
}

/// Pull media from an already-deserialized timeline event. Only the `Original`
/// (non-redacted) `m.room.message` variant yields media, mirroring the live
/// download path (`media/mod.rs`); everything else maps to an empty vec.
fn media_from_timeline(timeline: AnySyncTimelineEvent) -> Vec<MatrixInboundMedia> {
    match timeline {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
            SyncRoomMessageEvent::Original(ev),
        )) => {
            // For an `m.replace` edit the media descriptor must come from the
            // replacement (`m.new_content`), not the top-level `* fallback`
            // msgtype — mirroring the live path which resolves edit media via
            // `media_items(&new_content.msgtype)`. Non-edits use the top-level
            // msgtype exactly as before.
            let msgtype = replacement_new_content(&ev.content)
                .map(|new_content| &new_content.msgtype)
                .unwrap_or(&ev.content.msgtype);
            media_items(msgtype)
        }
        _ => Vec::new(),
    }
}

pub async fn normalize_inbound_event(
    room: &Room,
    event: &OriginalSyncRoomMessageEvent,
) -> Option<MatrixInboundEvent> {
    let (reply_to_id, thread_root_id, replaces_event_id) = relation_details(&event.content);

    // For an `m.replace` edit, the post-edit message lives under `m.new_content`;
    // the top-level body is only the `* fallback`. Surface the edit (don't drop
    // it) with its replacement body/media/msgtype and a `relates_to` carrying the
    // target id so the TS live path can apply it to the original message. Mentions
    // come from `new_content` too (ruma copies the mentions into the replacement).
    let new_content = replacement_new_content(&event.content);
    let content_msgtype = new_content
        .map(|content| &content.msgtype)
        .unwrap_or(&event.content.msgtype);
    let content_mentions = new_content
        .map(|content| content.mentions.as_ref())
        .unwrap_or(event.content.mentions.as_ref());
    let relates_to = replaces_event_id.map(|event_id| MatrixMessageRelatesTo {
        rel_type: Some("m.replace".to_string()),
        event_id: Some(event_id),
    });

    let chat_type = if thread_root_id.is_some() {
        MatrixChatType::Thread
    } else if room.is_direct().await.unwrap_or(false) {
        MatrixChatType::Direct
    } else {
        MatrixChatType::Channel
    };

    let room_name = room
        .display_name()
        .await
        .ok()
        .map(|value| value.to_string());
    let room_alias = room.canonical_alias().map(|value| value.to_string());
    let sender_name = room
        .get_member_no_sync(&event.sender)
        .await
        .ok()
        .flatten()
        .map(|member| member.name().to_string());

    Some(MatrixInboundEvent {
        room_id: room.room_id().to_string(),
        event_id: event.event_id.to_string(),
        sender_id: event.sender.to_string(),
        sender_name,
        room_name,
        room_alias,
        chat_type,
        body: content_msgtype.body().to_string(),
        msgtype: Some(content_msgtype.msgtype().to_string()),
        formatted_body: formatted_body(content_msgtype),
        mentions: content_mentions.map(|mentions| MatrixInboundMentions {
            user_ids: (!mentions.user_ids.is_empty())
                .then(|| mentions.user_ids.iter().map(ToString::to_string).collect()),
            room: mentions.room.then_some(true),
        }),
        reply_to_id,
        thread_root_id,
        relates_to,
        timestamp: timestamp_from_event(event),
        media: media_items(content_msgtype),
        // The typed `OriginalSyncRoomMessageEvent` handler only fires for already
        // decrypted events, so the live normalized path is never UTD.
        undecryptable: None,
        session_id: None,
        utd_reason: None,
    })
}

/// Build a UTD placeholder `MatrixInboundEvent` from a raw `m.room.encrypted`
/// value seen on live sync. Only metadata visible without the session key is
/// surfaced (event_id/sender/origin_server_ts/session_id); body is empty and no
/// content is leaked. Returns `None` if the raw envelope lacks event_id/sender or
/// the event is a redaction tombstone. `chat_type` is resolved from the room the
/// same way as the decrypted path.
pub async fn normalize_utd_inbound_event(
    room: &Room,
    value: &Value,
) -> Option<MatrixInboundEvent> {
    if value
        .get("unsigned")
        .and_then(|unsigned| unsigned.get("redacted_because"))
        .is_some()
    {
        return None;
    }
    let event_id = value.get("event_id").and_then(Value::as_str)?.to_string();
    let sender = value.get("sender").and_then(Value::as_str)?.to_string();
    let timestamp = value
        .get("origin_server_ts")
        .and_then(Value::as_i64)
        .map(timestamp_from_millis)
        .unwrap_or_else(Utc::now);
    let session_id = value
        .get("content")
        .and_then(|content| content.get("session_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let chat_type = if room.is_direct().await.unwrap_or(false) {
        MatrixChatType::Direct
    } else {
        MatrixChatType::Channel
    };
    let room_name = room.display_name().await.ok().map(|value| value.to_string());
    let room_alias = room.canonical_alias().map(|value| value.to_string());

    Some(MatrixInboundEvent {
        room_id: room.room_id().to_string(),
        event_id,
        sender_id: sender,
        sender_name: None,
        room_name,
        room_alias,
        chat_type,
        body: String::new(),
        msgtype: None,
        formatted_body: None,
        mentions: None,
        reply_to_id: None,
        thread_root_id: None,
        // A UTD envelope carries no decrypted relation; if it later decrypts to an
        // edit, the re-decryption sweeper's summary path surfaces `relates_to`.
        relates_to: None,
        timestamp,
        media: Vec::new(),
        undecryptable: Some(true),
        session_id,
        // The live UTD handler receives only the raw `m.room.encrypted` envelope,
        // not the SDK's structured `UnableToDecryptInfo`, so no reason code is
        // available here. The re-decryption sweeper's summary path
        // (`summarize_utd_event`) supplies a `utd_reason` when it later re-fetches
        // the event through `room.messages()`.
        utd_reason: None,
    })
}
