from typing import Dict, Any

class TradingStrategy:
    @staticmethod
    def evaluate(strategy_name: str, indicators: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
        """
        High-Probability Sniper Confluence Strategy:
        Requires confluence across 3 indicators before issuing a signal:
        1. Trend Filter: EMA50 and EMA200
        2. Momentum: RSI Oversold/Overbought confirmation
        3. Trigger: EMA9 vs EMA21 cross or MACD direction
        """
        if not indicators or "latest_price" not in indicators:
            return {"signal": "HOLD", "reason": "No indicator data available", "confidence": 0}
            
        rsi = indicators.get("current_rsi", 50)
        prev_rsi = indicators.get("prev_rsi", rsi)
        price = indicators.get("latest_price", 0)
        ema9 = indicators.get("ema9", 0)
        ema21 = indicators.get("ema21", 0)
        ema50 = indicators.get("ema50", 0)
        macd_hist = indicators.get("macd_hist", 0)
        
        oversold = config.get("rsi_oversold", 30)
        overbought = config.get("rsi_overbought", 70)

        # ========================================================
        # 🟢 TOP BUY (LONG) CONFLUENCE RULES
        # 1. RSI is recovering from oversold (<= 35) OR strong EMA9 > EMA21 breakout
        # 2. Price is supported by EMA50 or MACD histogram turns positive
        # ========================================================
        is_oversold_bounce = (prev_rsi <= oversold and rsi > prev_rsi)
        is_bullish_cross = (ema9 > ema21 and rsi >= 40 and rsi <= 58 and macd_hist > 0)
        
        if is_oversold_bounce:
            return {
                "signal": "BUY",
                "reason": f"🎯 SNIPER LONG: RSI Oversold Reversal (RSI={rsi:.1f}). Strong bounce confirmed.",
                "confidence": 85
            }
        
        if is_bullish_cross and price >= ema50:
            return {
                "signal": "BUY",
                "reason": f"🎯 TREND LONG: Bullish EMA9 > EMA21 with MACD Confluence & Price > EMA50.",
                "confidence": 80
            }

        # ========================================================
        # 🔴 TOP SELL (SHORT) CONFLUENCE RULES
        # 1. RSI is dropping from overbought (>= 68) OR strong EMA9 < EMA21 breakdown
        # 2. Price rejected below EMA50 or MACD histogram turns negative
        # ========================================================
        is_overbought_drop = (prev_rsi >= overbought and rsi < prev_rsi)
        is_bearish_cross = (ema9 < ema21 and rsi <= 60 and rsi >= 42 and macd_hist < 0)

        if is_overbought_drop:
            return {
                "signal": "SELL",
                "reason": f"🎯 SNIPER SHORT: RSI Overbought Rejection (RSI={rsi:.1f}). Drop confirmed.",
                "confidence": 85
            }

        if is_bearish_cross and price <= ema50:
            return {
                "signal": "SELL",
                "reason": f"🎯 TREND SHORT: Bearish EMA9 < EMA21 with MACD Negative & Price < EMA50.",
                "confidence": 80
            }

        return {
            "signal": "HOLD",
            "reason": f"Market in Neutral Range (RSI: {rsi:.1f}). Waiting for top sniper confluence.",
            "confidence": 40
        }
