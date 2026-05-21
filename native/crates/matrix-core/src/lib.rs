mod api;
mod auth;
mod client;
mod crypto;
mod emoji;
mod events;
mod media;
mod previews;
mod reactions;
mod state;
mod sync;

use std::sync::Mutex;

use matrix_sdk::ruma::IdParseError;
use napi_derive::napi;
use thiserror::Error;

use crate::{
    api::{
        MatrixChannelInfoRequest, MatrixClientConfig, MatrixCustomEmojiUsageRequest,
        MatrixDeleteMessageRequest, MatrixDownloadMediaRequest, MatrixEditMessageRequest,
        MatrixJoinRequest, MatrixListEmojiRequest, MatrixListPinsRequest,
        MatrixListReactionsRequest, MatrixMemberInfoRequest, MatrixMessageSummaryRequest,
        MatrixPinMessageRequest, MatrixReactRequest, MatrixReadMessagesRequest,
        MatrixResolveLinkPreviewsRequest, MatrixResolveTargetRequest, MatrixSendRequest,
        MatrixTypingRequest, MatrixUploadMediaRequest,
    },
    client::MatrixCoreService,
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
    pub fn send_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixSendRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.send_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "resolveTarget")]
    pub fn resolve_target(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixResolveTargetRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.resolve_target(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "joinRoom")]
    pub fn join_room(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixJoinRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.join_room(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "readMessages")]
    pub fn read_messages(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixReadMessagesRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.read_messages(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "editMessage")]
    pub fn edit_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixEditMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.edit_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "deleteMessage")]
    pub fn delete_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixDeleteMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.delete_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "pinMessage")]
    pub fn pin_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixPinMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.pin_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "unpinMessage")]
    pub fn unpin_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixPinMessageRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.unpin_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "listPins")]
    pub fn list_pins(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixListPinsRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.list_pins(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "memberInfo")]
    pub fn member_info(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixMemberInfoRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.member_info(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "messageSummary")]
    pub fn message_summary(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixMessageSummaryRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.message_summary(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "channelInfo")]
    pub fn channel_info(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixChannelInfoRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.channel_info(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "uploadMedia")]
    pub fn upload_media(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixUploadMediaRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.upload_media(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "downloadMedia")]
    pub fn download_media(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixDownloadMediaRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.download_media(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "reactMessage")]
    pub fn react_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixReactRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.react_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "listReactions")]
    pub fn list_reactions(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixListReactionsRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.list_reactions(request).map_err(to_napi_error)?;
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
    pub fn resolve_link_previews(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixResolveLinkPreviewsRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner
            .resolve_link_previews(request)
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "setTyping")]
    pub fn set_typing(&self, request_json: String) -> napi::Result<()> {
        let request: MatrixTypingRequest = serde_json::from_str(&request_json)
            .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        inner.set_typing(request).map_err(to_napi_error)
    }
}
