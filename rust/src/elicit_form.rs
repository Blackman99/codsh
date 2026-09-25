//! MCP elicitation requests: the `elicitation/create` shapes codsh accepts
//! (a flat form of string / number / integer / boolean / enum /
//! multi-select fields, or a URL to open), caps against hostile servers,
//! and validation of what the user submits. The TUI card, the editor hub,
//! and the MCP proxies share it, so a proxy can refuse content that does
//! not match the schema the server asked for.

use serde_json::{Map, Value as JsonValue};

pub const MAX_FIELDS: usize = 32;
pub const MAX_MESSAGE_CHARS: usize = 4096;
pub const MAX_URL_CHARS: usize = 2048;
pub const MAX_ID_CHARS: usize = 128;
pub const MAX_NAME_CHARS: usize = 64;
pub const MAX_TITLE_CHARS: usize = 128;
pub const MAX_DESC_CHARS: usize = 512;
pub const MAX_ENUM_VALUES: usize = 32;
pub const MAX_ENUM_VALUE_CHARS: usize = 128;
pub const MAX_SCHEMA_BYTES: usize = 64 * 1024;
pub const MAX_DRAFT_CHARS: usize = 4096;

fn within(text: &str, max: usize) -> bool {
    text.chars().count() <= max
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Text {
        format: Option<String>,
        min_len: Option<u64>,
        max_len: Option<u64>,
    },
    Number {
        integer: bool,
        min: Option<f64>,
        max: Option<f64>,
    },
    Boolean,
    /// Single select; options are `(value, label)`.
    Choice {
        options: Vec<(String, String)>,
    },
    Multi {
        options: Vec<(String, String)>,
        min_items: Option<u64>,
        max_items: Option<u64>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: Kind,
    pub default: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    Form {
        schema: JsonValue,
        fields: Vec<Field>,
    },
    Url {
        url: String,
        elicitation_id: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub message: String,
    pub mode: Mode,
}

/// Check `elicitation/create` params. `Err` is why codsh declines it.
pub fn check_request(params: &JsonValue) -> Result<Request, String> {
    let message = params
        .get("message")
        .and_then(JsonValue::as_str)
        .ok_or("elicitation has no message")?;
    if !within(message, MAX_MESSAGE_CHARS) {
        return Err(format!("message exceeds {MAX_MESSAGE_CHARS} characters"));
    }
    let mode = params
        .get("mode")
        .and_then(JsonValue::as_str)
        .unwrap_or("form");
    let mode = match mode {
        "form" => {
            let schema = params
                .get("requestedSchema")
                .cloned()
                .ok_or("form elicitation has no requestedSchema")?;
            let fields = parse_schema(&schema)?;
            Mode::Form { schema, fields }
        }
        "url" => {
            let url = params
                .get("url")
                .and_then(JsonValue::as_str)
                .ok_or("URL elicitation has no url")?;
            let id = params
                .get("elicitationId")
                .and_then(JsonValue::as_str)
                .ok_or("URL elicitation has no elicitationId")?;
            if !within(url, MAX_URL_CHARS) || !within(id, MAX_ID_CHARS) {
                return Err("URL elicitation exceeds size limits".into());
            }
            let parsed = url::Url::parse(url).map_err(|_| "URL elicitation has an invalid url")?;
            if !matches!(parsed.scheme(), "https" | "http") {
                return Err("URL elicitation must use http or https".into());
            }
            Mode::Url {
                url: url.to_string(),
                elicitation_id: id.to_string(),
            }
        }
        other => return Err(format!("unsupported elicitation mode `{other}`")),
    };
    Ok(Request {
        message: message.to_string(),
        mode,
    })
}

/// Parse a `requestedSchema` into fields.
pub fn parse_schema(schema: &JsonValue) -> Result<Vec<Field>, String> {
    let object = schema
        .as_object()
        .ok_or("requestedSchema must be a JSON object")?;
    if object
        .get("type")
        .and_then(JsonValue::as_str)
        .is_some_and(|kind| kind != "object")
    {
        return Err("requestedSchema.type must be \"object\"".into());
    }
    if serde_json::to_vec(schema).map_or(true, |bytes| bytes.len() > MAX_SCHEMA_BYTES) {
        return Err(format!("requestedSchema exceeds {MAX_SCHEMA_BYTES} bytes"));
    }
    let properties = object
        .get("properties")
        .and_then(JsonValue::as_object)
        .ok_or("requestedSchema.properties is required")?;
    if properties.len() > MAX_FIELDS {
        return Err(format!("requestedSchema has more than {MAX_FIELDS} fields"));
    }
    let required: Vec<&str> = object
        .get("required")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .collect();
    let mut fields = Vec::new();
    for (name, property) in properties {
        if !within(name, MAX_NAME_CHARS) {
            return Err(format!("field name exceeds {MAX_NAME_CHARS} characters"));
        }
        fields.push(parse_field(
            name,
            property,
            required.contains(&name.as_str()),
        )?);
    }
    Ok(fields)
}

fn text(property: &JsonValue, key: &str, max: usize) -> Result<Option<String>, String> {
    match property.get(key).and_then(JsonValue::as_str) {
        Some(value) if !within(value, max) => Err(format!("{key} exceeds {max} characters")),
        Some(value) => Ok(Some(value.to_string())),
        None => Ok(None),
    }
}

fn options(
    list: &[JsonValue],
    labels: Option<&Vec<JsonValue>>,
) -> Result<Vec<(String, String)>, String> {
    if list.len() > MAX_ENUM_VALUES {
        return Err(format!("more than {MAX_ENUM_VALUES} options"));
    }
    let mut out = Vec::new();
    for (index, item) in list.iter().enumerate() {
        // `oneOf` / `anyOf`: `{const, title}`; `enum`: plain strings.
        let (value, label) = match item {
            JsonValue::String(value) => (
                value.clone(),
                labels
                    .and_then(|labels| labels.get(index))
                    .and_then(JsonValue::as_str)
                    .unwrap_or(value)
                    .to_string(),
            ),
            JsonValue::Object(_) => {
                let value = item
                    .get("const")
                    .and_then(JsonValue::as_str)
                    .ok_or("option without a string const")?;
                let label = item
                    .get("title")
                    .and_then(JsonValue::as_str)
                    .unwrap_or(value);
                (value.to_string(), label.to_string())
            }
            _ => return Err("options must be strings".into()),
        };
        if !within(&value, MAX_ENUM_VALUE_CHARS) || !within(&label, MAX_ENUM_VALUE_CHARS) {
            return Err(format!("option exceeds {MAX_ENUM_VALUE_CHARS} characters"));
        }
        out.push((value, label));
    }
    if out.is_empty() {
        return Err("a select field needs at least one option".into());
    }
    Ok(out)
}

fn choice_list(property: &JsonValue) -> Option<Result<Vec<(String, String)>, String>> {
    if let Some(list) = property.get("enum").and_then(JsonValue::as_array) {
        let labels = property.get("enumNames").and_then(JsonValue::as_array);
        return Some(options(list, labels));
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(list) = property.get(key).and_then(JsonValue::as_array) {
            return Some(options(list, None));
        }
    }
    None
}

fn parse_field(name: &str, property: &JsonValue, required: bool) -> Result<Field, String> {
    let title = text(property, "title", MAX_TITLE_CHARS)?.unwrap_or_else(|| name.to_string());
    let description = text(property, "description", MAX_DESC_CHARS)?;
    let default = property.get("default").cloned();
    if let Some(JsonValue::String(value)) = &default
        && !within(value, MAX_DRAFT_CHARS)
    {
        return Err(format!("default exceeds {MAX_DRAFT_CHARS} characters"));
    }
    let kind_name = property
        .get("type")
        .and_then(JsonValue::as_str)
        .unwrap_or("string");
    let uint = |key: &str| property.get(key).and_then(JsonValue::as_u64);
    let num = |key: &str| property.get(key).and_then(JsonValue::as_f64);
    let kind = match kind_name {
        "string" => match choice_list(property) {
            Some(list) => Kind::Choice { options: list? },
            None => Kind::Text {
                format: property
                    .get("format")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                min_len: uint("minLength"),
                max_len: uint("maxLength"),
            },
        },
        "number" | "integer" => Kind::Number {
            integer: kind_name == "integer",
            min: num("minimum"),
            max: num("maximum"),
        },
        "boolean" => Kind::Boolean,
        "array" => {
            let items = property.get("items").ok_or("array field without items")?;
            let list = choice_list(items).ok_or("array field items must be an enum")??;
            Kind::Multi {
                options: list,
                min_items: uint("minItems"),
                max_items: uint("maxItems"),
            }
        }
        other => return Err(format!("field `{name}` has unsupported type `{other}`")),
    };
    Ok(Field {
        name: name.to_string(),
        title,
        description,
        required,
        kind,
        default,
    })
}

fn valid_date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return false;
    }
    let (Ok(_), Ok(month), Ok(day)) = (
        parts[0].parse::<u32>(),
        parts[1].parse::<u32>(),
        parts[2].parse::<u32>(),
    ) else {
        return false;
    };
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn valid_format(format: &str, value: &str) -> Result<(), String> {
    let ok = match format {
        "email" => {
            let mut parts = value.split('@');
            let (local, domain) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            parts.next().is_none()
                && !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !value.chars().any(char::is_whitespace)
        }
        "uri" => url::Url::parse(value).is_ok(),
        "date" => valid_date(value),
        "date-time" => {
            let (date, time) = value.split_once(['T', 't']).unwrap_or((value, ""));
            valid_date(date)
                && time.len() >= 8
                && time.as_bytes()[2] == b':'
                && time.as_bytes()[5] == b':'
                && (time.ends_with('Z') || time.ends_with('z') || time[8..].contains(['+', '-']))
        }
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("not a valid {format}"))
    }
}

