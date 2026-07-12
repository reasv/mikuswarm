mod api;
mod auth;
mod client;
mod crypto;
mod emoji;
mod events;
mod media;
mod mentions;
mod previews;
mod reactions;
mod state;
mod sync;
mod tokenizer;

use std::sync::Mutex;

use matrix_sdk::ruma::IdParseError;
use napi_derive::napi;
use thiserror::Error;

use crate::{
    api::{
        MatrixChannelInfoRequest, MatrixClientConfig, MatrixCreatePollRequest,
        MatrixCustomEmojiUsageRequest,
        MatrixDeleteMessageRequest, MatrixDownloadMediaRequest, MatrixEditMessageRequest,
        MatrixJoinRequest, MatrixListEmojiRequest, MatrixListPinsRequest,
        MatrixListReactionsRequest, MatrixMemberInfoRequest, MatrixMessageSummaryRequest,
        MatrixPinMessageRequest, MatrixPollVoteRequest, MatrixReactRequest,
        MatrixReadMessagesRequest, MatrixResolveLinkPreviewsRequest,
        MatrixResolveTargetRequest, MatrixRoomMembersRequest, MatrixSendRequest,
        MatrixSetProfileRequest, MatrixTypingRequest, MatrixUploadMediaRequest,
    },
    client::{
        channel_info_internal, create_poll_internal, delete_message_internal,
        download_media_internal, download_room_keys_for_room_internal, edit_message_internal,
        join_room_internal,
        list_pins_internal, list_reactions_internal, member_info_internal,
        message_summary_internal, pin_message_internal, poll_vote_internal,
        react_message_internal, read_messages_internal, resolve_target_internal,
        room_members_internal, send_message_internal, set_profile_internal, set_typing_internal,
        unpin_message_internal, upload_media_internal, MatrixCoreService,
    },
};

type MatrixResult<T> = std::result::Result<T, MatrixError>;

