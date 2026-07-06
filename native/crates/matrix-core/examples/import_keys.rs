//! One-shot: import an Element/Cinny-format Megolm key export into the bot's
//! existing matrix-sdk crypto store, acting as the bot's own device (its session
//! is restored, so no new device is created).
//!
//! Run with the agent CONTAINER STOPPED (single writer to the sqlite store):
//!   cargo run --release --example import_keys -- \
//!     <sdk_store_dir> <session.json> <keys.txt> <passphrase>
//!
//! e.g. from the repo root:
//!   cargo run --release --manifest-path native/crates/matrix-core/Cargo.toml \
//!     --example import_keys -- \
//!     var/matrix/miku/sdk-store var/matrix/miku/session.json cinny-keys.txt '<pass>'
//!
//! Imports ALL sessions in the export (including any DM keys, which are inert on a
//! bot that isn't a member of those rooms). On the bot's next start, `auto_enable_backups`
//! uploads the newly-imported sessions to the server-side key backup.

use std::path::PathBuf;

use matrix_sdk::{
    authentication::matrix::MatrixSession, store::RoomLoadSettings, Client, SessionMeta,
    SessionTokens,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let store_dir = args.next().expect("arg1: sdk_store_dir");
    let session_file = args.next().expect("arg2: session.json path");
    let keys_file = args.next().expect("arg3: keys export .txt path");
    let passphrase = args.next().expect("arg4: export passphrase");

    let session_json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&session_file)?)?;
    let homeserver = session_json["homeserver"].as_str().expect("session.homeserver");
    let user_id = session_json["userId"].as_str().expect("session.userId");
    let device_id = session_json["deviceId"].as_str().expect("session.deviceId");
    let access_token =
        session_json["accessToken"].as_str().expect("session.accessToken").to_owned();
    let refresh_token = session_json["refreshToken"].as_str().map(str::to_owned);

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        println!("opening crypto store at {store_dir} as {user_id} / device {device_id}");
        let client = Client::builder()
            .homeserver_url(homeserver)
            .sqlite_store(&store_dir, None)
            .build()
            .await?;

        let session = MatrixSession {
            meta: SessionMeta { user_id: user_id.parse()?, device_id: device_id.to_owned().into() },
            tokens: SessionTokens { access_token, refresh_token },
        };
        client.matrix_auth().restore_session(session, RoomLoadSettings::default()).await?;

        println!("importing room keys from {keys_file} (this may take a moment) ...");
        let res =
            client.encryption().import_room_keys(PathBuf::from(&keys_file), &passphrase).await?;
        println!(
            "imported {} of {} keys across {} rooms",
            res.imported_count,
            res.total_count,
            res.keys.len()
        );
        Ok::<_, Box<dyn std::error::Error>>(())
    })
}
