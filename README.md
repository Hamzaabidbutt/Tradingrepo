# 📡 FlowSight — Smart-Money Flow Terminal

Live market-analysis dashboard for **UNIUSDT** and **ORDIUSDT** (Binance USDT-M Futures).
It reads order flow and market structure in real time, explains *why* price is moving in
plain language, and produces confluence-based trade signals with entry, stop and targets.

**Live site:** https://hamzaabidbutt.github.io/Tradingrepo/

## What it shows on the chart

| Layer | Meaning |
|---|---|
| **Order blocks** (green/red zones) | The last opposite candle before an impulsive structure break — where smart money likely positioned. Zones that get retested and defended are marked **✓ respected**. |
| **FVGs** (blue/amber zones) | Fair value gaps — 3-candle imbalances that price often returns to fill. |
| **Liquidity** (dashed lines) | Equal highs/lows and swing extremes where stop-losses cluster. |
| **HUNT markers** | Liquidity hunts — a wick sweeps stops beyond a level, then price snaps back. |
| **BOS / CHoCH arrows** | Break of Structure (trend continuation) and Change of Character (early reversal). |
| **ABS markers** | Absorption — heavy aggressive volume that fails to move price (effort vs. result). |
| **CVD DIV** | Delta divergence — price and cumulative delta disagree, momentum is drying up. |
| **ENTRY / STOP / TARGET lines** | The current signal's trade plan, anchored to zones and liquidity pools. |

Sub-panes: **volume**, **delta volume + CVD** (aggressive buys minus sells, per candle and
cumulative), and **liquidations** (blue up = shorts liquidated, amber down = longs liquidated).

## How the signal works

Nine weighted factors are scored on every candle: market trend, BOS/CHoCH, order-block
retest, FVG, liquidity sweep, delta flow + CVD divergence, liquidation bursts (who got
rekt), absorption, and funding-rate extremes. When enough factors agree the dashboard
prints **LONG / SHORT** with a **confluence %**, plus entry zone, stop (beyond the swept
level), and targets at the next opposite liquidity pools. Every contributing factor is
listed in the side panel, and the **live reasoning feed** narrates each event as it happens
("liquidity swept below X, $Y longs liquidated, delta flipping — watch for reversal").

> ⚠️ **Honesty note:** no indicator stack can be "90% right." The confluence % measures how
> strongly independent signals agree — it is a probability aid for your own decision-making,
> not financial advice and not a guarantee.

## Tech

- Pure static site — no backend, no build step. Data comes straight from Binance's public
  REST + WebSocket API in your browser (klines with taker-buy volume for historical delta,
  `aggTrade` for live delta, `forceOrder` for liquidations, funding/OI polled every minute).
- [TradingView lightweight-charts v5](https://github.com/tradingview/lightweight-charts)
  (vendored) with a custom canvas primitive for zone rendering.
- If Binance is unreachable from your network the site falls back to clearly-labeled
  **demo data** so the tool still renders.
- Deployed automatically to GitHub Pages on every push to `main`.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```
