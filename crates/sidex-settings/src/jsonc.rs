//! JSON with Comments (JSONC) parser — strips `//`, `/* */` comments and
//! trailing commas before delegating to `serde_json`.

use anyhow::{Context, Result};
use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone)]
pub struct JsoncError {
    pub line: u32,
    pub column: u32,
    pub message: String,
}

impl fmt::Display for JsoncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.column, self.message)
    }
}
impl std::error::Error for JsoncError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommentKind {
    Line,
    Block,
}

#[derive(Debug, Clone)]
pub struct JsoncComment {
    pub line: u32,
    pub text: String,
    pub kind: CommentKind,
}

/// Parse a JSONC string into a `serde_json::Value`.
pub fn parse_jsonc(input: &str) -> Result<Value> {
    let stripped = strip_comments(input);
    let cleaned = remove_trailing_commas(&stripped);
    serde_json::from_str(&cleaned).context("failed to parse JSONC")
}

/// Parse JSONC, returning the value and all extracted comments for round-tripping.
pub fn parse_jsonc_with_comments(input: &str) -> Result<(Value, Vec<JsoncComment>)> {
    Ok((parse_jsonc(input)?, extract_comments(input)))
}

/// Remove comments but preserve line numbers (replace comment chars with spaces).
pub fn strip_comments(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = bytes.to_vec();
    let mut pos = 0;
    while pos < bytes.len() {
        if bytes[pos] == b'"' {
            pos = string_end(bytes, pos);
        } else if bytes.get(pos..pos + 2) == Some(b"//") {
            let start = pos;
            while pos < bytes.len() && !matches!(bytes[pos], b'\n' | b'\r') {
                pos += 1;
            }
            output[start..pos].fill(b' ');
        } else if bytes.get(pos..pos + 2) == Some(b"/*") {
            let start = pos;
            pos += 2;
            let mut depth = 1;
            while pos < bytes.len() && depth > 0 {
                if bytes.get(pos..pos + 2) == Some(b"/*") {
                    depth += 1;
                    pos += 2;
                } else if bytes.get(pos..pos + 2) == Some(b"*/") {
                    depth -= 1;
                    pos += 2;
                } else {
                    pos += 1;
                }
            }
            for byte in &mut output[start..pos] {
                if !matches!(*byte, b'\n' | b'\r') {
                    *byte = b' ';
                }
            }
        } else {
            pos += 1;
        }
    }
    // Only complete comment byte ranges were replaced with ASCII whitespace.
    String::from_utf8(output).expect("stripping comments preserves UTF-8")
}

/// Pretty-print a `serde_json::Value` as JSONC-compatible JSON.
pub fn format_jsonc(value: &Value, indent: u32) -> String {
    fmt_val(value, &" ".repeat(indent as usize), 0)
}

/// Edit a value at the given key path inside a JSONC document, preserving formatting/comments.
pub fn modify_jsonc(input: &str, path: &[&str], value: &Value) -> Result<String> {
    if path.is_empty() {
        return Ok(format_jsonc(value, 2));
    }
    parse_jsonc(input)?;
    // The stripped text has exactly the same byte offsets as the source.
    let clean = strip_comments(input);
    let mut object_start = skip_whitespace(clean.as_bytes(), 0);
    for (index, key) in path.iter().enumerate() {
        let object = object_layout(&clean, object_start)?;
        if let Some(property) = object
            .properties
            .iter()
            .rev()
            .find(|property| property.key == *key)
        {
            if index == path.len() - 1 {
                let mut result = input.to_string();
                result.replace_range(
                    property.value_start..property.value_end,
                    &serde_json::to_string(value)?,
                );
                return Ok(result);
            }
            object_start = property.value_start;
        } else {
            let mut nested = value.clone();
            for part in path[index + 1..].iter().rev() {
                nested = Value::Object(serde_json::Map::from_iter([(part.to_string(), nested)]));
            }
            return insert_property(input, &clean, &object, key, &nested);
        }
    }
    unreachable!("a nonempty path either replaces or inserts a property")
}

fn string_end(bytes: &[u8], start: usize) -> usize {
    let mut pos = start + 1;
    while pos < bytes.len() {
        match bytes[pos] {
            b'\\' => pos = (pos + 2).min(bytes.len()),
            b'"' => return pos + 1,
            _ => pos += 1,
        }
    }
    bytes.len()
}

fn skip_whitespace(bytes: &[u8], mut pos: usize) -> usize {
    while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
        pos += 1;
    }
    pos
}

fn json_value_end(clean: &str, start: usize) -> usize {
    let bytes = clean.as_bytes();
    if bytes.get(start) == Some(&b'"') {
        return string_end(bytes, start);
    }
    if matches!(bytes.get(start), Some(b'{' | b'[')) {
        let mut depth = 1;
        let mut pos = start + 1;
        while pos < bytes.len() {
            match bytes[pos] {
                b'"' => {
                    pos = string_end(bytes, pos);
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return pos + 1;
                    }
                }
                _ => {}
            }
            pos += 1;
        }
        return pos;
    }
    let mut pos = start;
    while bytes
        .get(pos)
        .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(*byte, b',' | b'}' | b']'))
    {
        pos += 1;
    }
    pos
}

