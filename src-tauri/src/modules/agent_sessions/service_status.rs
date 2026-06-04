// Hosted-service health per provider, from their public status pages.
// Anthropic and OpenAI run statuspage.io, whose v2 API has a stable shape:
//   { "status": { "indicator": "none|minor|major|critical", "description": ".." } }
// Results are cached briefly; a fetch failure degrades to "unknown" so the
// panel never blocks on someone else's status page.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::modules::agent_sessions::types::ServiceStatus;

const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_TTL: Duration = Duration::from_secs(300);

/// Providers with a known statuspage endpoint. Gemini and OpenCode have no
/// comparable page (Google's status dashboard isn't per-product JSON; an
/// OpenCode session's health depends on whichever model backs it).
const ENDPOINTS: &[(&str, &str)] = &[
    ("claude", "https://status.anthropic.com/api/v2/status.json"),
    ("codex", "https://status.openai.com/api/v2/status.json"),
];

#[derive(Default)]
pub struct ServiceStatusCache {
    cached: Mutex<Option<(Instant, Vec<ServiceStatus>)>>,
}

impl ServiceStatusCache {
    /// Cached statuses, refreshed at most every CACHE_TTL. Blocking (called
    /// from the command's blocking pool).
    pub fn get(&self) -> Vec<ServiceStatus> {
        if let Ok(cache) = self.cached.lock() {
            if let Some((at, statuses)) = cache.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return statuses.clone();
                }
            }
        }
        let statuses: Vec<ServiceStatus> = ENDPOINTS
            .iter()
            .map(|(provider, url)| fetch_status(provider, url))
            .collect();
        if let Ok(mut cache) = self.cached.lock() {
            *cache = Some((Instant::now(), statuses.clone()));
        }
        statuses
    }
}

fn fetch_status(provider: &str, url: &str) -> ServiceStatus {
    let unknown = || ServiceStatus {
        provider: provider.to_string(),
        indicator: "unknown".to_string(),
        description: "status unavailable".to_string(),
    };
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
    else {
        return unknown();
    };
    let Ok(response) = client.get(url).send() else {
        return unknown();
    };
    let Ok(body) = response.text() else {
        return unknown();
    };
    parse_statuspage(provider, &body).unwrap_or_else(unknown)
}

/// Parse the statuspage.io v2 status payload.
pub fn parse_statuspage(provider: &str, body: &str) -> Option<ServiceStatus> {
    let data = serde_json::from_str::<Value>(body).ok()?;
    let status = data.get("status")?;
    Some(ServiceStatus {
        provider: provider.to_string(),
        indicator: status
            .get("indicator")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        description: status
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_statuspage_v2_shape() {
        let body = "{\"page\":{\"name\":\"Anthropic\"},\
                    \"status\":{\"indicator\":\"none\",\
                    \"description\":\"All Systems Operational\"}}";
        let status = parse_statuspage("claude", body).unwrap();
        assert_eq!(status.indicator, "none");
        assert_eq!(status.description, "All Systems Operational");
        assert_eq!(status.provider, "claude");
    }

    #[test]
    fn degraded_indicator_passes_through() {
        let body = "{\"status\":{\"indicator\":\"major\",\
                    \"description\":\"Partial outage\"}}";
        assert_eq!(parse_statuspage("codex", body).unwrap().indicator, "major");
    }

    #[test]
    fn garbage_yields_none() {
        assert!(parse_statuspage("claude", "not json").is_none());
        assert!(parse_statuspage("claude", "{}").is_none());
    }
}
