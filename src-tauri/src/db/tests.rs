//! Unit tests for the SQL safety tokenizer / quoting, and an integration test against a temporary
//! SQLite database (tables with FKs, describe, query, edits, export, import).
//! PostgreSQL / MySQL / SQL Server paths are compile-checked only (no servers in CI).

use super::engine::{Param, SqlBuf};
use super::ops::{self, Edit, Filter, Guard, Mapping, Sort};
use super::safety::*;
use super::*;
use serde_json::{json, Map, Value};

fn destructive(sql: &str, d: Dialect) -> Option<String> {
    classify(sql, d).destructive
}

#[test]
fn tokenizer_ignores_comments_and_strings() {
    let d = Dialect::Postgres;
    assert_eq!(destructive("SELECT 'DROP TABLE x' AS a", d), None);
    assert_eq!(destructive("SELECT 1 -- DROP TABLE users", d), None);
    assert_eq!(destructive("SELECT 1 /* DELETE FROM t */", d), None);
    assert_eq!(destructive("SELECT 1 /* nested /* DROP */ still comment */", d), None);
    assert_eq!(destructive("SELECT $$ DROP TABLE x $$", d), None);
    assert_eq!(destructive("SELECT $tag$ TRUNCATE t; $tag$", d), None);
    assert_eq!(destructive("SELECT \"drop\" FROM t", d), None);
    assert_eq!(destructive("SELECT E'it\\'s DROP' FROM t", d), None);
    assert_eq!(destructive("SELECT 'a' # DROP TABLE x", Dialect::MySql), None);
    assert_eq!(destructive("SELECT 'it\\'s DROP TABLE' FROM t", Dialect::MySql), None);
    assert_eq!(destructive("SELECT [drop] FROM t", Dialect::MsSql), None);
}

#[test]
fn detects_destructive_statements() {
    for d in [Dialect::Postgres, Dialect::MySql, Dialect::Sqlite, Dialect::MsSql] {
        assert_eq!(destructive("DROP TABLE users", d).as_deref(), Some("DROP TABLE"));
        assert_eq!(destructive("drop index if exists i", d).as_deref(), Some("DROP INDEX"));
        assert_eq!(destructive("TRUNCATE TABLE t", d).as_deref(), Some("TRUNCATE"));
        assert_eq!(destructive("ALTER TABLE t DROP COLUMN c", d).as_deref(), Some("ALTER … DROP COLUMN"));
        assert_eq!(destructive("DELETE FROM t", d).as_deref(), Some("DELETE without WHERE"));
        assert_eq!(destructive("UPDATE t SET a = 1", d).as_deref(), Some("UPDATE without WHERE"));
        assert_eq!(destructive("UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)", d).as_deref(), Some("UPDATE without WHERE"));
        assert_eq!(destructive("DELETE FROM t WHERE id = 1", d), None);
        assert_eq!(destructive("UPDATE t SET a = 1 WHERE id IN (SELECT id FROM u)", d), None);
        assert_eq!(destructive("SELECT * FROM t FOR UPDATE", d), None);
        assert_eq!(destructive("CREATE TABLE c (p INT REFERENCES p(id) ON DELETE CASCADE ON UPDATE CASCADE)", d), None);
        assert_eq!(destructive("ALTER TABLE t ADD COLUMN c int", d), None);
    }
    assert_eq!(destructive("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1", Dialect::MySql), None);
    assert_eq!(destructive("WITH x AS (SELECT 1) DELETE FROM t", Dialect::Postgres).as_deref(), Some("DELETE without WHERE"));
}

#[test]
fn classifies_read_and_write() {
    let d = Dialect::Postgres;
    assert_eq!(classify("SELECT 1", d).kind, Kind::Read);
    assert_eq!(classify("  with a as (select 1) select * from a", d).kind, Kind::Read);
    assert_eq!(classify("WITH a AS (DELETE FROM t WHERE x RETURNING *) SELECT * FROM a", d).kind, Kind::Write);
    assert_eq!(classify("SELECT * INTO new_t FROM t", d).kind, Kind::Write);
    assert_eq!(classify("EXPLAIN SELECT 1", d).kind, Kind::Read);
    assert_eq!(classify("EXPLAIN ANALYZE DELETE FROM t WHERE id = 1", d).kind, Kind::Write);
    assert_eq!(classify("SHOW search_path", d).kind, Kind::Read);
    assert_eq!(classify("INSERT INTO t VALUES (1)", d).kind, Kind::Write);
    assert_eq!(classify("BEGIN", d).kind, Kind::Control);
    assert_eq!(classify("PRAGMA table_info(t)", Dialect::Sqlite).kind, Kind::Read);
    assert_eq!(classify("PRAGMA foreign_keys = OFF", Dialect::Sqlite).kind, Kind::Write);
    assert_eq!(classify("-- comment only\nSELECT 2", d).kind, Kind::Read);
    assert!(all_read_only("SELECT 1; SELECT 2;", d));
    assert!(!all_read_only("SELECT 1; DELETE FROM t WHERE id=1", d));
}

