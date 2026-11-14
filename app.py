from flask import Flask, render_template, jsonify, request
from bot_engine import AutoTradeBot
import os

app = Flask(__name__, template_folder="templates")
bot = AutoTradeBot()

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/status", methods=["GET"])
def get_status():
    return jsonify(bot.get_status())

@app.route("/api/config", methods=["GET"])
def get_config():
    # Hide full secret key in response for security
    cfg = dict(bot.config)
    if cfg.get("secret_key"):
        cfg["secret_key"] = cfg["secret_key"][:4] + "********" + cfg["secret_key"][-4:]
    return jsonify(cfg)

@app.route("/api/config", methods=["POST"])
def update_config():
    data = request.get_json() or {}
    # Keep secret key if user left it blank or masked
    if "secret_key" in data and ("****" in data["secret_key"] or not data["secret_key"]):
        del data["secret_key"]
    bot.save_config(data)
    bot.log("Configuration updated via Web Dashboard", "INFO")
    return jsonify({"code": 0, "msg": "Config saved successfully"})

@app.route("/api/start", methods=["POST"])
def start_bot():
    bot.start()
    return jsonify({"code": 0, "msg": "Bot started"})

@app.route("/api/stop", methods=["POST"])
def stop_bot():
    bot.stop()
    return jsonify({"code": 0, "msg": "Bot stopped"})

@app.route("/api/close_position", methods=["POST"])
def close_position():
    mode = bot.config.get("trade_mode", "paper").lower()
    if mode == "paper":
        success = bot.manual_close_paper_position()
        if success:
            return jsonify({"code": 0, "msg": "Paper position closed successfully."})
        return jsonify({"code": -1, "msg": "No active paper position to close."})
    else:
        # Live position close
        symbol = bot.config.get("symbol", "BTCUSDT")
        positions = bot.client.get_positions(symbol)
        if positions.get("code") == 0 and positions.get("data"):
            closed_any = False
            for p in positions["data"]:
                pos_id = p.get("positionId")
                qty = p.get("qty")
                side = "SELL" if p.get("side") == "LONG" else "BUY"
                if pos_id and float(qty) > 0:
                    bot.client.close_position(symbol, pos_id, qty, side)
                    closed_any = True
            if closed_any:
                return jsonify({"code": 0, "msg": "Close order sent to Bitunix."})
        return jsonify({"code": -1, "msg": "No active live positions found on Bitunix."})

@app.route("/api/manual_trade", methods=["POST"])
def manual_trade():
    data = request.get_json() or {}
    side = data.get("side", "BUY").upper()
    mode = bot.config.get("trade_mode", "paper").lower()
    price = bot.current_indicators.get("latest_price", 0.0)
    
    if price <= 0:
        # Fallback to ticker
        ticker = bot.client.get_ticker(bot.config.get("symbol", "BTCUSDT"))
        if ticker.get("code") == 0 and "data" in ticker:
            price = float(ticker["data"].get("lastPrice", 0))

    if price <= 0:
        return jsonify({"code": -1, "msg": "Could not determine current BTC price."})

    if mode == "paper":
        if bot.paper_position is not None:
            return jsonify({"code": -1, "msg": "A position is already active. Close it before opening another."})
        bot._open_paper_position(side, price, "Manual User Trigger 🚀")
        return jsonify({"code": 0, "msg": f"Manual {side} paper trade executed @ ${price:,.2f}"})
    else:
        bot._open_live_position(side, price, "Manual User Trigger 🚀")
        return jsonify({"code": 0, "msg": f"Manual {side} live order sent to Bitunix @ ~${price:,.2f}"})

if __name__ == "__main__":
    print("\n" + "="*60)
    print("🚀 Bitunix BTCUSDT Auto-Trader Server Starting...")
    print("👉 Open your browser at: http://127.0.0.1:5000")
    print("="*60 + "\n")
    # Initial status fetch so indicators are ready immediately
    try:
        bot._tick()
    except Exception as e:
        print("Initial tick error:", e)
    app.run(host="0.0.0.0", port=5000, debug=False)

