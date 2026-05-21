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

async fn download_media_from_message(
    client: &matrix_sdk::Client,
    room_id: &str,
    event_id: &str,
    msgtype: &MessageType,
) -> MatrixResult<Option<MatrixDownloadMediaResult>> {
    let result =
        match msgtype {
            MessageType::Audio(content) => {
                client.media().get_file(content, true).await?.map(|data| {
                    MatrixDownloadMediaResult {
                        room_id: room_id.to_string(),
                        event_id: event_id.to_string(),
                        kind: MatrixMediaKind::Audio,
                        body: content.caption().map(ToOwned::to_owned),
                        filename: Some(content.filename().to_string()),
                        content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
                        data_base64: STANDARD.encode(data),
                    }
                })
            }
            MessageType::File(content) => {
                client.media().get_file(content, true).await?.map(|data| {
                    MatrixDownloadMediaResult {
                        room_id: room_id.to_string(),
                        event_id: event_id.to_string(),
                        kind: MatrixMediaKind::File,
                        body: content.caption().map(ToOwned::to_owned),
                        filename: Some(content.filename().to_string()),
                        content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
                        data_base64: STANDARD.encode(data),
                    }
                })
            }
            MessageType::Image(content) => {
                client.media().get_file(content, true).await?.map(|data| {
                    MatrixDownloadMediaResult {
                        room_id: room_id.to_string(),
                        event_id: event_id.to_string(),
                        kind: MatrixMediaKind::Image,
                        body: content.caption().map(ToOwned::to_owned),
                        filename: Some(content.filename().to_string()),
                        content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
                        data_base64: STANDARD.encode(data),
                    }
                })
            }
            MessageType::Video(content) => {
                client.media().get_file(content, true).await?.map(|data| {
                    MatrixDownloadMediaResult {
                        room_id: room_id.to_string(),
                        event_id: event_id.to_string(),
                        kind: MatrixMediaKind::Video,
                        body: content.caption().map(ToOwned::to_owned),
                        filename: Some(content.filename().to_string()),
                        content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
                        data_base64: STANDARD.encode(data),
                    }
                })
            }
            _ => None,
        };
    Ok(result)
}

pub async fn download_media(
    client: &matrix_sdk::Client,
    room: &Room,
    event_id: &EventId,
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
        &message_event.content.msgtype,
    )
    .await?
    .ok_or_else(|| {
        MatrixError::State("target event does not contain downloadable media".to_string())
    })
}
