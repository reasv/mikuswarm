use chrono::{DateTime, Utc};
use matrix_sdk::{
    deserialized_responses::TimelineEvent,
    ruma::events::room::message::{
        FormattedBody, MessageType, OriginalSyncRoomMessageEvent, Relation, RoomMessageEventContent,
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

fn relation_details(content: &RoomMessageEventContent) -> (Option<String>, Option<String>, bool) {
    match content.relates_to.as_ref() {
        Some(Relation::Replacement(_)) => (None, None, true),
        Some(Relation::Reply { in_reply_to }) => {
            (Some(in_reply_to.event_id.to_string()), None, false)
        }
        Some(Relation::Thread(thread)) => (
            thread
                .in_reply_to
                .as_ref()
                .map(|value| value.event_id.to_string()),
            Some(thread.event_id.to_string()),
            false,
        ),
        Some(Relation::_Custom(_)) | Some(_) | None => (None, None, false),
    }
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
    use super::readable_body;
    use serde_json::json;

    #[test]
    fn uses_formatted_body_for_custom_emoji_in_summaries() {
        let content = json!({
            "msgtype": "m.text",
            "body": "mxc://matrix.example.org/party",
            "formatted_body": "hello <img data-mx-emoticon src=\"mxc://matrix.example.org/party\" alt=\":party_parrot:\">"
        });
        assert_eq!(readable_body(&content), "hello :party_parrot:");
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
    let msgtype = content
        .get("msgtype")
        .and_then(Value::as_str)
        .map(str::to_string);

    Some(MatrixMessageSummary {
        event_id,
        sender,
        body: readable_body(content),
        msgtype,
        timestamp,
        relates_to: summary_relation(value),
    })
}

pub fn summarize_timeline_event(event: &TimelineEvent) -> Option<MatrixMessageSummary> {
    let value: Value = event.raw().deserialize_as_unchecked().ok()?;
    summarize_message_value(&value)
}

pub async fn normalize_inbound_event(
    room: &Room,
    event: &OriginalSyncRoomMessageEvent,
) -> Option<MatrixInboundEvent> {
    let (reply_to_id, thread_root_id, is_replacement) = relation_details(&event.content);
    if is_replacement {
        return None;
    }

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
        body: event.content.body().to_string(),
        msgtype: Some(event.content.msgtype.msgtype().to_string()),
        formatted_body: formatted_body(&event.content.msgtype),
        mentions: event
            .content
            .mentions
            .as_ref()
            .map(|mentions| MatrixInboundMentions {
                user_ids: (!mentions.user_ids.is_empty())
                    .then(|| mentions.user_ids.iter().map(ToString::to_string).collect()),
                room: mentions.room.then_some(true),
            }),
        reply_to_id,
        thread_root_id,
        timestamp: timestamp_from_event(event),
        media: media_items(&event.content.msgtype),
    })
}
