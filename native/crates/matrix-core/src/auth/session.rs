use chrono::Utc;
use matrix_sdk::{
    authentication::matrix::MatrixSession,
    ruma::{OwnedDeviceId, OwnedUserId},
    store::RoomLoadSettings,
    Client,
};

use crate::{
    api::{MatrixAuthConfig, MatrixClientConfig, StoredSession},
    state, MatrixError, MatrixResult,
};

pub fn auth_mode(config: &MatrixClientConfig) -> &'static str {
    match config.auth {
        MatrixAuthConfig::Password { .. } => "password",
        MatrixAuthConfig::AccessToken { .. } => "accessToken",
    }
}

pub fn load_session(config: &MatrixClientConfig) -> MatrixResult<Option<StoredSession>> {
    let Some(mut existing) = state::read_json::<StoredSession>(&config.state_layout.session_file)?
    else {
        return Ok(None);
    };

    if existing.account_id != config.account_id {
        return Err(MatrixError::State(format!(
            "persisted session account {} does not match requested account {}",
            existing.account_id, config.account_id
        )));
    }

    if existing.user_id != config.user_id {
        return Err(MatrixError::State(format!(
            "persisted session user {} does not match requested user {}",
            existing.user_id, config.user_id
        )));
    }

    if existing.homeserver != config.homeserver {
        return Err(MatrixError::State(format!(
            "persisted session homeserver {} does not match requested homeserver {}",
            existing.homeserver, config.homeserver
        )));
    }

    existing.updated_at = Utc::now();
    state::write_json(&config.state_layout.session_file, &existing)?;
    Ok(Some(existing))
}

pub async fn restore_session(client: &Client, stored: &StoredSession) -> MatrixResult<()> {
    client
        .matrix_auth()
        .restore_session(stored.to_matrix_session()?, RoomLoadSettings::default())
        .await?;
    Ok(())
}

pub fn persist_client_session(
    config: &MatrixClientConfig,
    client: &Client,
    previous: Option<&StoredSession>,
    sync_token: Option<String>,
) -> MatrixResult<StoredSession> {
    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| MatrixError::State("matrix session is unavailable".to_string()))?;
    let stored = StoredSession::from_matrix_session(
        config,
        auth_mode(config),
        session,
        previous
            .map(|value| value.created_at)
            .unwrap_or_else(Utc::now),
        sync_token.or_else(|| previous.and_then(|value| value.sync_token.clone())),
    );
    state::write_json(&config.state_layout.session_file, &stored)?;
    Ok(stored)
}

impl StoredSession {
    pub fn to_matrix_session(&self) -> MatrixResult<MatrixSession> {
        let user_id: OwnedUserId = self.user_id.parse()?;
        let device_id: OwnedDeviceId = self.device_id.clone().into();

        Ok(MatrixSession {
            meta: matrix_sdk::SessionMeta { user_id, device_id },
            tokens: matrix_sdk::SessionTokens {
                access_token: self.access_token.clone(),
                refresh_token: self.refresh_token.clone(),
            },
        })
    }

    pub fn from_matrix_session(
        config: &MatrixClientConfig,
        auth_mode: &str,
        session: MatrixSession,
        created_at: chrono::DateTime<Utc>,
        sync_token: Option<String>,
    ) -> Self {
        Self {
            account_id: config.account_id.clone(),
            homeserver: config.homeserver.clone(),
            auth_mode: auth_mode.to_string(),
            user_id: session.meta.user_id.to_string(),
            device_id: session.meta.device_id.to_string(),
            access_token: session.tokens.access_token,
            refresh_token: session.tokens.refresh_token,
            sync_token,
            created_at,
            updated_at: Utc::now(),
        }
    }
}
