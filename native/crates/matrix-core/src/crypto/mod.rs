use matrix_sdk::{
    encryption::{backups::BackupState, VerificationState as SdkVerificationState},
    Client,
};

use crate::api::{MatrixKeyBackupState, MatrixVerificationState};

pub async fn restore_recovery(client: &Client, recovery_key: Option<&str>) -> String {
    let Some(recovery_key) = recovery_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return "no recovery key configured; verification restore skipped".to_string();
    };

    match client.encryption().recovery().recover(recovery_key).await {
        Ok(()) => "restored secret storage and cross-signing on the live device".to_string(),
        Err(err) => format!("recovery restore failed: {err}"),
    }
}

pub async fn ensure_backup(client: &Client) -> String {
    match client.encryption().backups().fetch_exists_on_server().await {
        Ok(true) => {
            if client.encryption().backups().are_enabled().await {
                "validated active key backup".to_string()
            } else {
                "backup exists on server but is not enabled locally".to_string()
            }
        }
        Ok(false) => match client.encryption().recovery().enable_backup().await {
            Ok(()) => "created and enabled a new key backup".to_string(),
            Err(err) => format!("key backup enable failed: {err}"),
        },
        Err(err) => format!("key backup validation failed: {err}"),
    }
}

pub async fn diagnostics(
    client: &Client,
    encryption_enabled: bool,
) -> (MatrixVerificationState, MatrixKeyBackupState) {
    if !encryption_enabled {
        return (
            MatrixVerificationState::Disabled,
            MatrixKeyBackupState::Disabled,
        );
    }

    let verification_state = match client.encryption().verification_state().get() {
        SdkVerificationState::Verified => MatrixVerificationState::Verified,
        SdkVerificationState::Unknown | SdkVerificationState::Unverified => {
            MatrixVerificationState::Pending
        }
    };

    let key_backup_state = match client.encryption().backups().state() {
        BackupState::Enabled => MatrixKeyBackupState::Enabled,
        BackupState::Unknown | BackupState::Disabling => MatrixKeyBackupState::Pending,
        BackupState::Creating
        | BackupState::Enabling
        | BackupState::Resuming
        | BackupState::Downloading => MatrixKeyBackupState::Pending,
    };

    (verification_state, key_backup_state)
}