#[test]
fn guard_rules() {
    let d = Dialect::Postgres;
    let s = |q: &str| split_statements(q, d);
    assert!(guard(&s("SELECT 1"), d, true, true, false).is_ok());
    assert!(guard(&s("INSERT INTO t VALUES (1)"), d, false, false, false).is_ok());
    let e = guard(&s("INSERT INTO t VALUES (1)"), d, true, false, false).unwrap_err();
    assert!(e.starts_with("CONFIRM_REQUIRED:production"), "{e}");
    let e = guard(&s("UPDATE t SET a=1 WHERE id=1"), d, false, true, false).unwrap_err();
    assert!(e.starts_with("CONFIRM_REQUIRED:read-only"), "{e}");
    let e = guard(&s("SELECT 1; DROP TABLE t"), d, false, false, false).unwrap_err();
    assert!(e.starts_with("CONFIRM_REQUIRED:destructive"), "{e}");
    assert!(guard(&s("DROP TABLE t"), d, true, true, true).is_ok());
}

#[test]
fn splits_statements() {
    let d = Dialect::Postgres;
    let v = split_statements("SELECT 1; SELECT ';'; -- x;\nSELECT 3", d);
    assert_eq!(v.len(), 3);
    assert_eq!(v[1].sql, "SELECT ';'");
    let v = split_statements("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT f();", d);
    assert_eq!(v.len(), 2);
    let v = split_statements(
        "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE c SET n = n + 1 WHERE id = 1; INSERT INTO log VALUES (1); END; SELECT 1;",
        Dialect::Sqlite,
    );
    assert_eq!(v.len(), 2, "{v:?}");
    let v = split_statements("DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nCALL p();", Dialect::MySql);
    assert_eq!(v.len(), 2, "{v:?}");
    assert!(v[0].sql.starts_with("CREATE PROCEDURE"));
    let v = split_statements("SELECT 1\nGO\nSELECT 2\ngo\n", Dialect::MsSql);
    assert_eq!(v.len(), 2);
    assert!(split_statements("  ;; -- nothing\n", d).is_empty());
}

#[test]
fn quoting() {
    assert_eq!(quote_ident(Dialect::Postgres, "a\"b"), "\"a\"\"b\"");
    assert_eq!(quote_ident(Dialect::Sqlite, "order"), "\"order\"");
    assert_eq!(quote_ident(Dialect::MySql, "a`b"), "`a``b`");
    assert_eq!(quote_ident(Dialect::MsSql, "a]b"), "[a]]b]");
    assert_eq!(qualified(Dialect::Postgres, "public", "users"), "\"public\".\"users\"");
    assert_eq!(qualified(Dialect::MySql, "", "t"), "`t`");
    assert_eq!(quote_literal(Dialect::Postgres, "it's"), "'it''s'");
    assert_eq!(quote_literal(Dialect::MySql, "a\\'b"), "'a\\\\''b'");
    assert_eq!(quote_literal(Dialect::MsSql, "x'"), "N'x'''");
    assert!(safe_type_name("character varying(255)"));
    assert!(safe_type_name("timestamp with time zone"));
    assert!(!safe_type_name("int); DROP TABLE x; --"));
    // A quoted identifier round-trips through the tokenizer.
    let toks = tokenize(&quote_ident(Dialect::Postgres, "we\"ird name"), Dialect::Postgres);
    assert_eq!(toks[0].tok, Tok::Ident("we\"ird name".into()));
}

#[test]
fn sql_builder_placeholders() {
    let mut b = SqlBuf::new(Dialect::Postgres);
    b.push("UPDATE t SET a = ").bind(Param::Int(5), Some("integer")).push(" WHERE id = ").bind(Param::Str("x'".into()), None);
    assert_eq!(b.sql, "UPDATE t SET a = CAST($1 AS integer) WHERE id = $2");
    assert_eq!(b.params, vec![Param::Str("5".into()), Param::Str("x'".into())]);
    assert_eq!(b.preview, "UPDATE t SET a = 5 WHERE id = 'x'''");
    let mut m = SqlBuf::new(Dialect::MsSql);
    m.push("SELECT ").bind(Param::Null, None).push(", ").bind(Param::Bool(true), None);
    assert_eq!(m.sql, "SELECT @P1, @P2");
    let mut s = SqlBuf::new(Dialect::Sqlite);
    s.push("x = ").bind(Param::Float(1.5), Some("REAL"));
    assert_eq!(s.sql, "x = ?");
}

