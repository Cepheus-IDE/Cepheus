//! SQL text utilities that must never be fooled by comments or string literals:
//! a small tokenizer, a statement splitter (`;`, MySQL `DELIMITER`, T-SQL `GO`, trigger/procedure
//! bodies), statement classification for the read-only / production guard, destructive-statement
//! detection, and identifier / literal quoting per dialect.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    MySql,
    Sqlite,
    MsSql,
}

impl Dialect {
    pub fn from_kind(kind: &str) -> Dialect {
        match kind {
            "postgres" | "postgresql" | "cockroach" => Dialect::Postgres,
            "mysql" | "mariadb" => Dialect::MySql,
            "mssql" | "sqlserver" => Dialect::MsSql,
            _ => Dialect::Sqlite,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    /// Keyword or bare identifier (original spelling).
    Word(String),
    /// Quoted identifier ("x", `x`, [x]); content unescaped.
    Ident(String),
    /// String literal; content unescaped.
    Str(String),
    Num(String),
    /// Any punctuation / operator character sequence (one char per token except `::`).
    Punct(char),
    /// Placeholder such as `$1`, `?`, `:name`, `@P1`.
    Param(String),
}

impl Tok {
    pub fn is_word(&self, w: &str) -> bool {
        matches!(self, Tok::Word(x) if x.eq_ignore_ascii_case(w))
    }
    pub fn upper(&self) -> Option<String> {
        match self {
            Tok::Word(x) => Some(x.to_ascii_uppercase()),
            _ => None,
        }
    }
}

/// A token with its byte span in the source.
#[derive(Clone, Debug)]
pub struct Spanned {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}
fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Tokenizes SQL. Comments (`--`, `#` for MySQL, `/* */` nested for Postgres) are dropped.
/// Unterminated strings/comments run to the end of input (never panics).
pub fn tokenize(sql: &str, d: Dialect) -> Vec<Spanned> {
    let b: Vec<(usize, char)> = sql.char_indices().collect();
    let n = b.len();
    let at = |i: usize| -> char { if i < n { b[i].1 } else { '\0' } };
    let pos = |i: usize| -> usize { if i < n { b[i].0 } else { sql.len() } };
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let c = at(i);
        let start = pos(i);
        // whitespace
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // comments
        if c == '-' && at(i + 1) == '-' {
            while i < n && at(i) != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '#' && d == Dialect::MySql {
            while i < n && at(i) != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && at(i + 1) == '*' {
            let nested = d == Dialect::Postgres || d == Dialect::MsSql;
            let mut depth = 1;
            i += 2;
            while i < n && depth > 0 {
                if at(i) == '*' && at(i + 1) == '/' {
                    depth -= 1;
                    i += 2;
                } else if nested && at(i) == '/' && at(i + 1) == '*' {
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // strings: '...' with '' escape (+ backslash escapes in MySQL and Postgres E'')
        let estr = d == Dialect::Postgres && (c == 'E' || c == 'e') && at(i + 1) == '\'';
        let nstr = (c == 'N' || c == 'n') && at(i + 1) == '\'';
        if c == '\'' || estr || nstr {
            if estr || nstr {
                i += 1;
            }
            let backslash = d == Dialect::MySql || estr;
            i += 1;
            let mut s = String::new();
            while i < n {
                let ch = at(i);
                if backslash && ch == '\\' && i + 1 < n {
                    s.push(at(i + 1));
                    i += 2;
                    continue;
                }
                if ch == '\'' {
                    if at(i + 1) == '\'' {
                        s.push('\'');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                s.push(ch);
                i += 1;
            }
            out.push(Spanned { tok: Tok::Str(s), start, end: pos(i) });
            continue;
        }
        // Postgres dollar quoting: $$...$$ or $tag$...$tag$
        if c == '$' && d == Dialect::Postgres {
            if at(i + 1).is_ascii_digit() {
                let mut j = i + 1;
                while j < n && at(j).is_ascii_digit() {
                    j += 1;
                }
                out.push(Spanned { tok: Tok::Param(sql[start..pos(j)].to_string()), start, end: pos(j) });
                i = j;
                continue;
            }
            let mut j = i + 1;
            while j < n && (at(j).is_alphanumeric() || at(j) == '_') {
                j += 1;
            }
            if at(j) == '$' {
                let tag = &sql[start..pos(j + 1)];
                let body_start = pos(j + 1);
                if let Some(rel) = sql[body_start..].find(tag) {
                    let body = sql[body_start..body_start + rel].to_string();
                    let end = body_start + rel + tag.len();
                    out.push(Spanned { tok: Tok::Str(body), start, end });
                    // advance i to the char index at `end`
                    while i < n && pos(i) < end {
                        i += 1;
                    }
                } else {
                    out.push(Spanned { tok: Tok::Str(sql[body_start..].to_string()), start, end: sql.len() });
                    i = n;
                }
                continue;
            }
        }
        // quoted identifiers
        let close = match c {
            '"' => Some('"'),
            '`' if d == Dialect::MySql || d == Dialect::Sqlite => Some('`'),
            '[' if d == Dialect::MsSql || d == Dialect::Sqlite => Some(']'),
            _ => None,
        };
        if let Some(q) = close {
            i += 1;
            let mut s = String::new();
            while i < n {
                let ch = at(i);
                if ch == q {
                    if at(i + 1) == q {
                        s.push(q);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                s.push(ch);
                i += 1;
            }
            out.push(Spanned { tok: Tok::Ident(s), start, end: pos(i) });
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && at(i + 1).is_ascii_digit()) {
            let mut j = i;
            while j < n && (at(j).is_ascii_alphanumeric() || at(j) == '.') {
                j += 1;
            }
            out.push(Spanned { tok: Tok::Num(sql[start..pos(j)].to_string()), start, end: pos(j) });
            i = j;
            continue;
        }
        if is_ident_start(c) {
            let mut j = i;
            while j < n && is_ident_char(at(j)) {
                j += 1;
            }
            out.push(Spanned { tok: Tok::Word(sql[start..pos(j)].to_string()), start, end: pos(j) });
            i = j;
            continue;
        }
        if c == '?' {
            out.push(Spanned { tok: Tok::Param("?".into()), start, end: pos(i + 1) });
            i += 1;
            continue;
        }
        if c == '@' && is_ident_start(at(i + 1)) {
            let mut j = i + 1;
            while j < n && is_ident_char(at(j)) {
                j += 1;
            }
            out.push(Spanned { tok: Tok::Param(sql[start..pos(j)].to_string()), start, end: pos(j) });
            i = j;
            continue;
        }
        out.push(Spanned { tok: Tok::Punct(c), start, end: pos(i + 1) });
        i += 1;
    }
    out
}

/// One statement of a script, with its byte offset in the original text.
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct Statement {
    pub sql: String,
    pub offset: usize,
}

/// Splits a script into statements. Handles `;`, MySQL `DELIMITER xx` lines, T-SQL `GO` lines, and
/// keeps `BEGIN … END` bodies of CREATE TRIGGER / PROCEDURE / FUNCTION together.
pub fn split_statements(sql: &str, d: Dialect) -> Vec<Statement> {
    // First pass: break into chunks on DELIMITER / GO lines (outside of strings is assumed: these
    // client directives only appear at the start of a line).
    let mut chunks: Vec<(usize, String, String)> = Vec::new(); // (offset, text, delimiter)
    let mut delim = ";".to_string();
    let mut cur_start = 0usize;
    let mut offset = 0usize;
    let mut cur = String::new();
    for line in sql.split_inclusive('\n') {
        let t = line.trim();
        let upper = t.to_ascii_uppercase();
        if d == Dialect::MySql && upper.starts_with("DELIMITER ") {
            chunks.push((cur_start, std::mem::take(&mut cur), delim.clone()));
            delim = t[10..].trim().to_string();
            if delim.is_empty() {
                delim = ";".into();
            }
            offset += line.len();
            cur_start = offset;
            continue;
        }
        if d == Dialect::MsSql && (upper == "GO" || upper.starts_with("GO ")) {
            chunks.push((cur_start, std::mem::take(&mut cur), delim.clone()));
            chunks.push((offset, String::new(), "\u{0}GO".into())); // batch separator marker
            offset += line.len();
            cur_start = offset;
            continue;
        }
        if cur.is_empty() {
            cur_start = offset;
        }
        cur.push_str(line);
        offset += line.len();
    }
    chunks.push((cur_start, cur, delim));

    let mut out = Vec::new();
    for (base, text, delim) in chunks {
        if delim.starts_with('\u{0}') || text.trim().is_empty() {
            continue;
        }
        if delim != ";" {
            // Custom delimiter: plain textual split (strings with the delimiter are rare).
            let mut pos = 0;
            for part in text.split(delim.as_str()) {
                if !part.trim().is_empty() {
                    let lead = part.len() - part.trim_start().len();
                    out.push(Statement { sql: part.trim().to_string(), offset: base + pos + lead });
                }
                pos += part.len() + delim.len();
            }
            continue;
        }
        let toks = tokenize(&text, d);
        let mut stmt_start: Option<usize> = None;
        let mut first_tok = 0usize;
        let mut depth = 0i32;
        let mut routine = false;
        let mut k = 0;
        while k < toks.len() {
            let t = &toks[k];
            if stmt_start.is_none() {
                if t.tok == Tok::Punct(';') {
                    k += 1;
                    continue;
                }
                stmt_start = Some(t.start);
                first_tok = k;
                depth = 0;
                routine = false;
            }
            // Detect CREATE [OR REPLACE] [DEFINER=..] TRIGGER/PROCEDURE/FUNCTION/EVENT
            if k == first_tok && t.tok.is_word("CREATE") {
                for x in toks.iter().skip(k + 1).take(12) {
                    if x.tok.is_word("TRIGGER") || x.tok.is_word("PROCEDURE") || x.tok.is_word("FUNCTION") || x.tok.is_word("EVENT") {
                        routine = true;
                        break;
                    }
                    if x.tok.is_word("TABLE") || x.tok.is_word("VIEW") || x.tok.is_word("INDEX") {
                        break;
                    }
                }
            }
            if routine {
                if t.tok.is_word("BEGIN") || t.tok.is_word("CASE") {
                    // BEGIN TRANSACTION inside a body does not open a block in most dialects.
                    let next_tx = toks.get(k + 1).map(|x| x.tok.is_word("TRANSACTION") || x.tok.is_word("TRAN")).unwrap_or(false);
                    if !next_tx {
                        depth += 1;
                    }
                } else if t.tok.is_word("END") {
                    let next = toks.get(k + 1).map(|x| &x.tok);
                    let closes_other = matches!(next, Some(x) if x.is_word("IF") || x.is_word("LOOP") || x.is_word("WHILE") || x.is_word("REPEAT") || x.is_word("FOR"));
                    if !closes_other {
                        depth -= 1;
                    }
                }
            }
            if t.tok == Tok::Punct(';') && depth <= 0 {
                let s = stmt_start.take().unwrap();
                let piece = text[s..t.start].trim();
                if !piece.is_empty() {
                    out.push(Statement { sql: piece.to_string(), offset: base + s });
                }
            }
            k += 1;
        }
        if let Some(s) = stmt_start {
            let piece = text[s..].trim();
            if !piece.is_empty() {
                out.push(Statement { sql: piece.to_string(), offset: base + s });
            }
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// SELECT / SHOW / EXPLAIN / DESCRIBE / VALUES / read-only PRAGMA …
    Read,
    /// BEGIN / COMMIT / ROLLBACK / SAVEPOINT / USE — harmless on their own.
    Control,
    /// Anything that can change data, schema or server state.
    Write,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Classified {
    pub kind: Kind,
    /// Why the statement is destructive (DROP, TRUNCATE, ALTER … DROP, DELETE/UPDATE without WHERE).
    pub destructive: Option<String>,
    /// First keyword, upper-cased ("SELECT", "INSERT", …).
    pub verb: String,
}

const WRITE_WORDS: &[&str] = &["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "CALL", "EXEC", "EXECUTE", "COPY", "LOAD", "RENAME", "VACUUM", "REINDEX", "CLUSTER", "REFRESH", "COMMENT", "LOCK", "ATTACH", "DETACH", "IMPORT", "OPTIMIZE", "ANALYZE", "SET", "DO", "DECLARE", "BACKUP", "RESTORE", "KILL", "SHUTDOWN", "PREPARE", "DEALLOCATE", "LISTEN", "NOTIFY", "DISCARD", "RESET", "SECURITY", "REASSIGN", "HANDLER", "INSTALL", "UNINSTALL", "FLUSH", "PURGE", "CHECKPOINT"];

/// Classifies one statement (already split).
pub fn classify(sql: &str, d: Dialect) -> Classified {
    let toks = tokenize(sql, d);
    let words: Vec<String> = toks.iter().filter_map(|t| t.tok.upper()).collect();
    let verb = toks.iter().find_map(|t| t.tok.upper()).unwrap_or_default();
    let mut destructive = None;

    // Paren depth per token, for "top-level WHERE".
    let mut depth = 0i32;
    let mut depths = Vec::with_capacity(toks.len());
    for t in &toks {
        match t.tok {
            Tok::Punct('(') => {
                depths.push(depth);
                depth += 1;
            }
            Tok::Punct(')') => {
                depth -= 1;
                depths.push(depth);
            }
            _ => depths.push(depth),
        }
    }
    let top_has = |from: usize, w: &str| toks.iter().enumerate().skip(from).any(|(i, t)| depths[i] == 0 && t.tok.is_word(w));

    // Destructive checks (any dialect).
    for (i, t) in toks.iter().enumerate() {
        if depths[i] != 0 {
            continue;
        }
        let Some(u) = t.tok.upper() else { continue };
        match u.as_str() {
            "DROP" => {
                let what = toks.get(i + 1).and_then(|x| x.tok.upper()).unwrap_or_default();
                let alter = toks[..i].iter().any(|x| x.tok.is_word("ALTER"));
                destructive = Some(if alter { format!("ALTER … DROP {what}") } else { format!("DROP {what}") });
                break;
            }
            "TRUNCATE" => {
                destructive = Some("TRUNCATE".into());
                break;
            }
            "DELETE" | "UPDATE" => {
                // `ON DELETE CASCADE` / `ON UPDATE` in DDL and `FOR UPDATE` locks are not statements.
                let prev = if i > 0 { toks[i - 1].tok.upper() } else { None };
                if matches!(prev.as_deref(), Some("ON") | Some("FOR") | Some("KEY")) {
                    continue;
                }
                if u == "UPDATE" && prev.as_deref() == Some("DUPLICATE") {
                    continue;
                }
                if !top_has(i + 1, "WHERE") && !top_has(i + 1, "CURRENT") {
                    destructive = Some(format!("{u} without WHERE"));
                    break;
                }
            }
            _ => {}
        }
    }

    let kind = match verb.as_str() {
        "SELECT" => {
            // SELECT … INTO creates a table (Postgres/MSSQL) or writes a file (MySQL OUTFILE).
            if words.iter().any(|w| w == "INTO") { Kind::Write } else { Kind::Read }
        }
        "WITH" => {
            if words.iter().any(|w| matches!(w.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "INTO")) { Kind::Write } else { Kind::Read }
        }
        "SHOW" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE" | "HELP" => Kind::Read,
        "EXPLAIN" => {
            // EXPLAIN ANALYZE runs the statement: only read-only when the inner statement is.
            let analyze = words.iter().take(4).any(|w| w == "ANALYZE" || w == "ANALYSE");
            if analyze && words.iter().any(|w| matches!(w.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "CREATE" | "DROP" | "ALTER" | "TRUNCATE")) {
                Kind::Write
            } else {
                Kind::Read
            }
        }
        "PRAGMA" => {
            if toks.iter().any(|t| t.tok == Tok::Punct('=')) { Kind::Write } else { Kind::Read }
        }
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "END" | "SAVEPOINT" | "RELEASE" | "USE" => Kind::Control,
        "" => Kind::Control,
        v if WRITE_WORDS.contains(&v) => Kind::Write,
        _ => Kind::Write,
    };
    Classified { kind, destructive, verb }
}

/// The guard applied before running statements. `Err` carries a `CONFIRM_REQUIRED:` prefix so the
/// UI can ask and retry with `confirmed: true`.
pub fn guard(stmts: &[Statement], d: Dialect, production: bool, read_only: bool, confirmed: bool) -> Result<(), String> {
    if confirmed {
        return Ok(());
    }
    for s in stmts {
        let c = classify(&s.sql, d);
        if let Some(why) = &c.destructive {
            return Err(format!("CONFIRM_REQUIRED:destructive:{why}: this statement can destroy data. Confirm to run it:\n{}", preview(&s.sql)));
        }
        if (production || read_only) && c.kind == Kind::Write {
            let label = if read_only { "read-only" } else { "production" };
            return Err(format!("CONFIRM_REQUIRED:{label}:{}: this connection is marked {label}. Confirm to run:\n{}", c.verb, preview(&s.sql)));
        }
    }
    Ok(())
}

fn preview(s: &str) -> String {
    let t: String = s.chars().take(400).collect();
    if s.chars().count() > 400 { format!("{t}…") } else { t }
}

/// True when every statement of the script is read-only (Read or Control).
pub fn all_read_only(sql: &str, d: Dialect) -> bool {
    split_statements(sql, d).iter().all(|s| {
        let c = classify(&s.sql, d);
        c.kind != Kind::Write && c.destructive.is_none()
    })
}

// -------------------------------------------------------------------------------------------
// Quoting
// -------------------------------------------------------------------------------------------

/// Quotes one identifier for the dialect, doubling the closing quote character.
pub fn quote_ident(d: Dialect, name: &str) -> String {
    let name = name.replace('\0', "");
    match d {
        Dialect::MySql => format!("`{}`", name.replace('`', "``")),
        Dialect::MsSql => format!("[{}]", name.replace(']', "]]")),
        Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// `schema.table` (schema omitted when empty).
pub fn qualified(d: Dialect, schema: &str, table: &str) -> String {
    if schema.is_empty() {
        quote_ident(d, table)
    } else {
        format!("{}.{}", quote_ident(d, schema), quote_ident(d, table))
    }
}

/// SQL string literal (for previews and generated scripts — execution always binds parameters).
pub fn quote_literal(d: Dialect, s: &str) -> String {
    let s = s.replace('\0', "");
    match d {
        Dialect::MySql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        Dialect::MsSql => format!("N'{}'", s.replace('\'', "''")),
        Dialect::Postgres => {
            if s.contains('\\') {
                // standard_conforming_strings is on by default, but be explicit in previews.
                format!("'{}'", s.replace('\'', "''"))
            } else {
                format!("'{}'", s.replace('\'', "''"))
            }
        }
        Dialect::Sqlite => format!("'{}'", s.replace('\'', "''")),
    }
}

/// A type name coming from the catalog that is safe to splice into `CAST(? AS <type>)`.
pub fn safe_type_name(t: &str) -> bool {
    !t.is_empty() && t.len() < 128 && t.chars().all(|c| c.is_alphanumeric() || " _(),.[]\"".contains(c)) && !t.contains("--")
}
