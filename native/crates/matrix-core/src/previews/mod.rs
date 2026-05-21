use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use regex::Regex;
use reqwest::{redirect::Policy, Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    api::{
        MatrixClientConfig, MatrixLinkPreviewMedia, MatrixLinkPreviewResult,
        MatrixLinkPreviewSource, MatrixLinkPreviewSourceKind, MatrixResolveLinkPreviewsRequest,
    },
    MatrixError, MatrixResult,
};

const MAX_PREVIEW_URLS: usize = 3;
const FETCH_TIMEOUT_MS: u64 = 4_000;
const SYNAPSE_PREVIEW_PATHS: [&str; 2] = [
    "/_matrix/media/v3/preview_url",
    "/_matrix/media/r0/preview_url",
];
const MEDIA_DOWNLOAD_PATHS: [&str; 2] =
    ["/_matrix/media/v3/download", "/_matrix/media/r0/download"];
const FXTWITTER_API_BASE: &str = "https://api.fxtwitter.com";
const PREVIEW_USER_AGENT: &str = "OpenClaw-Matrix-Preview/1.0";
const X_STATUS_HOSTS: &[&str] = &[
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
    "fxtwitter.com",
    "www.fxtwitter.com",
    "fixupx.com",
    "www.fixupx.com",
    "vxtwitter.com",
    "www.vxtwitter.com",
    "fixvx.com",
    "www.fixvx.com",
    "twittpr.com",
    "www.twittpr.com",
];

