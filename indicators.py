from typing import List, Dict, Tuple

def calculate_ema(prices: List[float], period: int) -> List[float]:
    """Calculate Exponential Moving Average (EMA) for a series of prices."""
    if len(prices) < period:
        return [prices[-1] if prices else 0.0] * len(prices)
    
    multiplier = 2 / (period + 1)
    ema_values = []
    # Initial SMA for seed
    sma = sum(prices[:period]) / period
    ema_values.extend([sma] * period)
    
    current_ema = sma
    for price in prices[period:]:
        current_ema = (price - current_ema) * multiplier + current_ema
        ema_values.append(current_ema)
        
    return ema_values

def calculate_rsi(prices: List[float], period: int = 14) -> List[float]:
    """Calculate Relative Strength Index (RSI) using Wilder's smoothing method."""
    if len(prices) <= period:
        return [50.0] * len(prices)
    
    deltas = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    
    rsi_values = [50.0] * (period)
    
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    
    if avg_loss == 0:
        rsi_values.append(100.0)
    else:
        rs = avg_gain / avg_loss
        rsi_values.append(100.0 - (100.0 / (1.0 + rs)))
        
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        
        if avg_loss == 0:
            rsi = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi = 100.0 - (100.0 / (1.0 + rs))
        rsi_values.append(rsi)
        
    return rsi_values

def calculate_macd(prices: List[float], fast_period: int = 12, slow_period: int = 26, signal_period: int = 9) -> Tuple[List[float], List[float], List[float]]:
    """Calculate MACD Line, Signal Line, and Histogram."""
    if len(prices) < slow_period + signal_period:
        zeros = [0.0] * len(prices)
        return zeros, zeros, zeros
    
    fast_ema = calculate_ema(prices, fast_period)
    slow_ema = calculate_ema(prices, slow_period)
    
    macd_line = [f - s for f, s in zip(fast_ema, slow_ema)]
    signal_line = calculate_ema(macd_line, signal_period)
    hist = [m - s for m, s in zip(macd_line, signal_line)]
    
    return macd_line, signal_line, hist

def calculate_bollinger_bands(prices: List[float], period: int = 20, std_dev_multiplier: float = 2.0) -> Tuple[List[float], List[float], List[float]]:
    """Calculate Bollinger Bands: (Upper, Middle, Lower)."""
    if len(prices) < period:
        p = prices[-1] if prices else 0.0
        return [p]*len(prices), [p]*len(prices), [p]*len(prices)
        
    upper = []
    middle = []
    lower = []
    
    for i in range(len(prices)):
        if i < period - 1:
            upper.append(prices[i])
            middle.append(prices[i])
            lower.append(prices[i])
            continue
        window = prices[i - period + 1 : i + 1]
        mean = sum(window) / period
        variance = sum((x - mean) ** 2 for x in window) / period
        std_dev = variance ** 0.5
        
        middle.append(mean)
        upper.append(mean + (std_dev * std_dev_multiplier))
        lower.append(mean - (std_dev * std_dev_multiplier))
        
    return upper, middle, lower

def compute_indicators(klines: List[Dict]) -> Dict:
    """
    Given raw Bitunix klines (newest first or oldest first),
    standardizes them chronologically and calculates all major indicators.
    """
    if not klines:
        return {}
        
    # Sort chronologically by time
    sorted_klines = sorted(klines, key=lambda x: int(x.get("time", 0)))
    
    closes = [float(k["close"]) for k in sorted_klines]
    highs = [float(k["high"]) for k in sorted_klines]
    lows = [float(k["low"]) for k in sorted_klines]
    opens = [float(k["open"]) for k in sorted_klines]
    times = [int(k["time"]) for k in sorted_klines]
    
    rsi = calculate_rsi(closes, period=14)
    ema9 = calculate_ema(closes, period=9)
    ema21 = calculate_ema(closes, period=21)
    ema50 = calculate_ema(closes, period=50)
    ema200 = calculate_ema(closes, period=200 if len(closes) >= 200 else len(closes) - 1)
    macd_line, signal_line, macd_hist = calculate_macd(closes)
    bb_upper, bb_mid, bb_lower = calculate_bollinger_bands(closes, period=20)
    
    latest_price = closes[-1]
    
    return {
        "prices": closes,
        "times": times,
        "latest_price": latest_price,
        "current_rsi": round(rsi[-1], 2),
        "prev_rsi": round(rsi[-2], 2) if len(rsi) > 1 else round(rsi[-1], 2),
        "ema9": round(ema9[-1], 2),
        "ema21": round(ema21[-1], 2),
        "ema50": round(ema50[-1], 2),
        "ema200": round(ema200[-1], 2),
        "macd": round(macd_line[-1], 2),
        "macd_signal": round(signal_line[-1], 2),
        "macd_hist": round(macd_hist[-1], 2),
        "bb_upper": round(bb_upper[-1], 2),
        "bb_mid": round(bb_mid[-1], 2),
        "bb_lower": round(bb_lower[-1], 2),
        "candles": [
            {
                "time": times[i],
                "open": opens[i],
                "high": highs[i],
                "low": lows[i],
                "close": closes[i]
            } for i in range(len(sorted_klines))
        ]
    }