/// Check one submitted value (`None`: omitted).
pub fn check_value(field: &Field, value: Option<&JsonValue>) -> Result<(), String> {
    let Some(value) = value else {
        return if field.required {
            Err("required".into())
        } else {
            Ok(())
        };
    };
    match &field.kind {
        Kind::Text {
            format,
            min_len,
            max_len,
        } => {
            let text = value.as_str().ok_or("must be text")?;
            let len = text.chars().count() as u64;
            if len > MAX_DRAFT_CHARS as u64 {
                return Err(format!("longer than {MAX_DRAFT_CHARS} characters"));
            }
            if min_len.is_some_and(|min| len < min) {
                return Err(format!("at least {} characters", min_len.unwrap_or(0)));
            }
            if max_len.is_some_and(|max| len > max) {
                return Err(format!("at most {} characters", max_len.unwrap_or(0)));
            }
            match format {
                Some(format) => valid_format(format, text),
                None => Ok(()),
            }
        }
        Kind::Number { integer, min, max } => {
            let number = value.as_f64().ok_or("must be a number")?;
            if *integer && !(value.is_i64() || value.is_u64()) {
                return Err("must be a whole number".into());
            }
            if min.is_some_and(|min| number < min) {
                return Err(format!("at least {}", min.unwrap_or(0.0)));
            }
            if max.is_some_and(|max| number > max) {
                return Err(format!("at most {}", max.unwrap_or(0.0)));
            }
            Ok(())
        }
        Kind::Boolean => value
            .as_bool()
            .map(|_| ())
            .ok_or_else(|| "must be true or false".into()),
        Kind::Choice { options } => {
            let text = value.as_str().ok_or("must be one of the options")?;
            if options.iter().any(|(option, _)| option == text) {
                Ok(())
            } else {
                Err("must be one of the options".into())
            }
        }
        Kind::Multi {
            options,
            min_items,
            max_items,
        } => {
            let list = value.as_array().ok_or("must be a list of options")?;
            for item in list {
                let text = item.as_str().ok_or("must be a list of options")?;
                if !options.iter().any(|(option, _)| option == text) {
                    return Err(format!("`{text}` is not an option"));
                }
            }
            let count = list.len() as u64;
            if min_items.is_some_and(|min| count < min) {
                return Err(format!("select at least {}", min_items.unwrap_or(0)));
            }
            if max_items.is_some_and(|max| count > max) {
                return Err(format!("select at most {}", max_items.unwrap_or(0)));
            }
            Ok(())
        }
    }
}

