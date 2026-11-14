import threading
import time
import json
import os
from datetime import datetime
from typing import Dict, Any, List
from bitunix_client import BitunixFuturesClient
from indicators import compute_indicators
from strategies import TradingStrategy

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")
TRADES_LOG_PATH = os.path.join(os.path.dirname(__file__), "trades.json")

class AutoTradeBot:
    def __init__(self):
        self.running = False
        self.thread = None
        self.lock = threading.Lock()
        
        # Load configuration
        self.config = self.load_config()
        self.client = BitunixFuturesClient(
            api_key=self.config.get("api_key", ""),
            secret_key=self.config.get("secret_key", "")
        )
        
        # State
        self.logs: List[Dict[str, Any]] = []
        self.current_ticker = {}
        self.current_indicators = {}
        self.last_signal = {"signal": "HOLD", "reason": "Bot starting up", "confidence": 0}
        
        # Positions
        # Simulated/Paper position format:
        # { "symbol": "BTCUSDT", "side": "BUY"|"SELL", "entry_price": float, "qty": float, "tp_price": float, "sl_price": float, "time": str, "pnl": 0.0 }
        self.paper_position = None
        self.paper_balance = float(self.config.get("paper_balance", 1000.0))
        self.trade_history = self.load_trades()

    def log(self, message: str, level: str = "INFO"):
        entry = {
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "level": level,
            "message": message
        }
        with self.lock:
            self.logs.insert(0, entry)
            if len(self.logs) > 300:
                self.logs.pop()
        print(f"[{entry['time']}] [{level}] {message}")

    def load_config(self) -> Dict[str, Any]:
        default_config = {
            "api_key": "",
            "secret_key": "",
            "symbol": "BTCUSDT",
            "interval": "15m",
            "trade_mode": "paper",
            "strategy": "rsi_ema",
            "order_qty": 0.001,
            "leverage": 10,
            "take_profit_pct": 1.5,
            "stop_loss_pct": 1.0,
            "paper_balance": 1000.0,
            "check_interval_seconds": 10,
            "rsi_oversold": 32,
            "rsi_overbought": 68
        }
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                    default_config.update(cfg)
            except Exception as e:
                print("Error loading config:", e)
        return default_config

    def save_config(self, new_config: Dict[str, Any]):
        with self.lock:
            self.config.update(new_config)
            try:
                with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                    json.dump(self.config, f, indent=2)
            except Exception as e:
                self.log(f"Failed to save config: {e}", "ERROR")
                
            # Update client keys
            self.client.api_key = self.config.get("api_key", "")
            self.client.secret_key = self.config.get("secret_key", "")

    def load_trades(self) -> List[Dict[str, Any]]:
        if os.path.exists(TRADES_LOG_PATH):
            try:
                with open(TRADES_LOG_PATH, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return []
        return []

    def record_closed_trade(self, trade_data: Dict[str, Any]):
        with self.lock:
            self.trade_history.insert(0, trade_data)
            try:
                with open(TRADES_LOG_PATH, "w", encoding="utf-8") as f:
                    json.dump(self.trade_history[:100], f, indent=2)
            except Exception as e:
                self.log(f"Failed to save trade record: {e}", "ERROR")

    def start(self):
        if self.running:
            return
        self.running = True
        self.log(f"Auto-Trade Bot started in [{self.config.get('trade_mode', 'paper').upper()}] mode for {self.config.get('symbol', 'BTCUSDT')}")
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        self.log("Auto-Trade Bot stopped.")

    def _run_loop(self):
        while self.running:
            try:
                self._tick()
            except Exception as e:
                self.log(f"Unexpected error in bot loop: {e}", "ERROR")
            
            sleep_time = max(3, int(self.config.get("check_interval_seconds", 10)))
            for _ in range(sleep_time):
                if not self.running:
                    break
                time.sleep(1)

    def _tick(self):
        symbol = self.config.get("symbol", "BTCUSDT")
        interval = self.config.get("interval", "15m")
        mode = self.config.get("trade_mode", "paper").lower()

        # 1. Fetch live ticker & klines
        ticker_res = self.client.get_ticker(symbol)
        if ticker_res.get("code") == 0 and "data" in ticker_res:
            self.current_ticker = ticker_res["data"]
        
        kline_res = self.client.get_klines(symbol=symbol, interval=interval, limit=100)
        if kline_res.get("code") != 0 or not kline_res.get("data"):
            self.log(f"Failed to fetch klines from Bitunix: {kline_res.get('msg', 'Unknown')}", "WARNING")
            return

        # 2. Compute indicators
        indicators = compute_indicators(kline_res["data"])
        self.current_indicators = indicators
        current_price = indicators.get("latest_price", 0.0)
        if current_price <= 0:
            return

        # 3. Check and update existing position (Take Profit / Stop Loss)
        if mode == "paper":
            self._manage_paper_position(current_price)
        else:
            self._manage_live_position(current_price)

        # 4. Evaluate strategy
        strategy_name = self.config.get("strategy", "rsi_ema")
        signal_res = TradingStrategy.evaluate(strategy_name, indicators, self.config)
        self.last_signal = signal_res

        # 5. Execute new trade if no position is active
        has_active_pos = (self.paper_position is not None) if mode == "paper" else self._has_live_position()
        if not has_active_pos and signal_res["signal"] in ["BUY", "SELL"]:
            if mode == "paper":
                self._open_paper_position(signal_res["signal"], current_price, signal_res["reason"])
            else:
                self._open_live_position(signal_res["signal"], current_price, signal_res["reason"])

    # ==================== PAPER TRADING ENGINE ====================
    def _open_paper_position(self, side: str, price: float, reason: str):
        qty = float(self.config.get("order_qty", 0.001))
        tp_pct = float(self.config.get("take_profit_pct", 1.5)) / 100.0
        sl_pct = float(self.config.get("stop_loss_pct", 1.0)) / 100.0
        leverage = float(self.config.get("leverage", 10))

        if side == "BUY": # LONG
            tp_price = round(price * (1.0 + tp_pct), 2)
            sl_price = round(price * (1.0 - sl_pct), 2)
        else: # SHORT
            tp_price = round(price * (1.0 - tp_pct), 2)
            sl_price = round(price * (1.0 + sl_pct), 2)

        self.paper_position = {
            "symbol": self.config.get("symbol", "BTCUSDT"),
            "side": side,
            "entry_price": price,
            "current_price": price,
            "qty": qty,
            "leverage": leverage,
            "tp_price": tp_price,
            "sl_price": sl_price,
            "open_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "pnl": 0.0,
            "pnl_pct": 0.0
        }
        self.log(f"[PAPER] Opened {side} position of {qty} BTC @ ${price:,.2f} | TP: ${tp_price:,.2f} | SL: ${sl_price:,.2f} | Reason: {reason}", "SUCCESS")

    def _manage_paper_position(self, current_price: float):
        if not self.paper_position:
            return

        pos = self.paper_position
        pos["current_price"] = current_price
        entry = pos["entry_price"]
        side = pos["side"]
        qty = pos["qty"]
        leverage = pos["leverage"]

        if side == "BUY":
            price_diff = current_price - entry
            pnl_pct = (price_diff / entry) * 100.0 * leverage
            hit_tp = current_price >= pos["tp_price"]
            hit_sl = current_price <= pos["sl_price"]
        else:
            price_diff = entry - current_price
            pnl_pct = (price_diff / entry) * 100.0 * leverage
            hit_tp = current_price <= pos["tp_price"]
            hit_sl = current_price >= pos["sl_price"]

        pnl_usd = (price_diff * qty)
        pos["pnl"] = round(pnl_usd, 2)
        pos["pnl_pct"] = round(pnl_pct, 2)

        if hit_tp or hit_sl:
            close_reason = "TAKE PROFIT HIT 🎯" if hit_tp else "STOP LOSS HIT 🛑"
            self.paper_balance += pnl_usd
            trade_record = {
                "id": str(int(time.time() * 1000)),
                "mode": "PAPER",
                "symbol": pos["symbol"],
                "side": side,
                "entry_price": entry,
                "exit_price": current_price,
                "qty": qty,
                "leverage": leverage,
                "pnl": round(pnl_usd, 2),
                "pnl_pct": round(pnl_pct, 2),
                "reason": close_reason,
                "open_time": pos["open_time"],
                "close_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
            self.record_closed_trade(trade_record)
            self.log(f"[PAPER] Closed {side} @ ${current_price:,.2f} -> {close_reason} | PnL: ${pnl_usd:+.2f} ({pnl_pct:+.2f}%)", "INFO" if hit_tp else "WARNING")
            self.paper_position = None

    def manual_close_paper_position(self):
        if not self.paper_position:
            return False
        curr_price = self.paper_position["current_price"]
        pnl = self.paper_position["pnl"]
        self.paper_balance += pnl
        trade_record = {
            "id": str(int(time.time() * 1000)),
            "mode": "PAPER",
            "symbol": self.paper_position["symbol"],
            "side": self.paper_position["side"],
            "entry_price": self.paper_position["entry_price"],
            "exit_price": curr_price,
            "qty": self.paper_position["qty"],
            "leverage": self.paper_position["leverage"],
            "pnl": pnl,
            "pnl_pct": self.paper_position["pnl_pct"],
            "reason": "MANUAL CLOSE ✋",
            "open_time": self.paper_position["open_time"],
            "close_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        self.record_closed_trade(trade_record)
        self.log(f"[PAPER] Manually closed position | PnL: ${pnl:+.2f}", "INFO")
        self.paper_position = None
        return True

    # ==================== LIVE BITUNIX TRADING ENGINE ====================
    def _has_live_position(self) -> bool:
        if not self.client.api_key or not self.client.secret_key:
            return False
        res = self.client.get_positions(self.config.get("symbol", "BTCUSDT"))
        if res.get("code") == 0 and res.get("data"):
            # Check if any position has active quantity > 0
            for p in res["data"]:
                if float(p.get("qty", 0)) > 0:
                    return True
        return False

    def _open_live_position(self, side: str, price: float, reason: str):
        if not self.client.api_key or not self.client.secret_key:
            self.log("[LIVE] Cannot open trade: Bitunix API Key/Secret is missing in Settings!", "ERROR")
            return

        symbol = self.config.get("symbol", "BTCUSDT")
        qty = float(self.config.get("order_qty", 0.001))
        tp_pct = float(self.config.get("take_profit_pct", 1.5)) / 100.0
        sl_pct = float(self.config.get("stop_loss_pct", 1.0)) / 100.0

        if side == "BUY": # Long
            tp_price = round(price * (1.0 + tp_pct), 2)
            sl_price = round(price * (1.0 - sl_pct), 2)
        else: # Short
            tp_price = round(price * (1.0 - tp_pct), 2)
            sl_price = round(price * (1.0 + sl_pct), 2)

        self.log(f"[LIVE] Placing {side} Market Order on Bitunix: {qty} {symbol} @ ~${price:,.2f}...", "INFO")
        res = self.client.place_order(
            symbol=symbol,
            qty=qty,
            side=side,
            trade_side="OPEN",
            order_type="MARKET",
            tp_price=tp_price,
            sl_price=sl_price
        )

        if res.get("code") == 0:
            self.log(f"[LIVE] ORDER PLACED! {side} {qty} {symbol} | TP: {tp_price} | SL: {sl_price} | Res: {res.get('data')}", "SUCCESS")
        else:
            self.log(f"[LIVE] Order Failed: {res.get('msg')} (Code: {res.get('code')})", "ERROR")

    def _manage_live_position(self, current_price: float):
        # In live mode with Bitunix, the order has server-side TP/SL attached.
        # We can poll positions to monitor active status.
        pass

    def get_status(self) -> Dict[str, Any]:
        """Provides full real-time snapshot for Web UI"""
        with self.lock:
            mode = self.config.get("trade_mode", "paper").lower()
            live_positions = []
            live_balance = None
            if mode == "live" and self.client.api_key and self.client.secret_key:
                acc_res = self.client.get_account("USDT")
                if acc_res.get("code") == 0:
                    live_balance = acc_res.get("data")
                pos_res = self.client.get_positions(self.config.get("symbol", "BTCUSDT"))
                if pos_res.get("code") == 0 and pos_res.get("data"):
                    live_positions = pos_res.get("data")

            return {
                "running": self.running,
                "config": self.config,
                "ticker": self.current_ticker,
                "indicators": self.current_indicators,
                "last_signal": self.last_signal,
                "trade_mode": mode,
                "paper_balance": round(self.paper_balance, 2),
                "paper_position": self.paper_position,
                "live_positions": live_positions,
                "live_balance": live_balance,
                "recent_trades": self.trade_history[:10],
                "logs": self.logs[:50]
            }