#[test]
fn csv_parser() {
    let rows = ops::parse_csv("a,b,c\r\n1,\"x, y\",\"he said \"\"hi\"\"\"\n2,,\"multi\nline\"\n", ',');
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1], vec!["1", "x, y", "he said \"hi\""]);
    assert_eq!(rows[2], vec!["2", "", "multi\nline"]);
    assert_eq!(ops::parse_csv("\u{feff}x\ty\n", '\t'), vec![vec!["x", "y"]]);
}

fn map(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

#[test]
fn sqlite_end_to_end() {
    // Debug builds poll deep async stacks; run like a Tokio worker (2 MB) with some headroom.
    std::thread::Builder::new().stack_size(4 << 20).spawn(|| tokio::runtime::Runtime::new().unwrap().block_on(sqlite_end_to_end_inner())).unwrap().join().unwrap();
}

async fn sqlite_end_to_end_inner() {
    let dir = std::env::temp_dir().join(format!("cepheus-db-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("blog.db").to_string_lossy().to_string();
    let id = "test-sqlite".to_string();
    register_config(ConnConfig { id: id.clone(), name: "Test".into(), kind: "sqlite".into(), file: file.clone(), ..Default::default() });

    // DDL through the query runner (multi-statement, one session).
    let ddl = "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, CHECK (length(email) > 3));
               CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT, score REAL, data BLOB);
               CREATE INDEX posts_user_id ON posts(user_id);
               CREATE TABLE nopk (a TEXT);
               INSERT INTO users (email, name) VALUES ('ann@x.io', 'Ann'), ('bob@x.io', 'Bob');
               INSERT INTO posts (user_id, title, score, data) VALUES (1, 'Hello, \"world\"', 1.5, x'00ff'), (1, 'Second', NULL, NULL), (2, 'Bob''s', 3, NULL);";
    let r = query(QueryReq { id: id.clone(), database: None, sql: ddl.into(), limit: None, offset: None, query_id: None, confirmed: false }).await.unwrap();
    assert!(r.results.iter().all(|x| x.error.is_none()), "{:?}", r.results.iter().map(|x| &x.error).collect::<Vec<_>>());
    assert_eq!(r.results.len(), 6);
    assert_eq!(r.results[4].rows_affected, Some(2));

    // Multiple result sets + types.
    let r = query(QueryReq { id: id.clone(), database: None, sql: "SELECT id, title, score, data FROM posts ORDER BY id; SELECT count(*) AS n FROM users".into(), limit: None, offset: None, query_id: Some("q1".into()), confirmed: false })
        .await
        .unwrap();
    assert_eq!(r.results.len(), 2);
    assert_eq!(r.results[0].columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id", "title", "score", "data"]);
    assert_eq!(r.results[0].rows[0], vec![json!(1), json!("Hello, \"world\""), json!(1.5), json!("x'00ff'")]);
    assert_eq!(r.results[0].rows[1][2], Value::Null);
    assert_eq!(r.results[1].rows[0][0], json!(2));

    // Row limit + fetch more.
    let r = query(QueryReq { id: id.clone(), database: None, sql: "SELECT id FROM posts ORDER BY id".into(), limit: Some(2), offset: None, query_id: None, confirmed: false }).await.unwrap();
    assert!(r.results[0].has_more);
    assert_eq!(r.results[0].rows.len(), 2);
    let r = query(QueryReq { id: id.clone(), database: None, sql: "SELECT id FROM posts ORDER BY id".into(), limit: Some(2), offset: Some(2), query_id: None, confirmed: false }).await.unwrap();
    assert_eq!(r.results[0].rows, vec![vec![json!(3)]]);
    assert!(!r.results[0].has_more);

    // Errors keep earlier results.
    let r = query(QueryReq { id: id.clone(), database: None, sql: "SELECT 1; SELECT * FROM missing_table; SELECT 3".into(), limit: None, offset: None, query_id: None, confirmed: false }).await.unwrap();
    assert_eq!(r.results.len(), 2);
    assert!(r.results[1].error.as_deref().unwrap().contains("missing_table"));

    // Destructive guard.
    let e = query(QueryReq { id: id.clone(), database: None, sql: "DELETE FROM posts".into(), limit: None, offset: None, query_id: None, confirmed: false }).await.unwrap_err();
    assert!(e.starts_with("CONFIRM_REQUIRED:destructive"));

    // Catalog.
    let (db, _) = get_db(&id, None).await.unwrap();
    let schemas = meta::list_schemas(&db, "").await.unwrap();
    assert_eq!(schemas, vec!["main"]);
    let objs = meta::list_objects(&db, "main").await.unwrap();
    assert_eq!(objs.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), vec!["nopk", "posts", "users"]);
    let posts = meta::describe_table(&db, "main", "posts").await.unwrap();
    assert_eq!(posts.columns.len(), 6);
    assert!(posts.columns[0].pk && posts.columns[0].auto_increment);
    assert!(!posts.columns[1].nullable);
    assert_eq!(posts.foreign_keys.len(), 1);
    assert_eq!(posts.foreign_keys[0].to_table, "users");
    assert_eq!(posts.foreign_keys[0].from_columns, vec!["user_id"]);
    assert_eq!(posts.foreign_keys[0].to_columns, vec!["id"]);
    assert_eq!(posts.foreign_keys[0].on_delete, "CASCADE");
    assert!(posts.indexes.iter().any(|i| i.name == "posts_user_id" && i.columns == vec!["user_id"]));
    assert!(posts.ddl.as_deref().unwrap().contains("CREATE INDEX posts_user_id"));
    let users = meta::describe_table(&db, "main", "users").await.unwrap();
    assert_eq!(users.referenced_by.len(), 1);
    assert_eq!(users.referenced_by[0].from_table, "posts");
    assert_eq!(users.checks.len(), 1);
    assert!(users.checks[0].definition.contains("length(email)"));
    assert_eq!(users.columns[3].default.as_deref(), Some("CURRENT_TIMESTAMP"));
    let ov = meta::schema_overview(&db, "main").await.unwrap();
    assert_eq!(ov.tables.len(), 3);
    assert_eq!(ov.foreign_keys.len(), 1);
    assert!(meta::overview_text(&ov, Dialect::Sqlite).contains("posts(user_id) -> users(id) ON DELETE CASCADE"));

    // Table paging with filters/sort.
    let page = ops::table_rows(
        &db,
        "main",
        "posts",
        0,
        10,
        &[Sort { column: "id".into(), desc: true }],
        &[Filter { column: "title".into(), op: "contains".into(), value: json!("o") }],
        true,
    )
    .await
    .unwrap();
    assert_eq!(page.total, Some(3));
    assert_eq!(page.rows[0][0], json!(3));
    assert_eq!(page.primary_key, vec!["id"]);
    let page = ops::table_rows(&db, "main", "posts", 0, 10, &[], &[Filter { column: "score".into(), op: "is null".into(), value: Value::Null }], true).await.unwrap();
    assert_eq!(page.total, Some(1));
    assert!(ops::table_rows(&db, "main", "posts", 0, 10, &[Sort { column: "nope\"; DROP TABLE x".into(), desc: false }], &[], false).await.is_err());

    // Edits in a transaction (dry run first).
    let edits = vec![
        Edit { op: "update".into(), values: map(json!({"title": "Edited", "score": 9})), key: map(json!({"id": 2})) },
        Edit { op: "insert".into(), values: map(json!({"user_id": 2, "title": "New"})), key: Map::new() },
        Edit { op: "delete".into(), values: Map::new(), key: map(json!({"id": 3})) },
    ];
    let dry = ops::apply_edits(&db, "main", "posts", &edits, true).await.unwrap();
    assert_eq!(dry.statements[0], "UPDATE \"main\".\"posts\" SET \"score\" = 9, \"title\" = 'Edited' WHERE \"id\" = 2");
    let res = ops::apply_edits(&db, "main", "posts", &edits, false).await.unwrap();
    assert_eq!(res.affected, vec![1, 1, 1]);
    let (_, rows) = db.fetch("SELECT id, title, score FROM posts ORDER BY id", &[]).await.unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1], vec![json!(2), json!("Edited"), json!(9.0)]);
    assert_eq!(rows[2][1], json!("New"));
    // A failing statement rolls the whole batch back.
    let bad = vec![
        Edit { op: "update".into(), values: map(json!({"title": "Should roll back"})), key: map(json!({"id": 1})) },
        Edit { op: "insert".into(), values: map(json!({"user_id": 999, "title": "FK violation"})), key: Map::new() },
    ];
    assert!(ops::apply_edits(&db, "main", "posts", &bad, false).await.is_err());
    let (_, rows) = db.fetch("SELECT title FROM posts WHERE id = 1", &[]).await.unwrap();
    assert_eq!(rows[0][0], json!("Hello, \"world\""));
    // Tables without a primary key are refused.
    let e = ops::apply_edits(&db, "main", "nopk", &[Edit { op: "delete".into(), values: Map::new(), key: Map::new() }], true).await.unwrap_err();
    assert!(e.contains("no primary key"));

    // Export CSV / JSON / SQL.
    let csv = dir.join("posts.csv").to_string_lossy().to_string();
    let n = ops::export(&db, "SELECT id, title FROM posts ORDER BY id", "csv", &csv, "").await.unwrap();
    assert_eq!(n, 3);
    let text = std::fs::read_to_string(&csv).unwrap();
    assert_eq!(text.lines().next().unwrap(), "id,title");
    assert_eq!(text.lines().nth(1).unwrap(), "1,\"Hello, \"\"world\"\"\"");
    let js = dir.join("posts.json").to_string_lossy().to_string();
    ops::export(&db, "SELECT id, title FROM posts ORDER BY id", "json", &js, "").await.unwrap();
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&js).unwrap()).unwrap();
    assert_eq!(parsed[1]["title"], json!("Edited"));
    let sqlf = dir.join("posts.sql").to_string_lossy().to_string();
    ops::export(&db, "SELECT id, title FROM posts ORDER BY id", "sql", &sqlf, "\"posts_copy\"").await.unwrap();
    assert!(std::fs::read_to_string(&sqlf).unwrap().contains("INSERT INTO \"posts_copy\" (\"id\", \"title\") VALUES (2, 'Edited');"));
    assert!(ops::export(&db, "DELETE FROM posts WHERE id = 1", "csv", &csv, "").await.is_err());

    // CSV import with mapping, in one transaction.
    let src = dir.join("users.csv");
    std::fs::write(&src, "mail,full name\ncy@x.io,Cy\n\"dee@x.io\",\"Dee, Jr.\"\n").unwrap();
    let n = ops::import_csv(
        &db,
        "main",
        "users",
        &src.to_string_lossy(),
        &[Mapping { source: 0, column: "email".into() }, Mapping { source: 1, column: "name".into() }],
        true,
        ',',
        false,
    )
    .await
    .unwrap();
    assert_eq!(n, 2);
    let (_, rows) = db.fetch("SELECT name FROM users WHERE email = ?", &[Param::Str("dee@x.io".into())]).await.unwrap();
    assert_eq!(rows[0][0], json!("Dee, Jr."));

    // Agent tools.
    let out = agent::execute("db_schema", &json!({"connection": "Test"})).await.unwrap();
    assert!(out.contains("posts(*id INTEGER NOT NULL"), "{out}");
    let out = agent::execute("db_query", &json!({"connection": "Test", "sql": "SELECT email FROM users ORDER BY id LIMIT 1"})).await.unwrap();
    assert!(out.contains("ann@x.io"));
    assert!(agent::execute("db_query", &json!({"connection": "Test", "sql": "DELETE FROM users WHERE id = 1"})).await.is_err());
    let out = agent::execute("db_execute", &json!({"connection": "Test", "sql": "CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)"})).await.unwrap();
    assert!(out.contains("OK"), "{out}");
    assert!(agent::needs_approval("db_execute", &json!({"connection": "Test"}), "auto-edit"));
    assert!(!agent::needs_approval("db_execute", &json!({"connection": "Test"}), "turbo"));
    assert!(agent::needs_approval("db_query", &json!({}), "ask"));
    assert!(!agent::needs_approval("db_query", &json!({}), "auto-edit"));

    // Cancellation of a long-running SQLite query (sqlite3_interrupt).
    let slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";
    let qid = "slow-1".to_string();
    let h = tokio::spawn(query(QueryReq { id: id.clone(), database: None, sql: slow.into(), limit: None, offset: None, query_id: Some(qid.clone()), confirmed: false }));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(engine::cancel(&qid).await.unwrap());
    let r = tokio::time::timeout(std::time::Duration::from_secs(10), h).await.expect("cancel did not stop the query").unwrap().unwrap();
    assert!(r.cancelled || r.results.iter().any(|x| x.error.as_deref().map(|e| e.to_lowercase().contains("interrupt")).unwrap_or(false)), "{:?}", r.results);

    let _ = guard(&[], Dialect::Sqlite, false, false, false);
    let _ = Guard { production: false, read_only: false, confirmed: false };
    db_disconnect(id).await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