/// Check accepted `content` against the form: every key is a field, every
/// required field is present, every value fits its field.
pub fn check_content(fields: &[Field], content: &Map<String, JsonValue>) -> Result<(), String> {
    for key in content.keys() {
        if !fields.iter().any(|field| &field.name == key) {
            return Err(format!("`{key}` is not a field of this form"));
        }
    }
    for field in fields {
        check_value(field, content.get(&field.name))
            .map_err(|error| format!("{}: {error}", field.title))?;
    }
    Ok(())
}

/// Turn a typed draft into the value for a text or number field (`None`:
/// left empty).
pub fn draft_value(field: &Field, draft: &str) -> Result<Option<JsonValue>, String> {
    if draft.is_empty() {
        return Ok(None);
    }
    match &field.kind {
        Kind::Number { integer: true, .. } => draft
            .trim()
            .parse::<i64>()
            .map(|number| Some(JsonValue::from(number)))
            .map_err(|_| "must be a whole number".into()),
        Kind::Number { .. } => {
            let number: f64 = draft.trim().parse().map_err(|_| "must be a number")?;
            serde_json::Number::from_f64(number)
                .map(|number| Some(JsonValue::Number(number)))
                .ok_or_else(|| "must be a finite number".into())
        }
        _ => Ok(Some(JsonValue::String(draft.to_string()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn form() -> JsonValue {
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "title": "Name", "minLength": 2},
                "email": {"type": "string", "format": "email"},
                "age": {"type": "integer", "minimum": 0, "maximum": 150},
                "tea": {"type": "boolean", "default": true},
                "color": {"type": "string", "enum": ["red", "blue"], "enumNames": ["Red", "Blue"]},
                "size": {"type": "string", "oneOf": [{"const": "s", "title": "Small"}]},
                "tags": {"type": "array", "items": {"enum": ["a", "b"]}, "maxItems": 1},
                "when": {"type": "string", "format": "date"}
            },
            "required": ["name", "email"]
        })
    }

    #[test]
    fn parses_the_spec_field_kinds() {
        let fields = parse_schema(&form()).unwrap();
        assert_eq!(fields.len(), 8);
        let color = fields.iter().find(|f| f.name == "color").unwrap();
        assert_eq!(
            color.kind,
            Kind::Choice {
                options: vec![("red".into(), "Red".into()), ("blue".into(), "Blue".into())]
            }
        );
        let size = fields.iter().find(|f| f.name == "size").unwrap();
        assert!(matches!(&size.kind, Kind::Choice { options } if options[0].1 == "Small"));
        assert!(fields.iter().find(|f| f.name == "name").unwrap().required);
    }

    #[test]
    fn content_is_checked_against_the_schema() {
        let fields = parse_schema(&form()).unwrap();
        let good = json!({"name": "Ann", "email": "a@b.co", "age": 40, "tags": ["a"], "when": "2026-09-25"});
        assert!(check_content(&fields, good.as_object().unwrap()).is_ok());
        for bad in [
            json!({"name": "Ann"}),
            json!({"name": "A", "email": "a@b.co"}),
            json!({"name": "Ann", "email": "nope"}),
            json!({"name": "Ann", "email": "a@b.co", "age": 1.5}),
            json!({"name": "Ann", "email": "a@b.co", "color": "green"}),
            json!({"name": "Ann", "email": "a@b.co", "tags": ["a", "b"]}),
            json!({"name": "Ann", "email": "a@b.co", "extra": 1}),
            json!({"name": "Ann", "email": "a@b.co", "when": "2026-13-01"}),
        ] {
            assert!(
                check_content(&fields, bad.as_object().unwrap()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn hostile_requests_are_refused() {
        let many: Map<String, JsonValue> = (0..40)
            .map(|i| (format!("f{i}"), json!({"type": "string"})))
            .collect();
        assert!(parse_schema(&json!({"type": "object", "properties": many})).is_err());
        assert!(
            parse_schema(&json!({"type": "object", "properties": {"x": {"type": "object"}}}))
                .is_err()
        );
        let long = "x".repeat(MAX_MESSAGE_CHARS + 1);
        assert!(check_request(&json!({"message": long, "requestedSchema": form()})).is_err());
        assert!(check_request(&json!({"message": "m", "mode": "url", "url": "file:///etc/passwd", "elicitationId": "1"})).is_err());
        let url = check_request(&json!({"message": "m", "mode": "url", "url": "https://x.test/a", "elicitationId": "e1"})).unwrap();
        assert!(matches!(url.mode, Mode::Url { .. }));
    }

    #[test]
    fn drafts_become_typed_values() {
        let fields = parse_schema(&form()).unwrap();
        let age = fields.iter().find(|f| f.name == "age").unwrap();
        assert_eq!(draft_value(age, "42").unwrap(), Some(json!(42)));
        assert!(draft_value(age, "4.2").is_err());
        assert_eq!(draft_value(age, "").unwrap(), None);
    }
}
