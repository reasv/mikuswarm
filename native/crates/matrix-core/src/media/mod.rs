use std::path::PathBuf;
use std::str::FromStr;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use matrix_sdk::{
    attachment::{AttachmentConfig, Thumbnail},
    room::reply::{EnforceThread, Reply},
    ruma::{
        events::{
            room::message::{MessageType, ReplyWithinThread},
            AnySyncMessageLikeEvent, AnySyncTimelineEvent,
        },
        EventId, OwnedEventId, UInt,
    },
    Room,
};

use serde_json::{json, Value};

use crate::{
    api::{MatrixDownloadMediaResult, MatrixMediaKind, MatrixUploadMediaRequest, MatrixUploadMediaThumbnail},
    MatrixError, MatrixResult,
};

fn parse_event_id(event_id: &str, field: &str) -> MatrixResult<OwnedEventId> {
    let trimmed = event_id.trim();
    if trimmed.is_empty() {
        return Err(MatrixError::State(format!("{field} is required")));
    }
    Ok(EventId::parse(trimmed)?.to_owned())
}

pub fn build_reply(
    reply_to_id: Option<&str>,
    thread_id: Option<&str>,
) -> MatrixResult<Option<Reply>> {
    match (
        reply_to_id.map(str::trim).filter(|value| !value.is_empty()),
        thread_id.map(str::trim).filter(|value| !value.is_empty()),
    ) {
        (Some(reply_to_id), Some(_thread_id)) => Ok(Some(Reply {
            event_id: parse_event_id(reply_to_id, "reply_to_id")?,
            enforce_thread: EnforceThread::Threaded(ReplyWithinThread::Yes),
        })),
        (Some(reply_to_id), None) => Ok(Some(Reply {
            event_id: parse_event_id(reply_to_id, "reply_to_id")?,
            enforce_thread: EnforceThread::Unthreaded,
        })),
        (None, Some(thread_id)) => Ok(Some(Reply {
            event_id: parse_event_id(thread_id, "thread_id")?,
            enforce_thread: EnforceThread::Threaded(ReplyWithinThread::No),
        })),
        (None, None) => Ok(None),
    }
}

/// Build `m.relates_to` JSON for use with `room.send_raw()`.
///
/// Unlike [`build_reply`] which returns a [`Reply`] for the SDK's
/// `AttachmentConfig`, this function produces the raw JSON value needed when
/// constructing event content manually (voice messages, polls, etc.).
pub(crate) fn build_relates_to(
    reply_to_id: Option<&str>,
    thread_id: Option<&str>,
) -> MatrixResult<Option<Value>> {
    let reply_to = reply_to_id.map(str::trim).filter(|v| !v.is_empty());
    let thread = thread_id.map(str::trim).filter(|v| !v.is_empty());

    match (reply_to, thread) {
        (Some(reply_id), Some(thread_root)) => {
            // Reply within a thread
            Ok(Some(json!({
                "rel_type": "m.thread",
                "event_id": thread_root,
                "is_falling_back": false,
                "m.in_reply_to": { "event_id": reply_id }
            })))
        }
        (None, Some(thread_root)) => {
            // Post to thread (no specific reply)
            Ok(Some(json!({
                "rel_type": "m.thread",
                "event_id": thread_root,
                "is_falling_back": true,
                "m.in_reply_to": { "event_id": thread_root }
            })))
        }
        (Some(reply_id), None) => {
            // Plain reply, no thread
            Ok(Some(json!({
                "m.in_reply_to": { "event_id": reply_id }
            })))
        }
        (None, None) => Ok(None),
    }
}