struct PropertySpan {
    key: String,
    key_start: usize,
    value_start: usize,
    value_end: usize,
}
struct ObjectLayout {
    properties: Vec<PropertySpan>,
    close: usize,
}

fn object_layout(clean: &str, start: usize) -> Result<ObjectLayout> {
    let bytes = clean.as_bytes();
    anyhow::ensure!(
        bytes.get(start) == Some(&b'{'),
        "settings path is not an object"
    );
    let mut properties = Vec::new();
    let mut pos = start + 1;
    loop {
        pos = skip_whitespace(bytes, pos);
        if bytes.get(pos) == Some(&b'}') {
            return Ok(ObjectLayout {
                properties,
                close: pos,
            });
        }
        anyhow::ensure!(bytes.get(pos) == Some(&b'"'), "expected an object property");
        let key_start = pos;
        let key_end = string_end(bytes, pos);
        let key = serde_json::from_str(&clean[pos..key_end])?;
        pos = skip_whitespace(bytes, key_end);
        anyhow::ensure!(
            bytes.get(pos) == Some(&b':'),
            "expected a property separator"
        );
        let value_start = skip_whitespace(bytes, pos + 1);
        let value_end = json_value_end(clean, value_start);
        properties.push(PropertySpan {
            key,
            key_start,
            value_start,
            value_end,
        });
        pos = skip_whitespace(bytes, value_end);
        if bytes.get(pos) == Some(&b',') {
            pos += 1;
        }
    }
}

fn line_indent(input: &str, position: usize) -> Option<&str> {
    let start = input[..position].rfind('\n').map_or(0, |offset| offset + 1);
    let prefix = &input[start..position];
    prefix
        .bytes()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r'))
        .then_some(prefix)
}

fn insert_property(
    input: &str,
    clean: &str,
    object: &ObjectLayout,
    key: &str,
    value: &Value,
) -> Result<String> {
    let newline = if input.contains("\r\n") { "\r\n" } else { "\n" };
    let closing_indent = line_indent(input, object.close).unwrap_or("");
    let fallback_indent = format!("{closing_indent}  ");
    let indent = object
        .properties
        .first()
        .and_then(|property| line_indent(input, property.key_start))
        .unwrap_or(&fallback_indent);
    let insert_at = object.close - closing_indent.len();
    let trailing_comma = object
        .properties
        .last()
        .is_some_and(|property| clean[property.value_end..object.close].contains(','));
    let separator = if input[..insert_at].ends_with('\n') {
        ""
    } else {
        newline
    };
    let addition = format!(
        "{separator}{indent}{}: {}{}{newline}",
        serde_json::to_string(key)?,
        serde_json::to_string(value)?,
        if trailing_comma { "," } else { "" }
    );
    let mut result = input.to_string();
    result.insert_str(insert_at, &addition);
    if let Some(last) = object.properties.last() {
        if !trailing_comma {
            result.insert(last.value_end, ',');
        }
    }
    Ok(result)
}

fn fmt_val(v: &Value, ind: &str, d: usize) -> String {
    match v {
        Value::Object(m) if m.is_empty() => "{}".into(),
        Value::Array(a) if a.is_empty() => "[]".into(),
        Value::Object(m) => {
            let ip = ind.repeat(d + 1);
            let op = ind.repeat(d);
            let e: Vec<String> = m
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{ip}{}: {}",
                        serde_json::to_string(k).unwrap(),
                        fmt_val(v, ind, d + 1)
                    )
                })
                .collect();
            format!("{{\n{}\n{op}}}", e.join(",\n"))
        }
        Value::Array(a) => {
            let ip = ind.repeat(d + 1);
            let op = ind.repeat(d);
            let e: Vec<String> = a
                .iter()
                .map(|v| format!("{ip}{}", fmt_val(v, ind, d + 1)))
                .collect();
            format!("[\n{}\n{op}]", e.join(",\n"))
        }
        _ => serde_json::to_string(v).unwrap(),
    }
}