#[derive(Debug, Error)]
enum MatrixError {
    #[error("{0}")]
    State(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error(transparent)]
    MatrixSdk(#[from] matrix_sdk::Error),
    #[error(transparent)]
    Http(#[from] matrix_sdk::HttpError),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
    #[error(transparent)]
    MatrixBuild(#[from] matrix_sdk::ClientBuildError),
    #[error(transparent)]
    IdParse(#[from] IdParseError),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
}

fn to_napi_error(err: MatrixError) -> napi::Error {
    napi::Error::from_reason(err.to_string())
}

#[napi]
pub struct MatrixCoreClient {
    inner: Mutex<MatrixCoreService>,
}

#[napi]
impl MatrixCoreClient {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MatrixCoreService::new()),
        }
    }

    #[napi]
    pub fn start(&self, config_json: String) -> napi::Result<String> {
        let config: MatrixClientConfig = serde_json::from_str(&config_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let diagnostics = inner.start(config).map_err(to_napi_error)?;
        serde_json::to_string(&diagnostics).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi]
    pub fn stop(&self) -> napi::Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        inner.stop();
        Ok(())
    }

    #[napi(js_name = "pollEvents")]
    pub fn poll_events(&self) -> napi::Result<String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let events = inner.poll_events();
        serde_json::to_string(&events).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi]
    pub fn diagnostics(&self) -> napi::Result<String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        serde_json::to_string(&inner.diagnostics())
            .map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "sendMessage")]
    pub async fn send_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixSendRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let (client, config) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            (
                inner.client().map_err(to_napi_error)?,
                inner.config_clone().map_err(to_napi_error)?,
            )
        };
        let result = send_message_internal(&client, &config, &request)
            .await
            .map_err(to_napi_error)?;
        if let Ok(inner) = self.inner.lock() {
            inner.record_outbound(
                &result.room_id,
                &result.message_id,
                request.thread_id.as_deref(),
                request.reply_to_id.as_deref(),
            );
        }
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "resolveTarget")]
    pub async fn resolve_target(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixResolveTargetRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = resolve_target_internal(
            &client,
            &request.target,
            request.create_dm.unwrap_or(true),
        )
        .await
        .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "joinRoom")]
    pub async fn join_room(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixJoinRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = join_room_internal(&client, &request.target)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "readMessages")]
    pub async fn read_messages(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixReadMessagesRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = read_messages_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    /// Pull every backed-up megolm session for `room_id` from the server-side key
    /// backup into the crypto store (per-room, bounded). Used to hydrate history
    /// keys before a deep backfetch descent so it decrypts inline. No-op when no
    /// backup/decryption key is available.
    #[napi(js_name = "downloadRoomKeysForRoom")]
    pub async fn download_room_keys_for_room(&self, room_id: String) -> napi::Result<()> {
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        download_room_keys_for_room_internal(&client, &room_id)
            .await
            .map_err(to_napi_error)?;
        Ok(())
    }

    #[napi(js_name = "editMessage")]
    pub async fn edit_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixEditMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let (client, config) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            (
                inner.client().map_err(to_napi_error)?,
                inner.config_clone().map_err(to_napi_error)?,
            )
        };
        let result = edit_message_internal(&client, &config, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "deleteMessage")]
    pub async fn delete_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixDeleteMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = delete_message_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "pinMessage")]
    pub async fn pin_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixPinMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = pin_message_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "unpinMessage")]
    pub async fn unpin_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixPinMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = unpin_message_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "listPins")]
    pub async fn list_pins(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixListPinsRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = list_pins_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "memberInfo")]
    pub async fn member_info(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixMemberInfoRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = member_info_internal(&client, &request.room_id, &request.user_id)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "roomMembers")]
    pub async fn room_members(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixRoomMembersRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = room_members_internal(&client, &request.room_id)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "messageSummary")]
    pub async fn message_summary(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixMessageSummaryRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = message_summary_internal(&client, &request.room_id, &request.event_id)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "channelInfo")]
    pub async fn channel_info(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixChannelInfoRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = channel_info_internal(&client, &request.room_id)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "uploadMedia")]
    pub async fn upload_media(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixUploadMediaRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = upload_media_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "downloadMedia")]
    pub async fn download_media(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixDownloadMediaRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = download_media_internal(&client, &request.room_id, &request.event_id, &request.output_path, request.size_limit)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "reactMessage")]
    pub async fn react_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixReactRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let (client, config, sender_id) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            let client = inner.client().map_err(to_napi_error)?;
            let config = inner.config_clone().map_err(to_napi_error)?;
            let sender_id = client
                .user_id()
                .map(|id| id.to_string())
                .unwrap_or_else(|| inner.diagnostics().user_id);
            (client, config, sender_id)
        };
        let result = react_message_internal(&client, &config, &request, &sender_id)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "listReactions")]
    pub async fn list_reactions(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixListReactionsRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let (client, config) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            (
                inner.client().map_err(to_napi_error)?,
                inner.config_clone().map_err(to_napi_error)?,
            )
        };
        let result = list_reactions_internal(&client, &config, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "recordCustomEmojiUsage")]
    pub fn record_custom_emoji_usage(&self, request_json: String) -> napi::Result<()> {
        let request: MatrixCustomEmojiUsageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        inner
            .record_custom_emoji_usage(request)
            .map_err(to_napi_error)
    }

    #[napi(js_name = "listKnownShortcodes")]
    pub fn list_known_shortcodes(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixListEmojiRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner
            .list_known_shortcodes(request)
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "resolveLinkPreviews")]
    pub async fn resolve_link_previews(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixResolveLinkPreviewsRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let (homeserver, access_token) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            inner.link_preview_context().map_err(to_napi_error)?
        };
        let result = previews::resolve_link_previews(&homeserver, &access_token, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "setTyping")]
    pub async fn set_typing(&self, request_json: String) -> napi::Result<()> {
        let request: MatrixTypingRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        set_typing_internal(&client, &request.room_id, request.typing)
            .await
            .map_err(to_napi_error)
    }

    #[napi(js_name = "setProfile")]
    pub async fn set_profile(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixSetProfileRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = set_profile_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "createPoll")]
    pub async fn create_poll(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixCreatePollRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = create_poll_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "pollVote")]
    pub async fn poll_vote(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixPollVoteRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let client = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
            if !inner.is_running() {
                return Err(napi::Error::from_reason("client is not running"));
            }
            inner.client().map_err(to_napi_error)?
        };
        let result = poll_vote_internal(&client, &request)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }
}
