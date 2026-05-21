use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum MatrixAuthConfig {
    Password {
        password: String,
    },
    AccessToken {
        #[serde(rename = "accessToken")]
        access_token: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixStateLayout {
    pub root_dir: String,
    pub session_file: String,
    pub sdk_store_dir: String,
    pub crypto_store_dir: String,
    pub media_cache_dir: String,
    pub emoji_catalog_file: String,
    pub reactions_file: String,
    pub logs_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRoomOverride {
    pub thread_replies: Option<String>,
    pub require_mention: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixClientConfig {
    pub account_id: String,
    pub homeserver: String,
    pub user_id: String,
    pub auth: MatrixAuthConfig,
    pub recovery_key: Option<String>,
    pub device_name: Option<String>,
    pub initial_sync_limit: u32,
    pub encryption_enabled: bool,
    pub default_thread_replies: String,
    pub reply_to_mode: String,
    pub state_layout: MatrixStateLayout,
    pub room_overrides: std::collections::BTreeMap<String, MatrixRoomOverride>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixSyncState {
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixVerificationState {
    Disabled,
    Pending,
    Verified,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixKeyBackupState {
    Disabled,
    Pending,
    Enabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixChatType {
    Direct,
    Channel,
    Thread,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixMediaKind {
    Image,
    Video,
    Audio,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDiagnostics {
    pub account_id: String,
    pub user_id: String,
    pub device_id: String,
    pub verification_state: MatrixVerificationState,
    pub key_backup_state: MatrixKeyBackupState,
    pub sync_state: MatrixSyncState,
    pub last_successful_sync_at: Option<DateTime<Utc>>,
    pub last_successful_decryption_at: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeLifecycleStage {
    LoadSession,
    InitStores,
    RestoreOrLogin,
    PersistSession,
    InitCrypto,
    RestoreRecovery,
    EnableBackup,
    StartSync,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MatrixNativeEvent {
    Lifecycle {
        stage: NativeLifecycleStage,
        detail: String,
        at: DateTime<Utc>,
    },
    SyncState {
        state: MatrixSyncState,
        at: DateTime<Utc>,
    },
    Outbound {
        room_id: String,
        message_id: String,
        thread_id: Option<String>,
        reply_to_id: Option<String>,
        at: DateTime<Utc>,
    },
    Inbound {
        event: MatrixInboundEvent,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixInboundMedia {
    pub index: usize,
    pub kind: MatrixMediaKind,
    pub body: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixInboundMentions {
    pub user_ids: Option<Vec<String>>,
    pub room: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixInboundEvent {
    pub room_id: String,
    pub event_id: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub room_name: Option<String>,
    pub room_alias: Option<String>,
    pub chat_type: MatrixChatType,
    pub body: String,
    pub msgtype: Option<String>,
    pub formatted_body: Option<String>,
    pub mentions: Option<MatrixInboundMentions>,
    pub reply_to_id: Option<String>,
    pub thread_root_id: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub media: Vec<MatrixInboundMedia>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMessageRelatesTo {
    pub rel_type: Option<String>,
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMessageSummary {
    pub event_id: String,
    pub sender: String,
    pub body: String,
    pub msgtype: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub relates_to: Option<MatrixMessageRelatesTo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMessageSummaryRequest {
    pub room_id: String,
    pub event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSendRequest {
    pub room_id: String,
    pub text: String,
    pub reply_to_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSendResult {
    pub room_id: String,
    pub message_id: String,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixTypingRequest {
    pub room_id: String,
    pub typing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixResolveTargetRequest {
    pub target: String,
    pub create_dm: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixResolveTargetResult {
    pub input: String,
    pub resolved_room_id: String,
    pub canonical_target: String,
    pub is_direct: bool,
    pub room_alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixJoinRequest {
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixJoinResult {
    pub room_id: String,
    pub joined: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixReadMessagesRequest {
    pub room_id: String,
    pub limit: Option<usize>,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixReadMessagesResult {
    pub messages: Vec<MatrixMessageSummary>,
    pub next_batch: Option<String>,
    pub prev_batch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixEditMessageRequest {
    pub room_id: String,
    pub message_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixEditMessageResult {
    pub room_id: String,
    pub message_id: String,
    pub event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDeleteMessageRequest {
    pub room_id: String,
    pub message_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDeleteMessageResult {
    pub room_id: String,
    pub message_id: String,
    pub event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMemberInfoRequest {
    pub room_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMemberInfo {
    pub room_id: String,
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub membership: Option<String>,
    pub is_self: bool,
    pub is_direct: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixChannelInfoRequest {
    pub room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixChannelInfo {
    pub room_id: String,
    pub display_name: Option<String>,
    pub canonical_alias: Option<String>,
    pub alt_aliases: Vec<String>,
    pub joined: bool,
    pub is_direct: bool,
    pub member_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixUploadMediaThumbnail {
    pub data_base64: String,
    pub content_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixUploadMediaRequest {
    pub room_id: String,
    pub filename: String,
    pub content_type: String,
    pub data_base64: String,
    pub thumbnail: Option<MatrixUploadMediaThumbnail>,
    pub caption: Option<String>,
    pub reply_to_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixUploadMediaResult {
    pub room_id: String,
    pub message_id: String,
    pub filename: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDownloadMediaRequest {
    pub room_id: String,
    pub event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDownloadMediaResult {
    pub room_id: String,
    pub event_id: String,
    pub kind: MatrixMediaKind,
    pub body: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data_base64: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatrixLinkPreviewSourceKind {
    Synapse,
    FxTwitter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatrixLinkPreviewSource {
    pub url: String,
    pub source_kind: MatrixLinkPreviewSourceKind,
    pub site_name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatrixLinkPreviewMedia {
    pub source_url: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatrixLinkPreviewResult {
    pub text_blocks: Vec<String>,
    pub media: Vec<MatrixLinkPreviewMedia>,
    pub sources: Vec<MatrixLinkPreviewSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixResolveLinkPreviewsRequest {
    pub body_text: String,
    pub max_bytes: Option<usize>,
    pub include_images: Option<bool>,
    pub x_preview_via_fx_twitter: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixReactionKeyKind {
    Unicode,
    Custom,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatrixReactionInfo {
    pub raw: String,
    pub normalized: String,
    pub display: String,
    pub kind: MatrixReactionKeyKind,
    pub shortcode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixReactionSummary {
    pub key: String,
    pub normalized_key: String,
    pub display: String,
    pub kind: MatrixReactionKeyKind,
    pub shortcode: Option<String>,
    pub count: u64,
    pub users: Vec<String>,
    pub raw_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixReactRequest {
    pub room_id: String,
    pub message_id: String,
    pub key: String,
    pub remove: Option<bool>,
    pub sender_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixReactResult {
    pub removed: u64,
    pub reaction: Option<MatrixReactionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixListReactionsRequest {
    pub room_id: String,
    pub message_id: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixPinMessageRequest {
    pub room_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixListPinsRequest {
    pub room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixPinsResult {
    pub room_id: String,
    pub pinned: Vec<String>,
    pub events: Vec<MatrixMessageSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCustomEmojiRef {
    pub shortcode: String,
    pub mxc_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCustomEmojiRoomStats {
    pub message_count: u64,
    pub last_message_ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCustomEmojiCatalogEntry {
    pub shortcode: String,
    pub mxc_url: String,
    pub first_seen_ts: i64,
    pub last_seen_ts: i64,
    pub global_message_count: u64,
    pub global_last_message_ts: i64,
    pub rooms: std::collections::BTreeMap<String, MatrixCustomEmojiRoomStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCustomEmojiUsageRequest {
    pub emoji: Vec<MatrixCustomEmojiRef>,
    pub room_id: Option<String>,
    pub observed_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixListEmojiRequest {
    pub room_id: Option<String>,
    pub limit: Option<usize>,
    pub now_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub account_id: String,
    pub homeserver: String,
    pub auth_mode: String,
    pub user_id: String,
    pub device_id: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub sync_token: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
