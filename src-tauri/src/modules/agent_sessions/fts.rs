// Persistent full-text index over agent-session conversations, port of
// multi-claude's SQLite index generalized to multiple providers. Metadata
// rows gate reindexing by mtime; an FTS5 table holds the extracted text.
// The whole index is a cache: corruption or schema drift is handled by
// deleting the file and reindexing on the next scan.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::modules::agent_sessions::types::SessionRef;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
    provider   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mtime      REAL NOT NULL,
    PRIMARY KEY (provider, session_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    provider UNINDEXED,
    session_id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
);
";

pub struct FtsIndex {
    conn: Mutex<Connection>,
}

impl FtsIndex {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// True when the session was never indexed or its file changed since.
    pub fn needs_reindex(&self, provider: &str, session_id: &str, mtime: f64) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        let stored: Option<f64> = conn
            .query_row(
                "SELECT mtime FROM sessions WHERE provider = ?1 AND session_id = ?2",
                (provider, session_id),
                |row| row.get(0),
            )
            .ok();
        stored != Some(mtime)
    }

    pub fn upsert(&self, provider: &str, session_id: &str, mtime: f64, content: &str) {
        let Ok(conn) = self.conn.lock() else { return };
        let _ = conn.execute(
            "INSERT OR REPLACE INTO sessions (provider, session_id, mtime) VALUES (?1, ?2, ?3)",
            (provider, session_id, mtime),
        );
        let _ = conn.execute(
            "DELETE FROM sessions_fts WHERE provider = ?1 AND session_id = ?2",
            (provider, session_id),
        );
        let _ = conn.execute(
            "INSERT INTO sessions_fts (provider, session_id, content) VALUES (?1, ?2, ?3)",
            (provider, session_id, content),
        );
    }

    pub fn delete(&self, provider: &str, session_id: &str) {
        let Ok(conn) = self.conn.lock() else { return };
        let _ = conn.execute(
            "DELETE FROM sessions WHERE provider = ?1 AND session_id = ?2",
            (provider, session_id),
        );
        let _ = conn.execute(
            "DELETE FROM sessions_fts WHERE provider = ?1 AND session_id = ?2",
            (provider, session_id),
        );
    }

    /// Sessions whose conversation matches `query`, best first (FTS5 rank).
    pub fn search(&self, query: &str, limit: usize) -> Vec<SessionRef> {
        let sanitised = sanitise_query(query);
        if sanitised.is_empty() {
            return Vec::new();
        }
        let Ok(conn) = self.conn.lock() else {
            return Vec::new();
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT provider, session_id FROM sessions_fts
             WHERE sessions_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map((sanitised, limit as i64), |row| {
            Ok(SessionRef {
                provider: row.get(0)?,
                session_id: row.get(1)?,
            })
        });
        match rows {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => Vec::new(),
        }
    }
}

/// Quote every whitespace token and AND-join so user input can't inject FTS5
/// query syntax (port of multi-claude's _sanitise_fts_query).
fn sanitise_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_search_and_delete_roundtrip() {
        let idx = FtsIndex::open_in_memory().unwrap();
        idx.upsert("claude", "s1", 1.0, "arreglar el parser de facturas");
        idx.upsert("codex", "s2", 1.0, "migrar la base de datos");

        let hits = idx.search("parser", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].provider, "claude");
        assert_eq!(hits[0].session_id, "s1");

        idx.delete("claude", "s1");
        assert!(idx.search("parser", 10).is_empty());
    }

    #[test]
    fn multi_term_queries_are_anded() {
        let idx = FtsIndex::open_in_memory().unwrap();
        idx.upsert("claude", "a", 1.0, "facturas con descuento");
        idx.upsert("claude", "b", 1.0, "facturas sin nada");
        let hits = idx.search("facturas descuento", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "a");
    }

    #[test]
    fn needs_reindex_tracks_mtime() {
        let idx = FtsIndex::open_in_memory().unwrap();
        assert!(idx.needs_reindex("claude", "s1", 5.0));
        idx.upsert("claude", "s1", 5.0, "contenido");
        assert!(!idx.needs_reindex("claude", "s1", 5.0));
        assert!(idx.needs_reindex("claude", "s1", 6.0));
    }

    #[test]
    fn upsert_replaces_previous_content() {
        let idx = FtsIndex::open_in_memory().unwrap();
        idx.upsert("claude", "s1", 1.0, "texto antiguo");
        idx.upsert("claude", "s1", 2.0, "texto nuevo");
        assert!(idx.search("antiguo", 10).is_empty());
        assert_eq!(idx.search("nuevo", 10).len(), 1);
    }

    #[test]
    fn malicious_query_syntax_is_neutralised() {
        let idx = FtsIndex::open_in_memory().unwrap();
        idx.upsert("claude", "s1", 1.0, "contenido normal");
        // FTS5 operators in user input must not panic or error out.
        assert!(idx.search("NEAR( OR \"", 10).is_empty());
        assert!(idx.search("", 10).is_empty());
    }

    #[test]
    fn diacritics_are_ignored_by_tokenizer() {
        let idx = FtsIndex::open_in_memory().unwrap();
        idx.upsert("claude", "s1", 1.0, "migración de módulos");
        assert_eq!(idx.search("migracion", 10).len(), 1);
    }
}