pub async fn upload_media(room: &Room, request: &MatrixUploadMediaRequest) -> MatrixResult<String> {
    let content_type = mime::Mime::from_str(request.content_type.trim()).map_err(|err| {
        MatrixError::State(format!(
            "invalid content_type {}: {err}",
            request.content_type
        ))
    })?;
    let data = STANDARD
        .decode(request.data_base64.trim())
        .map_err(|err| MatrixError::State(format!("invalid base64 media payload: {err}")))?;

    if request.as_voice.unwrap_or(false) {
        return upload_voice_media(room, request, &content_type, data).await;
    }

    let thumbnail = request
        .thumbnail
        .as_ref()
        .map(parse_thumbnail)
        .transpose()?;
    let reply = build_reply(request.reply_to_id.as_deref(), request.thread_id.as_deref())?;
    let caption = request
        .caption
        .as_deref()
        .map(matrix_sdk::ruma::events::room::message::TextMessageEventContent::plain);
    let config = AttachmentConfig::new()
        .thumbnail(thumbnail)
        .caption(caption)
        .reply(reply);
    let response = room
        .send_attachment(&request.filename, &content_type, data, config)
        .await?;
    Ok(response.event_id.to_string())
}

async fn upload_voice_media(
    room: &Room,
    request: &MatrixUploadMediaRequest,
    content_type: &mime::Mime,
    data: Vec<u8>,
) -> MatrixResult<String> {
    let size_bytes = data.len() as u64;
    let upload_response = room
        .client()
        .media()
        .upload(content_type, data, None)
        .await?;
    let mxc_url = upload_response.content_uri.to_string();

    let mut info = json!({
        "mimetype": content_type.to_string(),
        "size": size_bytes,
    });
    if let Some(duration_ms) = request.duration_ms {
        info["duration"] = json!(duration_ms);
    }

    let mut content = json!({
        "msgtype": "m.audio",
        "body": "Voice message",
        "url": mxc_url,
        "info": info,
        "org.matrix.msc3245.voice": {},
    });
    if let Some(duration_ms) = request.duration_ms {
        content["org.matrix.msc1767.audio"] = json!({ "duration": duration_ms });
    }

    if let Some(relates_to) = build_relates_to(request.reply_to_id.as_deref(), request.thread_id.as_deref())? {
        content["m.relates_to"] = relates_to;
    }

    let response = room
        .send_raw("m.room.message", content)
        .await?;
    Ok(response.event_id.to_string())
}

fn parse_thumbnail(thumbnail: &MatrixUploadMediaThumbnail) -> MatrixResult<Thumbnail> {
    let content_type = mime::Mime::from_str(thumbnail.content_type.trim()).map_err(|err| {
        MatrixError::State(format!(
            "invalid thumbnail content_type {}: {err}",
            thumbnail.content_type
        ))
    })?;
    let data = STANDARD
        .decode(thumbnail.data_base64.trim())
        .map_err(|err| MatrixError::State(format!("invalid base64 thumbnail payload: {err}")))?;
    let width = UInt::try_from(u64::from(thumbnail.width))
        .map_err(|_| MatrixError::State("invalid thumbnail width".to_string()))?;
    let height = UInt::try_from(u64::from(thumbnail.height))
        .map_err(|_| MatrixError::State("invalid thumbnail height".to_string()))?;
    let size = UInt::try_from(thumbnail.size_bytes)
        .map_err(|_| MatrixError::State("invalid thumbnail size".to_string()))?;
    Ok(Thumbnail {
        data,
        content_type,
        width,
        height,
        size,
    })
}

fn check_declared_size(declared: Option<u64>, limit: Option<u64>) -> MatrixResult<()> {
    if let (Some(limit), Some(declared)) = (limit, declared) {
        if declared > limit {
            return Err(MatrixError::State(format!(
                "media size ({declared} bytes) exceeds download limit ({limit} bytes)"
            )));
        }
    }
    Ok(())
}

