//! JSON-RPC 2.0 over HTTP on loopback. The schema is `schema.json`; `dispatch` is shared with
//! the `once` CLI mode so both speak the same methods.

use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use x402_ycash_light::keys;
use x402_ycash_light::wallet::{BuildRequest, Error, Wallet};

/// Where the binary keeps the imported key: `<data>/spending.key`, bech32, mode 0600.
pub fn key_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("spending.key")
}

fn write_secret_file(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(contents.as_bytes())?;
    f.write_all(b"\n")
}

pub type Shared = Arc<Mutex<Wallet>>;

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[serde(default)]
    jsonrpc: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    id: Value,
}

/// JSON-RPC error codes: the standard ones plus an application range for wallet errors.
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const WALLET_ERROR: i64 = -32000;
pub const NOT_SYNCED: i64 = -32001;
pub const NO_KEY: i64 = -32002;
pub const REJECTED: i64 = -32003;

fn code_for(e: &Error) -> i64 {
    match e {
        Error::NoKey => NO_KEY,
        Error::NotSynced => NOT_SYNCED,
        Error::Rejected(..) => REJECTED,
        Error::Address(_)
        | Error::Amount(_)
        | Error::Memo(_)
        | Error::Hex(_)
        | Error::Birthday(_)
        | Error::Key(_)
        | Error::Expiry(_)
        | Error::FeeBelowFloor { .. } => INVALID_PARAMS,
        _ => WALLET_ERROR,
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfParams {
    #[serde(default)]
    min_confirmations: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportParams {
    key: String,
    #[serde(default)]
    birthday: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BroadcastParams {
    tx_hex: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncParams {
    #[serde(default)]
    batch_size: Option<u32>,
}

fn params<T: for<'de> Deserialize<'de> + Default>(v: &Value) -> Result<T, (i64, String)> {
    if v.is_null() {
        return Ok(T::default());
    }
    serde_json::from_value(v.clone()).map_err(|e| (INVALID_PARAMS, e.to_string()))
}

fn params_req<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, (i64, String)> {
    serde_json::from_value(v.clone()).map_err(|e| (INVALID_PARAMS, e.to_string()))
}

/// Runs one method. Long operations (sync, build) hold the wallet lock; the RPC server is meant
/// for one agent, and holding the lock is what keeps two builds from spending the same note.
fn to_json<T: serde::Serialize>(v: Result<T, Error>) -> Result<Value, (i64, String)> {
    v.map_err(|e| (code_for(&e), e.to_string()))
        .map(|x| serde_json::to_value(x).expect("serializable"))
}

pub async fn dispatch(shared: &Shared, method: &str, p: &Value) -> Result<Value, (i64, String)> {
    let w = |e: Error| (code_for(&e), e.to_string());
    match method {
        "status" => {
            let c: ConfParams = params(p)?;
            let mut g = shared.lock().await;
            to_json(g.status(c.min_confirmations.unwrap_or(1)).await)
        }
        "address" => {
            let g = shared.lock().await;
            to_json(g.key_info())
        }
        "export_fvk" => {
            let g = shared.lock().await;
            to_json(
                g.key_info()
                    .map(|k| json!({ "fvk": k.fvk, "address": k.address, "birthday": k.birthday })),
            )
        }
        "import_key" => {
            let c: ImportParams = params_req(p)?;
            let mut g = shared.lock().await;
            let extsk =
                keys::import(&g.params, &c.key).map_err(|e| (INVALID_PARAMS, e.to_string()))?;
            let had_key = g.has_key();
            let info = g.register_key(extsk.clone(), c.birthday).await.map_err(w)?;
            if !had_key {
                write_secret_file(
                    &key_path(&g.data_dir),
                    &keys::encode_extsk(&g.params, &extsk),
                )
                .map_err(|e| (WALLET_ERROR, format!("cannot write spending.key: {e}")))?;
            }
            to_json(Ok(info))
        }
        "sync" => {
            let c: SyncParams = params(p)?;
            let mut g = shared.lock().await;
            to_json(
                g.sync(c.batch_size.unwrap_or(crate::sync::DEFAULT_CHUNK_BLOCKS))
                    .await,
            )
        }
        "list_notes" => {
            let c: ConfParams = params(p)?;
            let g = shared.lock().await;
            to_json(g.list_notes(c.min_confirmations.unwrap_or(1)))
        }
        "build" => {
            let req: BuildRequest = params_req(p)?;
            let mut g = shared.lock().await;
            to_json(g.build(&req).await)
        }
        "send" => {
            let req: BuildRequest = params_req(p)?;
            let mut g = shared.lock().await;
            let built = g.build(&req).await.map_err(w)?;
            let sent = g.broadcast(&built.txHex).await.map_err(w)?;
            Ok(
                json!({ "txid": sent.txid, "txHex": built.txHex, "feeZat": built.feeZat,
                       "expiryHeight": built.expiryHeight, "branchId": built.branchId }),
            )
        }
        "broadcast" => {
            let c: BroadcastParams = params_req(p)?;
            let mut g = shared.lock().await;
            to_json(g.broadcast(&c.tx_hex).await)
        }
        other => Err((
            METHOD_NOT_FOUND,
            format!("unknown method {other}; methods: {}", METHODS.join(", ")),
        )),
    }
}

pub const METHODS: &[&str] = &[
    "status",
    "address",
    "export_fvk",
    "import_key",
    "sync",
    "list_notes",
    "build",
    "send",
    "broadcast",
];

async fn handle(
    shared: Shared,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    if req.method() != Method::POST {
        return Ok(plain(
            StatusCode::METHOD_NOT_ALLOWED,
            "POST a JSON-RPC 2.0 request",
        ));
    }
    let body = req.into_body().collect().await?.to_bytes();
    let parsed: Result<RpcRequest, _> = serde_json::from_slice(&body);
    let reply = match parsed {
        Err(e) => error_reply(Value::Null, PARSE_ERROR, &e.to_string()),
        Ok(r) if r.jsonrpc.as_deref().is_some_and(|v| v != "2.0") => {
            error_reply(r.id, INVALID_REQUEST, "jsonrpc must be \"2.0\"")
        }
        Ok(r) => match dispatch(&shared, &r.method, &r.params).await {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": r.id, "result": result }),
            Err((code, msg)) => error_reply(r.id, code, &msg),
        },
    };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(reply.to_string())))
        .expect("response"))
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn plain(status: StatusCode, text: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(Full::new(Bytes::from(text.to_owned())))
        .expect("response")
}

/// Binds `listen` (loopback only), prints the bound address as `listening 127.0.0.1:PORT` on
/// stdout, and serves until the process ends.
pub async fn serve(shared: Shared, listen: SocketAddr) -> std::io::Result<()> {
    if !listen.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "x402-light serves loopback only (it holds a spending key)",
        ));
    }
    let listener = TcpListener::bind(listen).await?;
    let bound = listener.local_addr()?;
    println!("listening {bound}");
    loop {
        let (stream, _) = listener.accept().await?;
        let shared = shared.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let svc = service_fn(move |req| handle(shared.clone(), req));
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                tracing::debug!("connection ended: {e}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_lists_exactly_the_served_methods() {
        let schema: Value = serde_json::from_str(include_str!("../schema.json")).unwrap();
        let mut listed: Vec<&str> = schema["methods"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        listed.sort_unstable();
        let mut served: Vec<&str> = METHODS.to_vec();
        served.sort_unstable();
        assert_eq!(listed, served);
    }

    #[test]
    fn error_codes_are_in_schema() {
        let schema: Value = serde_json::from_str(include_str!("../schema.json")).unwrap();
        let codes = schema["errors"].as_object().unwrap();
        for c in [
            WALLET_ERROR,
            NOT_SYNCED,
            NO_KEY,
            REJECTED,
            INVALID_PARAMS,
            METHOD_NOT_FOUND,
        ] {
            assert!(
                codes.contains_key(&c.to_string()),
                "{c} missing from schema.json errors"
            );
        }
    }

    #[test]
    fn build_params_accept_the_schema_shape() {
        let v = json!({ "to": "ys1x", "amountZat": 1234, "memoHex": "6869", "fee": 10000, "minConfirmations": 2 });
        let r: BuildRequest = params_req(&v).unwrap();
        assert_eq!(r.amount_zat, 1234);
        assert_eq!(r.fee_zat, Some(10000));
        assert_eq!(r.min_confirmations, Some(2));
        let minimal: BuildRequest = params_req(&json!({ "to": "ys1x", "amountZat": 1 })).unwrap();
        assert!(minimal.fee_zat.is_none() && minimal.memo_hex.is_none());
        assert!(params_req::<BuildRequest>(&json!({ "to": "ys1x" })).is_err());
    }

    #[test]
    fn build_params_accept_the_sdk_builder_contract() {
        // packages/ycash/src/shielded/builder.ts: build {to, amountZat (decimal string), memoHex, expiryHeight?}.
        let r: BuildRequest = params_req(&json!({ "to": "ys1x", "amountZat": "1500000", "memoHex": "6869", "expiryHeight": 117 })).unwrap();
        assert_eq!(r.amount_zat, 1_500_000);
        assert_eq!(r.expiry_height, Some(117));
        assert_eq!(r.memo_hex.as_deref(), Some("6869"));
        let r: BuildRequest =
            params_req(&json!({ "to": "ys1x", "amountZat": "7", "memoHex": "" })).unwrap();
        assert!(r.expiry_height.is_none());
        for bad in ["", "01", "1.5", "-1", " 1", "1e3", "18446744073709551616"] {
            assert!(
                params_req::<BuildRequest>(&json!({ "to": "ys1x", "amountZat": bad })).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn schema_documents_the_contract_fields() {
        let schema: Value = serde_json::from_str(include_str!("../schema.json")).unwrap();
        let p = &schema["methods"]["build"]["params"];
        for k in ["to", "amountZat", "memoHex", "expiryHeight", "fee"] {
            assert!(
                p.get(k).is_some(),
                "build.params.{k} missing from schema.json"
            );
        }
        for k in ["txid", "txHex", "expiryHeight", "feeZat"] {
            assert!(
                schema["methods"]["build"]["result"].get(k).is_some(),
                "build.result.{k} missing"
            );
        }
    }
}
