use serde::{Deserialize, Serialize};

/// Aggregated trade from Binance WebSocket
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggTrade {
    /// Event type (always "aggTrade")
    #[serde(rename = "e")]
    pub event_type: String,
    /// Event time
    #[serde(rename = "E")]
    pub event_time: u64,
    /// Symbol
    #[serde(rename = "s")]
    pub symbol: String,
    /// Aggregate trade ID
    #[serde(rename = "a")]
    pub agg_trade_id: u64,
    /// Price
    #[serde(rename = "p")]
    pub price: String,
    /// Quantity
    #[serde(rename = "q")]
    pub quantity: String,
    /// First trade ID
    #[serde(rename = "f")]
    pub first_trade_id: u64,
    /// Last trade ID
    #[serde(rename = "l")]
    pub last_trade_id: u64,
    /// Trade time
    #[serde(rename = "T")]
    pub trade_time: u64,
    /// Is the buyer the market maker?
    #[serde(rename = "m")]
    pub is_buyer_maker: bool,
}

/// OHLCV Kline/Candlestick data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Kline {
    pub open_time: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub close_time: u64,
    pub quote_volume: f64,
    pub trades: u32,
    pub taker_buy_base: f64,
    pub taker_buy_quote: f64,
}

/// Order book level
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBookLevel {
    pub price: f64,
    pub quantity: f64,
}

/// Order book snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBook {
    pub bids: Vec<OrderBookLevel>,
    pub asks: Vec<OrderBookLevel>,
    pub timestamp: u64,
}

impl OrderBook {
    /// Best bid price
    pub fn best_bid(&self) -> f64 {
        self.bids.first().map(|l| l.price).unwrap_or(0.0)
    }

    /// Best ask price
    pub fn best_ask(&self) -> f64 {
        self.asks.first().map(|l| l.price).unwrap_or(0.0)
    }

    /// Spread as percentage of mid price
    pub fn spread_pct(&self) -> f64 {
        let bid = self.best_bid();
        let ask = self.best_ask();
        if bid <= 0.0 || ask <= 0.0 { return 0.0; }
        let mid = (bid + ask) / 2.0;
        (ask - bid) / mid
    }
}