async fn download_media_from_message(
    client: &matrix_sdk::Client,
    room_id: &str,
    event_id: &str,
    output_path: &str,
    msgtype: &MessageType,
    size_limit: Option<u64>,
) -> MatrixResult<Option<MatrixDownloadMediaResult>> {
    let (kind, body, filename, content_type, data) = match msgtype {
        MessageType::Audio(content) => {
            check_declared_size(
                content.info.as_ref().and_then(|info| info.size.map(u64::from)),
                size_limit,
            )?;
            let Some(data) = client.media().get_file(content, true).await? else {
                return Ok(None);
            };
            (
                MatrixMediaKind::Audio,
                content.caption().map(ToOwned::to_owned),
                Some(content.filename().to_string()),
                content.info.as_ref().and_then(|info| info.mimetype.clone()),
                data,
            )
        }
        MessageType::File(content) => {
            check_declared_size(
                content.info.as_ref().and_then(|info| info.size.map(u64::from)),
                size_limit,
            )?;
            let Some(data) = client.media().get_file(content, true).await? else {
                return Ok(None);
            };
            (
                MatrixMediaKind::File,
                content.caption().map(ToOwned::to_owned),
                Some(content.filename().to_string()),
                content.info.as_ref().and_then(|info| info.mimetype.clone()),
                data,
            )
        }
        MessageType::Image(content) => {
            check_declared_size(
                content.info.as_ref().and_then(|info| info.size.map(u64::from)),
                size_limit,
            )?;
            let Some(data) = client.media().get_file(content, true).await? else {
                return Ok(None);
            };
            (
                MatrixMediaKind::Image,
                content.caption().map(ToOwned::to_owned),
                Some(content.filename().to_string()),
                content.info.as_ref().and_then(|info| info.mimetype.clone()),
                data,
            )
        }
        MessageType::Video(content) => {
            check_declared_size(
                content.info.as_ref().and_then(|info| info.size.map(u64::from)),
                size_limit,
            )?;
            let Some(data) = client.media().get_file(content, true).await? else {
                return Ok(None);
            };
            (
                MatrixMediaKind::Video,
                content.caption().map(ToOwned::to_owned),
                Some(content.filename().to_string()),
                content.info.as_ref().and_then(|info| info.mimetype.clone()),
                data,
            )
        }
        _ => return Ok(None),
    };

    let size_bytes = data.len() as u64;
    if let Some(limit) = size_limit {
        if size_bytes > limit {
            return Err(MatrixError::State(format!(
                "downloaded media size ({size_bytes} bytes) exceeds download limit ({limit} bytes)"
            )));
        }
    }

    let resolved = PathBuf::from(output_path);
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&resolved, &data).await?;

    Ok(Some(MatrixDownloadMediaResult {
        room_id: room_id.to_string(),
        event_id: event_id.to_string(),
        kind,
        body,
        filename,
        content_type,
        size_bytes,
    }))
}

pub async fn download_media(
    client: &matrix_sdk::Client,
    room: &Room,
    event_id: &EventId,
    output_path: &str,
    size_limit: Option<u64>,
) -> MatrixResult<MatrixDownloadMediaResult> {
    let event = room.load_or_fetch_event(event_id, None).await?;
    let raw = event.into_raw();
    let timeline: AnySyncTimelineEvent = raw
        .deserialize()
        .map_err(|err| MatrixError::State(format!("failed to deserialize media event: {err}")))?;

    let AnySyncTimelineEvent::MessageLike(message_like) = timeline else {
        return Err(MatrixError::State(
            "target event is not a message-like event".to_string(),
        ));
    };
    let AnySyncMessageLikeEvent::RoomMessage(message_event) = message_like else {
        return Err(MatrixError::State(
            "target event is not an m.room.message".to_string(),
        ));
    };
    let matrix_sdk::ruma::events::room::message::SyncRoomMessageEvent::Original(message_event) =
        message_event
    else {
        return Err(MatrixError::State(
            "redacted message events do not contain media".to_string(),
        ));
    };

    download_media_from_message(
        client,
        room.room_id().as_str(),
        event_id.as_str(),
        output_path,
        &message_event.content.msgtype,
        size_limit,
    )
    .await?
    .ok_or_else(|| {
        MatrixError::State("target event does not contain downloadable media".to_string())
    })
}
