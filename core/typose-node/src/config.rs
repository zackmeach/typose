//! Pure TOML codec. The caller owns fixed file destinations; this module has no filesystem API.
use napi::{Error, Result};
use napi_derive::napi;
use serde_json::{Map, Value as Json};
use toml_edit::{DocumentMut, Item, Value};

#[napi]
pub fn set_encoding_fallback(utf8: bool) {
    typose_core::raw::set_encoding_fallback(utf8);
}

fn document(source: &str) -> Result<DocumentMut> {
    if source.len() > 262_144 {
        return Err(Error::from_reason("Config exceeds 256 KiB"));
    }
    source.parse::<DocumentMut>().map_err(|e| Error::from_reason(e.to_string()))
}
fn json(value: &Value) -> Json {
    if let Some(v) = value.as_str() {
        Json::String(v.into())
    } else if let Some(v) = value.as_integer() {
        v.into()
    } else if let Some(v) = value.as_float() {
        serde_json::Number::from_f64(v).map(Json::Number).unwrap_or(Json::Null)
    } else if let Some(v) = value.as_bool() {
        v.into()
    } else if let Some(v) = value.as_array() {
        Json::Array(v.iter().map(json).collect())
    } else {
        Json::Null
    }
}
#[napi]
pub fn config_parse(source: String) -> Result<String> {
    let doc = document(&source)?;
    let values: Map<String, Json> =
        doc.iter().filter_map(|(k, item)| item.as_value().map(|v| (k.into(), json(v)))).collect();
    Ok(Json::Object(values).to_string())
}
fn value(v: Json) -> Result<Value> {
    Ok(match v {
        Json::String(s) => Value::from(s),
        Json::Bool(b) => Value::from(b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else {
                Value::from(n.as_f64().ok_or_else(|| Error::from_reason("Invalid number"))?)
            }
        }
        Json::Array(items) => {
            let mut a = toml_edit::Array::new();
            for item in items {
                a.push(value(item)?);
            }
            Value::Array(a)
        }
        _ => return Err(Error::from_reason("Only scalar settings and arrays are editable")),
    })
}
#[napi]
pub fn config_edit(source: String, key: String, encoded: String) -> Result<String> {
    let mut doc = document(&source)?;
    if key.is_empty() || key.len() > 64 || !key.bytes().all(|c| c.is_ascii_lowercase() || c == b'_') {
        return Err(Error::from_reason("Invalid setting key"));
    }
    let mut next = value(serde_json::from_str(&encoded).map_err(|e| Error::from_reason(e.to_string()))?)?;
    if let Some(old) = doc.get(&key).and_then(Item::as_value) {
        *next.decor_mut() = old.decor().clone();
    }
    doc[&key] = Item::Value(next);
    Ok(doc.to_string())
}
