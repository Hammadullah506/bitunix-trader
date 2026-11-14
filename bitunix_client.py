import hashlib
import json
import time
import uuid
from urllib.parse import urlencode
import requests

class BitunixFuturesClient:
    """
    Official API Client for Bitunix Futures (Perpetual USDT-M)
    Base URL: https://fapi.bitunix.com
    """
    def __init__(self, api_key: str = "", secret_key: str = "", base_url: str = "https://fapi.bitunix.com"):
        self.api_key = api_key or ""
        self.secret_key = secret_key or ""
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "BitunixAutoTrader/1.0"
        })

    def _sha256_hex(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _request(self, method: str, endpoint: str, params: dict = None, data: dict = None, is_private: bool = False):
        url = f"{self.base_url}{endpoint}"
        
        # 1. Format URL Query params & Signature Query string
        url_query_string = ""
        sign_query_string = ""
        if params:
            sorted_params = sorted(params.items())
            # For signature: key1value1key2value2 (no delimiters)
            sign_query_string = "".join(f"{k}{v}" for k, v in sorted_params)
            # For HTTP URL: standard urlencode
            url_query_string = urlencode(sorted_params)

        # 2. Format Body
        body_str = ""
        if data is not None:
            # Compact JSON without whitespace
            body_str = json.dumps(data, separators=(",", ":"), ensure_ascii=True)

        headers = {
            "Content-Type": "application/json",
            "language": "en-US"
        }

        if is_private:
            if not self.api_key or not self.secret_key:
                return {"code": -1, "msg": "API Key or Secret Key is not configured."}
            
            nonce = uuid.uuid4().hex[:32]
            timestamp = str(int(time.time() * 1000))

            # Bitunix Double SHA-256 scheme:
            # digestInput = nonce + timestamp + apiKey + sign_query_string + body_str
            digest_input = f"{nonce}{timestamp}{self.api_key}{sign_query_string}{body_str}"
            first_digest = self._sha256_hex(digest_input)
            final_signature = self._sha256_hex(first_digest + self.secret_key)

            headers.update({
                "api-key": self.api_key,
                "sign": final_signature,
                "nonce": nonce,
                "timestamp": timestamp
            })

        try:
            req_url = f"{url}?{url_query_string}" if url_query_string else url
            if method.upper() == "GET":
                resp = self.session.get(req_url, headers=headers, timeout=10)
            elif method.upper() == "POST":
                resp = self.session.post(req_url, headers=headers, data=body_str if body_str else None, timeout=10)
            elif method.upper() == "DELETE":
                resp = self.session.delete(req_url, headers=headers, data=body_str if body_str else None, timeout=10)
            else:
                return {"code": -1, "msg": f"Unsupported method: {method}"}

            return resp.json()
        except requests.exceptions.RequestException as e:
            return {"code": -1, "msg": f"Network error: {str(e)}"}
        except Exception as e:
            return {"code": -1, "msg": f"Unexpected error: {str(e)}"}

    # ==================== PUBLIC ENDPOINTS ====================
    def get_trading_pairs(self):
        """Fetch list of all futures trading pairs"""
        return self._request("GET", "/api/v1/futures/market/trading_pairs")

    def get_ticker(self, symbol: str = "BTCUSDT"):
        """Fetch 24h ticker for symbol"""
        params = {"symbol": symbol}
        res = self._request("GET", "/api/v1/futures/market/tickers", params=params)
        if res.get("code") == 0 and "data" in res:
            for item in res["data"]:
                if item.get("symbol") == symbol:
                    return {"code": 0, "data": item}
        return res

    def get_klines(self, symbol: str = "BTCUSDT", interval: str = "15m", limit: int = 100):
        """Fetch historical candlestick data"""
        params = {
            "interval": interval,
            "limit": limit,
            "symbol": symbol
        }
        return self._request("GET", "/api/v1/futures/market/kline", params=params)

    def get_orderbook(self, symbol: str = "BTCUSDT", limit: int = 20):
        """Fetch orderbook depth"""
        params = {"limit": limit, "symbol": symbol}
        return self._request("GET", "/api/v1/futures/market/depth", params=params)

    # ==================== PRIVATE ENDPOINTS ====================
    def get_account(self, margin_coin: str = "USDT"):
        """Fetch futures account balance and margin details"""
        params = {"marginCoin": margin_coin}
        return self._request("GET", "/api/v1/futures/account", params=params, is_private=True)

    def get_positions(self, symbol: str = "BTCUSDT"):
        """Fetch active/pending positions"""
        params = {"symbol": symbol} if symbol else {}
        return self._request("GET", "/api/v1/futures/position/get_pending_positions", params=params, is_private=True)

    def place_order(self, symbol: str, qty: float, side: str, trade_side: str = "OPEN",
                    order_type: str = "MARKET", price: float = None,
                    tp_price: float = None, sl_price: float = None):
        """
        Place futures order.
        side: BUY (for Long) or SELL (for Short)
        trade_side: OPEN or CLOSE
        order_type: MARKET or LIMIT
        """
        payload = {
            "effect": "GTC",
            "orderType": order_type.upper(),
            "qty": str(qty),
            "side": side.upper(),
            "symbol": symbol,
            "tradeSide": trade_side.upper()
        }
        if order_type.upper() == "LIMIT" and price:
            payload["price"] = str(price)

        if tp_price:
            payload["tpOrderType"] = "MARKET"
            payload["tpPrice"] = str(tp_price)
            payload["tpStopType"] = "LAST_PRICE"

        if sl_price:
            payload["slOrderType"] = "MARKET"
            payload["slPrice"] = str(sl_price)
            payload["slStopType"] = "LAST_PRICE"

        return self._request("POST", "/api/v1/futures/trade/place_order", data=payload, is_private=True)

    def close_position(self, symbol: str, position_id: str, qty: float, side: str):
        """
        Close an existing position.
        """
        payload = {
            "orderType": "MARKET",
            "positionId": str(position_id),
            "qty": str(qty),
            "side": side.upper(),
            "symbol": symbol,
            "tradeSide": "CLOSE"
        }
        return self._request("POST", "/api/v1/futures/trade/place_order", data=payload, is_private=True)