fn extract_comments(input: &str) -> Vec<JsoncComment> {
    let b = input.as_bytes();
    let (len, mut comments, mut i, mut line) = (b.len(), Vec::new(), 0, 1u32);
    while i < len {
        match b[i] {
            b'\n' => {
                line += 1;
                i += 1;
            }
            b'"' => {
                i += 1;
                while i < len {
                    if b[i] == b'\\' && i + 1 < len {
                        i += 2;
                    } else if b[i] == b'"' {
                        i += 1;
                        break;
                    } else {
                        if b[i] == b'\n' {
                            line += 1;
                        }
                        i += 1;
                    }
                }
            }
            b'/' if i + 1 < len && b[i + 1] == b'/' => {
                let sl = line;
                i += 2;
                let ts = i;
                while i < len && b[i] != b'\n' {
                    i += 1;
                }
                comments.push(JsoncComment {
                    line: sl,
                    text: input[ts..i].trim().into(),
                    kind: CommentKind::Line,
                });
            }
            b'/' if i + 1 < len && b[i + 1] == b'*' => {
                let sl = line;
                i += 2;
                let ts = i;
                let mut depth: u32 = 1;
                while i < len && depth > 0 {
                    if i + 1 < len && b[i] == b'/' && b[i + 1] == b'*' {
                        depth += 1;
                        i += 2;
                    } else if i + 1 < len && b[i] == b'*' && b[i + 1] == b'/' {
                        depth -= 1;
                        if depth == 0 {
                            comments.push(JsoncComment {
                                line: sl,
                                text: input[ts..i].trim().into(),
                                kind: CommentKind::Block,
                            });
                        }
                        i += 2;
                    } else {
                        if b[i] == b'\n' {
                            line += 1;
                        }
                        i += 1;
                    }
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    comments
}

fn remove_trailing_commas(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = bytes.to_vec();
    let mut pos = 0;
    while pos < bytes.len() {
        if bytes[pos] == b'"' {
            pos = string_end(bytes, pos);
        } else {
            if bytes[pos] == b',' {
                let next = skip_whitespace(bytes, pos + 1);
                if matches!(bytes.get(next), Some(b']' | b'}')) {
                    output[pos] = b' ';
                }
            }
            pos += 1;
        }
    }
    String::from_utf8(output).expect("removing ASCII commas preserves UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_byte_offsets_survive_jsonc_processing() {
        let source = "{\n // Русский комментарий 🌏\n \"тема\": \"Светлая 日本語 🌙\",\n}";
        assert_eq!(strip_comments(source).len(), source.len());
        assert_eq!(parse_jsonc(source).unwrap()["тема"], "Светлая 日本語 🌙");
        let updated = modify_jsonc(source, &["тема"], &Value::from("Тёмная")).unwrap();
        assert!(updated.contains("// Русский комментарий 🌏"));
        assert_eq!(parse_jsonc(&updated).unwrap()["тема"], "Тёмная");
    }

    #[test]
    fn edits_follow_full_paths_and_ignore_matching_strings() {
        let source = r#"{ "text": "key", "a": {"key": 1}, "b": { "key": /* keep */ 2 } }"#;
        let updated = modify_jsonc(source, &["b", "key"], &Value::from(3)).unwrap();
        let value = parse_jsonc(&updated).unwrap();
        assert_eq!(value["a"]["key"], 1);
        assert_eq!(value["b"]["key"], 3);
        assert_eq!(value["text"], "key");
        assert!(updated.contains("/* keep */"));
    }

    #[test]
    fn inserting_settings_preserves_comments_trailing_commas_and_escaped_keys() {
        for source in [
            "{\n // keep\n}",
            "{\n \"a\": 1 // keep\n}",
            "{\r\n \"a\": 1, // keep\r\n}",
        ] {
            let updated =
                modify_jsonc(source, &["editor.test", "a\"b"], &Value::from("строка")).unwrap();
            assert!(updated.contains("// keep"));
            assert_eq!(
                parse_jsonc(&updated).unwrap()["editor.test"]["a\"b"],
                "строка"
            );
        }
    }

    #[test]
    fn parse_strips_comments_and_trailing_commas() {
        let v = parse_jsonc("{\n // c\n \"a\": 1,\n /* b */ \"b\": 2,\n}").unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], 2);
    }
    #[test]
    fn comments_inside_strings_preserved() {
        let v = parse_jsonc(r#"{"u":"https://x.com","n":"/* not */"}"#).unwrap();
        assert_eq!(v["u"], "https://x.com");
        assert_eq!(v["n"], "/* not */");
    }
    #[test]
    fn escaped_quotes() {
        assert_eq!(parse_jsonc(r#"{"k":"v\"al"}"#).unwrap()["k"], "v\"al");
    }
    #[test]
    fn strip_preserves_line_count() {
        let s = "{\n  // comment\n  \"a\": 1\n}";
        assert_eq!(strip_comments(s).lines().count(), s.lines().count());
    }
    #[test]
    fn format_round_trip() {
        let v = parse_jsonc(r#"{"a":1,"b":[2,3]}"#).unwrap();
        assert_eq!(v, parse_jsonc(&format_jsonc(&v, 2)).unwrap());
    }
    #[test]
    fn with_comments_extracts() {
        let (v, c) = parse_jsonc_with_comments("{\n // l\n /* b */\n \"a\":1\n}").unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].kind, CommentKind::Line);
        assert_eq!(c[1].kind, CommentKind::Block);
    }
    #[test]
    fn modify_preserves_comments() {
        let r = modify_jsonc("{\n // keep\n \"f\": 14\n}", &["f"], &Value::from(16)).unwrap();
        assert!(r.contains("// keep"));
        assert_eq!(parse_jsonc(&r).unwrap()["f"], 16);
    }
    #[test]
    fn nested_block_comments() {
        assert_eq!(
            parse_jsonc("{\n /* o /* i */ s */\n \"a\":1\n}").unwrap()["a"],
            1
        );
    }
}
