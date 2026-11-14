# 🚀 Bitunix BTCUSDT Auto-Trader Bot

Bitunix Perpetual Futures (`https://www.bitunix.com/contract-trade/BTCUSDT`) ke liye automated algorithmic trading bot aur real-time Web Dashboard.

---

## ✨ Features / Khusoosiyat
1. **Live Bitunix Futures Integration:** Real-time BTCUSDT ticker, candlestick data aur official double SHA-256 authenticated API order placement.
2. **Paper Trading (Simulation Mode):** Bina kisi risk ke test karne ke liye virtual demo balance ($1,000 USDT). Live market prices par simulated orders execute karta hai.
3. **Live Trading Mode:** Bitunix ke official account par real trades automate karne ke liye API Key aur Secret Key support.
4. **Algorithmic Strategies:**
   - **RSI + EMA Momentum (Recommended):** RSI oversold/overbought bounce aur EMA9/EMA21 crossover confluences.
   - **MACD Trend Cross:** MACD histogram aur signal line cross with EMA50 filter.
   - **Bollinger Bands Mean Reversion:** Extremes par scalp trades.
5. **Built-in Risk Management:**
   - Take Profit (TP %) & Stop Loss (SL %)
   - Configurable Leverage (1x - 100x)
   - Custom Order Size (e.g. 0.001 BTC)
6. **Modern Web UI Dashboard:**
   - Real-time Chart.js interactive candlestick & EMA lines
   - Live PnL aur Active Position tracker
   - Manual 1-click Buy / Sell / Close controls
   - Real-time engine execution logs

---

## 🛠️ Files Overview
- `start.bat`: Windows ke liye one-click launcher (double click karke bot start karein).
- `app.py`: Flask Web Server aur REST API backend.
- `bot_engine.py`: Background thread jo continuously market analyze karta hai aur trades execute karta hai.
- `bitunix_client.py`: Bitunix Futures API client (Public tickers + Private signed requests).
- `indicators.py`: RSI, EMA (9, 21, 50, 200), MACD, Bollinger Bands calculations.
- `strategies.py`: Algorithmic trading entry & exit conditions.
- `config.json`: Aapki preferences aur API keys save karta hai.
- `templates/index.html`: Sleek dark-mode Web Dashboard.

---

## 🚀 How to Run / Chalane Ka Tareeqa

### Tareeqa 1: One-Click Launcher (Sab se aasan)
1. Folder `f:\trade` open karein.
2. `start.bat` par double click karein.
3. Server start ho jayega aur browser mein `http://127.0.0.1:5000` auto open ho jayega.

### Tareeqa 2: Terminal / Command Prompt
```bash
cd f:\trade
python app.py
```
Phir apne browser mein `http://127.0.0.1:5000` open karein.

---

## 🔑 Bitunix API Key Kaise Generate Karein (For Live Mode)
1. Bitunix website (`https://www.bitunix.com`) par login karein.
2. Profile icon par click karein aur **API Management** par jayein.
3. **Create API** par click karein aur permissions mein **Futures Trading** (Read & Trade) enable karein.
   *(Withdrawal permission kabi b enable mat karein - security ke liye zaroorat nahi hoti).*
4. Dashboard ke **Settings (⚙️ Gear Icon)** par click karein:
   - **Execution Mode:** `Live Bitunix` select karein.
   - **API Key** aur **Secret Key** enter karein.
   - **Save Settings** par click karein.
5. Phir **Start Bot** par click karein.

---

## ⚠️ Important Note / Ehtiyaat
- Pehle **Paper Trading (Demo)** mode mein bot ko run karein taake aap strategy aur speed ko live market mein observe kar sakein.
- Jab aap strategy ki performance se mutmaeen hon, tab hi **Live Mode** par switch karein.

