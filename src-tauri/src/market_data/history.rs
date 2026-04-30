use reqwest;
use serde_json::Value;
use super::types::Kline;

pub async fn fetch_binance_klines(symbol: &str, interval: &str, limit: u32) -> Result<Vec<Kline>, String> {
    let url = format!(
        "https://api.binance.com/api/v3/klines?symbol={}&interval={}&limit={}",
        symbol.to_uppercase(),
        interval,
        limit
    );

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch klines: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Binance API error: {}", response.status()));
    }

    let raw_data: Vec<Vec<Value>> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse klines: {}", e))?;

    let klines = raw_data
        .into_iter()
        .filter_map(|item| {
            if item.len() < 11 { return None; }
            
            Some(Kline {
                open_time: item[0].as_u64().unwrap_or(0),
                open: item[1].as_str()?.parse().ok()?,
                high: item[2].as_str()?.parse().ok()?,
                low: item[3].as_str()?.parse().ok()?,
                close: item[4].as_str()?.parse().ok()?,
                volume: item[5].as_str()?.parse().ok()?,
                close_time: item[6].as_u64().unwrap_or(0),
                quote_volume: item[7].as_str()?.parse().ok()?,
                trades: item[8].as_u64()? as u32,
                taker_buy_base: item[9].as_str()?.parse().ok()?,
                taker_buy_quote: item[10].as_str()?.parse().ok()?,
            })
        })
        .collect();

    Ok(klines)
}