#[derive(Debug, Deserialize)]
struct FxTwitterAuthor {
    name: Option<String>,
    screen_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FxTwitterPhoto {
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FxTwitterVideo {
    thumbnail_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FxTwitterPollChoice {
    label: Option<String>,
    count: Option<u64>,
    percentage: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct FxTwitterPoll {
    total_votes: Option<u64>,
    time_left_en: Option<String>,
    ends_at: Option<String>,
    choices: Option<Vec<FxTwitterPollChoice>>,
}

#[derive(Debug, Deserialize)]
struct FxTwitterMedia {
    photos: Option<Vec<FxTwitterPhoto>>,
    videos: Option<Vec<FxTwitterVideo>>,
}

#[derive(Debug, Deserialize)]
struct FxTwitterTweet {
    text: Option<String>,
    author: Option<FxTwitterAuthor>,
    replies: Option<u64>,
    retweets: Option<u64>,
    likes: Option<u64>,
    views: Option<u64>,
    replying_to: Option<String>,
    quote: Option<Box<FxTwitterTweet>>,
    poll: Option<FxTwitterPoll>,
    media: Option<FxTwitterMedia>,
}

#[derive(Debug, Deserialize)]
struct FxTwitterStatusResponse {
    code: Option<u64>,
    tweet: Option<FxTwitterTweet>,
}

pub async fn resolve_link_previews(
    config: &MatrixClientConfig,
    access_token: &str,
    request: &MatrixResolveLinkPreviewsRequest,
) -> MatrixResult<MatrixLinkPreviewResult> {
    let client = build_http_client()?;
    let urls = extract_urls(&request.body_text);
    if urls.is_empty() {
        return Ok(MatrixLinkPreviewResult {
            text_blocks: Vec::new(),
            media: Vec::new(),
            sources: Vec::new(),
        });
    }

    let include_images = request.include_images.unwrap_or(true);
    let max_bytes = request.max_bytes.unwrap_or(20 * 1024 * 1024);
    let use_fx_twitter = request.x_preview_via_fx_twitter.unwrap_or(false);
    let mut text_blocks = Vec::new();
    let mut media = Vec::new();
    let mut sources = Vec::new();

    for raw_url in urls {
        let Some(parsed_url) = sanitize_url(&raw_url) else {
            continue;
        };

        if use_fx_twitter {
            if let Some(tweet) = fetch_fxtwitter_status(&client, &parsed_url).await? {
                if let Some(text) = format_fxtwitter_tweet(&tweet, "Tweet") {
                    text_blocks.push(text);
                }
                sources.push(MatrixLinkPreviewSource {
                    url: parsed_url.to_string(),
                    source_kind: MatrixLinkPreviewSourceKind::FxTwitter,
                    site_name: Some("FxTwitter".to_string()),
                    title: tweet
                        .author
                        .as_ref()
                        .and_then(|author| author.screen_name.as_ref())
                        .map(|handle| format!("@{handle}")),
                    description: tweet.text.clone(),
                });
                if include_images {
                    media.extend(resolve_fxtwitter_media(&client, &tweet, max_bytes).await?);
                }
                continue;
            }
        }

        let Some(preview) =
            fetch_synapse_preview(&client, config, access_token, &parsed_url).await?
        else {
            continue;
        };
        let text = build_synapse_preview_text(&parsed_url, &preview);
        if let Some(text) = text {
            text_blocks.push(text);
        }
        sources.push(MatrixLinkPreviewSource {
            url: parsed_url.to_string(),
            source_kind: MatrixLinkPreviewSourceKind::Synapse,
            site_name: preview_string(&preview, "og:site_name")
                .or_else(|| Some(parsed_url.host_str().unwrap_or_default().to_string())),
            title: preview_string(&preview, "og:title"),
            description: preview_string(&preview, "og:description"),
        });
        if include_images {
            media.extend(
                resolve_synapse_preview_media(&client, config, access_token, &preview, max_bytes)
                    .await?,
            );
        }
    }

    Ok(MatrixLinkPreviewResult {
        text_blocks,
        media,
        sources,
    })
}

fn build_http_client() -> MatrixResult<Client> {
    Ok(Client::builder()
        .redirect(Policy::limited(5))
        .timeout(Duration::from_millis(FETCH_TIMEOUT_MS))
        .user_agent(PREVIEW_USER_AGENT)
        .build()
        .map_err(|err| MatrixError::State(format!("failed to build preview http client: {err}")))?)
}

fn extract_urls(text: &str) -> Vec<String> {
    let regex = Regex::new(r"\bhttps?://[^\s<>()]+").expect("valid preview url regex");
    let mut seen = std::collections::BTreeSet::new();
    let mut urls = Vec::new();
    for matched in regex.find_iter(text) {
        let cleaned = matched
            .as_str()
            .trim_end_matches([',', ')', '.', ';', '!', '?']);
        if cleaned.is_empty() || !seen.insert(cleaned.to_string()) {
            continue;
        }
        urls.push(cleaned.to_string());
        if urls.len() >= MAX_PREVIEW_URLS {
            break;
        }
    }
    urls
}

fn sanitize_url(raw: &str) -> Option<Url> {
    let parsed = Url::parse(raw).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(parsed),
        _ => None,
    }
}

fn preview_string(preview: &Value, key: &str) -> Option<String> {
    preview
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn build_synapse_preview_text(url: &Url, preview: &Value) -> Option<String> {
    let title = preview_string(preview, "og:title");
    let description = preview_string(preview, "og:description");
    let site_name = preview_string(preview, "og:site_name")
        .or_else(|| url.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string());
    let pieces = [title, description]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if pieces.is_empty() {
        return None;
    }
    Some(format!(
        "[Link preview: {site_name}]\n{}",
        pieces.join("\n")
    ))
}

async fn fetch_synapse_preview(
    client: &Client,
    config: &MatrixClientConfig,
    access_token: &str,
    url: &Url,
) -> MatrixResult<Option<Value>> {
    for path in SYNAPSE_PREVIEW_PATHS {
        let mut endpoint = Url::parse(&format!(
            "{}{path}",
            config.homeserver.trim_end_matches('/')
        ))
        .map_err(|err| MatrixError::State(format!("invalid preview endpoint: {err}")))?;
        endpoint.query_pairs_mut().append_pair("url", url.as_str());
        let response = client
            .get(endpoint)
            .bearer_auth(access_token)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            continue;
        }
        if !response.status().is_success() {
            return Ok(None);
        }
        return Ok(Some(response.json::<Value>().await?));
    }
    Ok(None)
}

fn parse_x_status_url(url: &Url) -> Option<(Option<String>, String)> {
    let host = url.host_str()?.to_ascii_lowercase();
    if !X_STATUS_HOSTS.contains(&host.as_str()) {
        return None;
    }
    let parts = url
        .path_segments()
        .map(|segments| {
            segments
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let status_index = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case("status"))?;
    let status_id = parts.get(status_index + 1)?;
    if status_id.is_empty() || !status_id.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let screen_name = if status_index > 0 {
        let candidate = parts[status_index - 1];
        if candidate.eq_ignore_ascii_case("i") || candidate.eq_ignore_ascii_case("status") {
            None
        } else {
            Some(candidate.to_string())
        }
    } else {
        None
    };
    Some((screen_name, (*status_id).to_string()))
}

async fn fetch_fxtwitter_status(
    client: &Client,
    raw_url: &Url,
) -> MatrixResult<Option<FxTwitterTweet>> {
    let Some((screen_name, status_id)) = parse_x_status_url(raw_url) else {
        return Ok(None);
    };
    let path = match screen_name {
        Some(screen_name) => format!("{screen_name}/status/{status_id}"),
        None => format!("status/{status_id}"),
    };
    let api_base = std::env::var("OPENCLAW_MATRIX_FXTWITTER_API_BASE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| FXTWITTER_API_BASE.to_string());
    let response = client
        .get(format!("{}/{}", api_base.trim_end_matches('/'), path))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let payload = response.json::<FxTwitterStatusResponse>().await?;
    if payload.code != Some(200) {
        return Ok(None);
    }
    Ok(payload.tweet)
}

fn summarize_count(value: Option<u64>, label: &str) -> Option<String> {
    value.map(|value| format!("{value} {label}"))
}

fn format_fxtwitter_tweet(tweet: &FxTwitterTweet, heading: &str) -> Option<String> {
    let text = tweet
        .text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let author_name = tweet
        .author
        .as_ref()
        .and_then(|author| author.name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let author_handle = tweet
        .author
        .as_ref()
        .and_then(|author| author.screen_name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if text.is_none() && author_name.is_none() && author_handle.is_none() {
        return None;
    }
    let author_label = match (author_name, author_handle) {
        (Some(name), Some(handle)) => format!("{name} (@{handle})"),
        (Some(name), None) => name.to_string(),
        (None, Some(handle)) => format!("@{handle}"),
        (None, None) => "Unknown".to_string(),
    };
    let mut lines = vec![format!("[{heading}: {author_label}]")];
    if let Some(text) = text {
        lines.push(text.to_string());
    }
    if let Some(replying_to) = tweet
        .replying_to
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("[Replying to @{replying_to}]"));
    }
    if let Some(poll) = &tweet.poll {
        if let Some(choices) = &poll.choices {
            if !choices.is_empty() {
                let summary = match (
                    poll.total_votes,
                    poll.time_left_en.as_deref(),
                    poll.ends_at.as_deref(),
                ) {
                    (Some(total_votes), Some(time_left), _) => {
                        format!("[Poll: {total_votes} votes, {time_left}]")
                    }
                    (Some(total_votes), None, Some(ends_at)) => {
                        format!("[Poll: {total_votes} votes, ends {ends_at}]")
                    }
                    (Some(total_votes), None, None) => format!("[Poll: {total_votes} votes]"),
                    (None, Some(time_left), _) => format!("[Poll: {time_left}]"),
                    (None, None, Some(ends_at)) => format!("[Poll: ends {ends_at}]"),
                    (None, None, None) => "[Poll]".to_string(),
                };
                lines.push(summary);
                for choice in choices {
                    let mut pieces = Vec::new();
                    if let Some(label) = choice
                        .label
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        pieces.push(label.to_string());
                    }
                    if let Some(count) = choice.count {
                        pieces.push(format!("{count} votes"));
                    }
                    if let Some(percentage) = choice.percentage {
                        pieces.push(format!("{percentage}%"));
                    }
                    if !pieces.is_empty() {
                        lines.push(pieces.join(" - "));
                    }
                }
            }
        }
    }
    let photos = tweet
        .media
        .as_ref()
        .and_then(|media| media.photos.as_ref())
        .map(Vec::len)
        .unwrap_or(0);
    let videos = tweet
        .media
        .as_ref()
        .and_then(|media| media.videos.as_ref())
        .map(Vec::len)
        .unwrap_or(0);
    if photos > 0 || videos > 0 {
        lines.push(format!(
            "[Tweet media: {photos} photo(s), {videos} video(s)]"
        ));
    }
    let counts = [
        summarize_count(tweet.likes, "likes"),
        summarize_count(tweet.retweets, "retweets"),
        summarize_count(tweet.replies, "replies"),
        summarize_count(tweet.views, "views"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if !counts.is_empty() {
        lines.push(format!("[Stats: {}]", counts.join(", ")));
    }
    if let Some(quote) = &tweet.quote {
        if let Some(quoted) = format_fxtwitter_tweet(quote, "Quoted tweet") {
            lines.push(quoted);
        }
    }
    Some(lines.join("\n"))
}

async fn resolve_synapse_preview_media(
    client: &Client,
    config: &MatrixClientConfig,
    access_token: &str,
    preview: &Value,
    max_bytes: usize,
) -> MatrixResult<Vec<MatrixLinkPreviewMedia>> {
    let Some(raw_image) = preview_string(preview, "og:image") else {
        return Ok(Vec::new());
    };
    let content_type = preview_string(preview, "og:image:type");
    if raw_image.starts_with("mxc://") {
        if let Some(media) = download_mxc_media(
            client,
            config,
            access_token,
            &raw_image,
            max_bytes,
            content_type,
        )
        .await?
        {
            return Ok(vec![media]);
        }
        return Ok(Vec::new());
    }
    if let Some(media) = download_external_image(client, &raw_image, max_bytes).await? {
        return Ok(vec![media]);
    }
    Ok(Vec::new())
}

async fn resolve_fxtwitter_media(
    client: &Client,
    tweet: &FxTwitterTweet,
    max_bytes: usize,
) -> MatrixResult<Vec<MatrixLinkPreviewMedia>> {
    let mut output = Vec::new();
    let photo_urls = tweet
        .media
        .as_ref()
        .and_then(|media| media.photos.as_ref())
        .into_iter()
        .flatten()
        .filter_map(|photo| photo.url.as_ref())
        .cloned()
        .collect::<Vec<_>>();
    let video_urls = tweet
        .media
        .as_ref()
        .and_then(|media| media.videos.as_ref())
        .into_iter()
        .flatten()
        .filter_map(|video| video.thumbnail_url.as_ref())
        .cloned()
        .collect::<Vec<_>>();
    for url in photo_urls.into_iter().chain(video_urls.into_iter()) {
        if let Some(media) = download_external_image(client, &url, max_bytes).await? {
            output.push(media);
        }
    }
    Ok(output)
}

async fn download_external_image(
    client: &Client,
    url: &str,
    max_bytes: usize,
) -> MatrixResult<Option<MatrixLinkPreviewMedia>> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/*")
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if !content_type
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .starts_with("image/")
    {
        return Ok(None);
    }
    let bytes = response.bytes().await?;
    if bytes.len() > max_bytes {
        return Ok(None);
    }
    Ok(Some(MatrixLinkPreviewMedia {
        source_url: url.to_string(),
        filename: infer_filename(url),
        content_type,
        data_base64: STANDARD.encode(bytes),
    }))
}

async fn download_mxc_media(
    client: &Client,
    config: &MatrixClientConfig,
    access_token: &str,
    mxc_url: &str,
    max_bytes: usize,
    content_type: Option<String>,
) -> MatrixResult<Option<MatrixLinkPreviewMedia>> {
    let Some((server_name, media_id)) = parse_mxc_url(mxc_url) else {
        return Ok(None);
    };
    for path in MEDIA_DOWNLOAD_PATHS {
        let endpoint = format!(
            "{}{path}/{server_name}/{media_id}",
            config.homeserver.trim_end_matches('/'),
        );
        let response = client
            .get(&endpoint)
            .bearer_auth(access_token)
            .send()
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            continue;
        }
        if !response.status().is_success() {
            return Ok(None);
        }
        let resolved_content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .or(content_type.clone());
        let bytes = response.bytes().await?;
        if bytes.len() > max_bytes {
            return Ok(None);
        }
        return Ok(Some(MatrixLinkPreviewMedia {
            source_url: mxc_url.to_string(),
            filename: Some(media_id),
            content_type: resolved_content_type,
            data_base64: STANDARD.encode(bytes),
        }));
    }
    Ok(None)
}

fn parse_mxc_url(raw: &str) -> Option<(String, String)> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "mxc" {
        return None;
    }
    let server_name = url.host_str()?.to_string();
    let media_id = url
        .path_segments()
        .and_then(|mut segments| segments.next().map(str::to_string))?;
    Some((server_name, media_id))
}

fn infer_filename(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    parsed
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use wiremock::{
        matchers::{header, method, path, query_param},
        Mock, MockServer, ResponseTemplate,
    };

    use super::*;
    use crate::api::{MatrixAuthConfig, MatrixClientConfig, MatrixStateLayout};

    fn sample_config(homeserver: &str) -> MatrixClientConfig {
        MatrixClientConfig {
            account_id: "default".to_string(),
            homeserver: homeserver.to_string(),
            user_id: "@bot:example.org".to_string(),
            auth: MatrixAuthConfig::Password {
                password: "secret".to_string(),
            },
            recovery_key: None,
            device_name: None,
            initial_sync_limit: 50,
            encryption_enabled: true,
            default_thread_replies: "inbound".to_string(),
            reply_to_mode: "off".to_string(),
            state_layout: MatrixStateLayout {
                root_dir: "/tmp".to_string(),
                session_file: "/tmp/session.json".to_string(),
                sdk_store_dir: "/tmp/sdk".to_string(),
                crypto_store_dir: "/tmp/crypto".to_string(),
                media_cache_dir: "/tmp/media".to_string(),
                emoji_catalog_file: "/tmp/emoji.json".to_string(),
                reactions_file: "/tmp/reactions.json".to_string(),
                logs_dir: "/tmp/logs".to_string(),
            },
            room_overrides: Default::default(),
        }
    }

    #[test]
    fn extracts_x_status_urls_from_known_hosts() {
        let parsed = Url::parse("https://fixupx.com/alice/status/1234567890").unwrap();
        let resolved = parse_x_status_url(&parsed).unwrap();
        assert_eq!(resolved.0.as_deref(), Some("alice"));
        assert_eq!(resolved.1, "1234567890");
    }

    #[test]
    fn formats_fxtwitter_tweets() {
        let tweet = FxTwitterTweet {
            text: Some("hello from x".to_string()),
            author: Some(FxTwitterAuthor {
                name: Some("Alice".to_string()),
                screen_name: Some("alice".to_string()),
            }),
            replies: Some(1),
            retweets: Some(3),
            likes: Some(12),
            views: Some(99),
            replying_to: None,
            quote: None,
            poll: None,
            media: Some(FxTwitterMedia {
                photos: Some(vec![FxTwitterPhoto {
                    url: Some("https://cdn.example/photo.jpg".to_string()),
                }]),
                videos: None,
            }),
        };
        assert_eq!(
            format_fxtwitter_tweet(&tweet, "Tweet").as_deref(),
            Some(
                "[Tweet: Alice (@alice)]\nhello from x\n[Tweet media: 1 photo(s), 0 video(s)]\n[Stats: 12 likes, 3 retweets, 1 replies, 99 views]"
            )
        );
    }

    #[tokio::test]
    async fn resolves_synapse_preview_blocks_and_media() {
        let server = MockServer::start().await;
        let config = sample_config(&server.uri());
        Mock::given(method("GET"))
            .and(path("/_matrix/media/v3/preview_url"))
            .and(query_param("url", "https://example.com/post"))
            .and(header("authorization", "Bearer matrix-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "og:title": "Example title",
                "og:description": "Example description",
                "og:site_name": "Example Site",
                "og:image": "mxc://matrix.example.org/preview",
                "og:image:type": "image/png"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/_matrix/media/v3/download/matrix.example.org/preview",
            ))
            .and(header("authorization", "Bearer matrix-token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/png")
                    .set_body_bytes(vec![1u8, 2, 3]),
            )
            .mount(&server)
            .await;

        let result = resolve_link_previews(
            &config,
            "matrix-token",
            &MatrixResolveLinkPreviewsRequest {
                body_text: "check https://example.com/post".to_string(),
                max_bytes: Some(1024),
                include_images: Some(true),
                x_preview_via_fx_twitter: Some(false),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            result.text_blocks,
            vec!["[Link preview: Example Site]\nExample title\nExample description".to_string()]
        );
        assert_eq!(result.sources.len(), 1);
        assert_eq!(
            result.sources[0].source_kind,
            MatrixLinkPreviewSourceKind::Synapse
        );
        assert_eq!(result.media.len(), 1);
        assert_eq!(result.media[0].content_type.as_deref(), Some("image/png"));
        assert_eq!(
            STANDARD.decode(&result.media[0].data_base64).unwrap(),
            vec![1u8, 2, 3]
        );
    }

    #[tokio::test]
    async fn fetches_fxtwitter_previews_end_to_end() {
        let server = MockServer::start().await;
        std::env::set_var("OPENCLAW_MATRIX_FXTWITTER_API_BASE", server.uri());
        Mock::given(method("GET"))
            .and(path("/alice/status/1234567890"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": 200,
                "tweet": {
                    "text": "hello from x",
                    "author": { "name": "Alice", "screen_name": "alice" },
                    "likes": 12,
                    "retweets": 3,
                    "replies": 1,
                    "views": 99
                }
            })))
            .mount(&server)
            .await;

        let config = sample_config("https://matrix.example.org");
        let result = resolve_link_previews(
            &config,
            "matrix-token",
            &MatrixResolveLinkPreviewsRequest {
                body_text: "check https://fixupx.com/alice/status/1234567890".to_string(),
                max_bytes: Some(1024),
                include_images: Some(false),
                x_preview_via_fx_twitter: Some(true),
            },
        )
        .await;
        std::env::remove_var("OPENCLAW_MATRIX_FXTWITTER_API_BASE");

        let result = result.unwrap();
        assert_eq!(
            result.text_blocks,
            vec![
                "[Tweet: Alice (@alice)]\nhello from x\n[Stats: 12 likes, 3 retweets, 1 replies, 99 views]"
                    .to_string()
            ]
        );
        assert_eq!(result.sources.len(), 1);
        assert_eq!(
            result.sources[0].source_kind,
            MatrixLinkPreviewSourceKind::FxTwitter
        );
    }
}
