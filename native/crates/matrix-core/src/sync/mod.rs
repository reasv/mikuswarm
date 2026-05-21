use std::time::Duration;

use matrix_sdk::{
    config::SyncSettings,
    ruma::{
        api::client::{
            filter::{FilterDefinition, RoomEventFilter, RoomFilter},
            sync::sync_events,
        },
        UInt,
    },
};

pub fn build_settings(
    sync_token: Option<String>,
    timeline_limit: u32,
    timeout: Duration,
) -> SyncSettings {
    let mut room_filter = RoomFilter::default();
    let mut timeline_filter = RoomEventFilter::default();
    timeline_filter.limit = Some(UInt::from(timeline_limit));
    room_filter.timeline = timeline_filter;

    let mut filter = FilterDefinition::default();
    filter.room = room_filter;

    let settings = SyncSettings::new()
        .filter(sync_events::v3::Filter::FilterDefinition(filter))
        .timeout(timeout);
    match sync_token {
        Some(sync_token) => settings.token(sync_token),
        None => settings,
    }
}
