use reqwest;
use serde_json::Value;
use super::types::Kline;

/// Fetch historical klines from MEXC futures REST API.
///
/// Endpoint: `https://contract.mexc.com/api/v1/contract/kline/{symbol}?interval={interval}`
///
/// `symbol` should be in MEXC contract format (e.g. "BTC_USDT").
/// `interval` accepts MEXC labels: `Min1`, `Min5`, `Min15`, `Min30`, `Min60`, `Hour4`, `Hour8`, `Day1`, `Week1`, `Month1`.
/// `limit` truncates to the most recent N candles (MEXC returns up to ~2000 by default).
///
/// MEXC response format (parallel arrays):
/// ```json
/// {
///   "success": true,
///   "code": 0,
///   "data": {
///     "time":   [t1, t2, ...],
///     "open":   [o1, o2, ...],
///     "close":  [c1, c2, ...],
///     "high":   [h1, h2, ...],
///     "low":    [l1, l2, ...],
///     "vol":    [v1, v2, ...],
///     "amount": [a1, a2, ...]
///   }
/// }
/// ```
pub async fn fetch_mexc_klines(symbol: &str, interval: &str, limit: u32) -> Result<Vec<Kline>, String> {
    let mexc_interval = normalize_interval(interval);
    let url = format!(
        "https://contract.mexc.com/api/v1/contract/kline/{}?interval={}",
        symbol.to_uppercase(),
        mexc_interval
    );

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch MEXC klines: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("MEXC API error: {}", response.status()));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse MEXC klines: {}", e))?;

    if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!(
            "MEXC API returned non-success: {:?}",
            body.get("code")
        ));
    }

    let data = body.get("data").ok_or("MEXC response missing `data`")?;

    let times = data.get("time").and_then(|v| v.as_array()).ok_or("missing time")?;
    let opens = data.get("open").and_then(|v| v.as_array()).ok_or("missing open")?;
    let closes = data.get("close").and_then(|v| v.as_array()).ok_or("missing close")?;
    let highs = data.get("high").and_then(|v| v.as_array()).ok_or("missing high")?;
    let lows = data.get("low").and_then(|v| v.as_array()).ok_or("missing low")?;
    let vols = data.get("vol").and_then(|v| v.as_array()).ok_or("missing vol")?;
    let amounts = data.get("amount").and_then(|v| v.as_array());

    let n = times.len().min(opens.len()).min(closes.len()).min(highs.len()).min(lows.len()).min(vols.len());

    // Compute interval ms for close_time (open_time + interval - 1ms)
    let interval_ms = interval_to_ms(&mexc_interval);

    let mut klines: Vec<Kline> = Vec::with_capacity(n);
    for i in 0..n {
        // MEXC returns time as seconds (Unix epoch); convert to ms for consistency with rest of system
        let open_time_s = times[i].as_u64().unwrap_or(0);
        let open_time_ms = open_time_s.saturating_mul(1000);

        let kline = Kline {
            open_time: open_time_ms,
            open: opens[i].as_f64().unwrap_or(0.0),
            high: highs[i].as_f64().unwrap_or(0.0),
            low: lows[i].as_f64().unwrap_or(0.0),
            close: closes[i].as_f64().unwrap_or(0.0),
            volume: vols[i].as_f64().unwrap_or(0.0),
            close_time: open_time_ms.saturating_add(interval_ms.saturating_sub(1)),
            quote_volume: amounts.and_then(|a| a.get(i)).and_then(|v| v.as_f64()).unwrap_or(0.0),
            trades: 0,             // MEXC contract endpoint doesn't expose trade count
            taker_buy_base: 0.0,   // Not exposed at this endpoint
            taker_buy_quote: 0.0,  // Not exposed at this endpoint
        };
        klines.push(kline);
    }

    // Truncate to most recent `limit`
    if klines.len() > limit as usize {
        let start = klines.len() - limit as usize;
        klines = klines.split_off(start);
    }

    Ok(klines)
}

/// Translate generic interval labels (e.g. "1m", "5m", "1h") into MEXC's labels.
/// Pass-through if already in MEXC format.
fn normalize_interval(interval: &str) -> String {
    match interval {
        "1m" | "Min1"   => "Min1".into(),
        "5m" | "Min5"   => "Min5".into(),
        "15m" | "Min15" => "Min15".into(),
        "30m" | "Min30" => "Min30".into(),
        "1h" | "Min60" | "Hour1" => "Min60".into(),
        "4h" | "Hour4"  => "Hour4".into(),
        "8h" | "Hour8"  => "Hour8".into(),
        "1d" | "Day1"   => "Day1".into(),
        "1w" | "Week1"  => "Week1".into(),
        "1M" | "Month1" => "Month1".into(),
        other => other.to_string(),
    }
}

fn interval_to_ms(interval: &str) -> u64 {
    match interval {
        "Min1"   => 60_000,
        "Min5"   => 5 * 60_000,
        "Min15"  => 15 * 60_000,
        "Min30"  => 30 * 60_000,
        "Min60"  => 60 * 60_000,
        "Hour4"  => 4 * 60 * 60_000,
        "Hour8"  => 8 * 60 * 60_000,
        "Day1"   => 24 * 60 * 60_000,
        "Week1"  => 7 * 24 * 60 * 60_000,
        "Month1" => 30 * 24 * 60 * 60_000,
        _ => 60_000,
    }
}

// ─── Backwards-compat alias ────────────────────────────────────────────────
/// Deprecated: kept so callers using the old name still compile.
#[deprecated(note = "Use fetch_mexc_klines instead. fetch_binance_klines now hits MEXC futures.")]
pub async fn fetch_binance_klines(symbol: &str, interval: &str, limit: u32) -> Result<Vec<Kline>, String> {
    fetch_mexc_klines(symbol, interval, limit).await
}
