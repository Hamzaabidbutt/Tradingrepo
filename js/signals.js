// Confluence signal engine: combines analysis results, live delta and
// liquidation flow into a LONG / SHORT / WAIT signal with a confidence
// score, entry zone, stop and targets. Confidence = share of weighted
// factors agreeing — an honest measure, not a guarantee.
(function (global) {
  const CFG = (typeof window !== 'undefined' ? window.CFG : global.CFG);

  // ctx: { candles, analysis, liq: {long, short, recentLong, recentShort}, funding }
  function computeSignal(ctx) {
    const { candles, analysis } = ctx;
    if (!analysis) return null;
    const W = CFG.WEIGHTS;
    const last = candles[candles.length - 1];
    const price = last.close;
    const lastIdx = candles.length - 1;
    const factors = []; // {name, dir:+1|-1|0, weight, note}

    // 1. trend
    const trend = analysis.structure.trend;
    factors.push({
      name: 'Market trend', weight: W.trend,
      dir: trend === 'up' ? 1 : trend === 'down' ? -1 : 0,
      note: trend === 'range' ? 'Ranging — no trend edge' : `Structure trending ${trend}`,
    });

    // 2. recent structure events (within last 12 bars)
    const recentEvents = analysis.structure.events.filter((e) => lastIdx - e.idx <= 12);
    const lastEv = recentEvents[recentEvents.length - 1];
    if (lastEv) {
      const d = lastEv.dir === 'up' ? 1 : -1;
      factors.push({
        name: lastEv.kind, weight: lastEv.kind === 'CHoCH' ? W.choch : W.bos, dir: d,
        note: `${lastEv.kind} ${lastEv.dir} at ${fmt(lastEv.level)} (${lastIdx - lastEv.idx} bars ago)`,
      });
    }

    // 3. price inside an active order block
    let activeOB = null;
    for (const b of analysis.orderBlocks) {
      if (price <= b.top && price >= b.bottom) { activeOB = b; break; }
    }
    if (activeOB) {
      factors.push({
        name: 'Order block', weight: W.orderBlock, dir: activeOB.dir === 'up' ? 1 : -1,
        note: `Price inside ${activeOB.state} ${activeOB.dir === 'up' ? 'demand' : 'supply'} block ${fmt(activeOB.bottom)}–${fmt(activeOB.top)}`,
      });
    }

    // 4. price inside an unfilled FVG
    let activeFVG = null;
    for (const g of analysis.fvgs) {
      if (price <= g.top && price >= g.bottom) { activeFVG = g; break; }
    }
    if (activeFVG) {
      factors.push({
        name: 'FVG', weight: W.fvg, dir: activeFVG.dir === 'up' ? 1 : -1,
        note: `Inside unfilled ${activeFVG.dir === 'up' ? 'bullish' : 'bearish'} FVG`,
      });
    }

    // 5. recent liquidity sweep (last 8 bars) — sweep of lows is bullish fuel
    const sweep = analysis.liquidity.sweeps.filter((s) => lastIdx - s.idx <= 8).pop();
    if (sweep) {
      factors.push({
        name: 'Liquidity hunt', weight: W.sweep, dir: sweep.dir === 'low' ? 1 : -1,
        note: `${sweep.eq ? 'Equal' : 'Swing'} ${sweep.dir}s swept at ${fmt(sweep.level)}${sweep.volSpike ? ' on a volume spike' : ''}`,
      });
    }

    // 6. delta flow: last 3 closed candles net delta + divergence
    const recentDelta = candles.slice(-3).reduce((s, c) => s + c.delta, 0);
    const dAvg = Math.max(1e-9, avgAbsDelta(candles));
    if (Math.abs(recentDelta) > 0.5 * dAvg) {
      factors.push({
        name: 'Delta volume', weight: W.delta, dir: recentDelta > 0 ? 1 : -1,
        note: `${recentDelta > 0 ? 'Buyers' : 'Sellers'} in control — 3-bar delta ${fmtQty(recentDelta)}`,
      });
    }
    if (analysis.divergence && lastIdx - analysis.divergence.idx <= 10) {
      factors.push({
        name: 'CVD divergence', weight: W.delta, dir: analysis.divergence.side === 'bullish' ? 1 : -1,
        note: `${cap(analysis.divergence.side)} delta divergence vs price`,
      });
    }

    // 7. liquidations: a burst of long liquidations often marks a local low (contrarian)
    const liq = ctx.liq || { recentLong: 0, recentShort: 0 };
    if (liq.recentLong + liq.recentShort > 0) {
      const dir = liq.recentLong > liq.recentShort ? 1 : -1;
      const dom = dir === 1 ? 'longs' : 'shorts';
      factors.push({
        name: 'Liquidations', weight: W.liquidation, dir,
        note: `Mostly ${dom} liquidated recently (${fmtUsd(liq.recentLong)} vs ${fmtUsd(liq.recentShort)}) — fuel spent, favors ${dir === 1 ? 'upside' : 'downside'}`,
      });
    }

    // 8. absorption
    const abs = analysis.absorption.filter((a) => lastIdx - a.idx <= 8).pop();
    if (abs) {
      factors.push({
        name: 'Absorption', weight: W.absorption, dir: abs.side === 'bullish' ? 1 : -1,
        note: `${cap(abs.side)} absorption — heavy ${abs.side === 'bullish' ? 'selling soaked up' : 'buying capped'} with little price movement`,
      });
    }

    // 9. funding extreme (contrarian)
    if (typeof ctx.funding === 'number' && Math.abs(ctx.funding) > 0.0003) {
      factors.push({
        name: 'Funding', weight: W.funding, dir: ctx.funding > 0 ? -1 : 1,
        note: `Funding ${(ctx.funding * 100).toFixed(4)}% — crowded ${ctx.funding > 0 ? 'longs' : 'shorts'}`,
      });
    }

    const score = factors.reduce((s, f) => s + f.dir * f.weight, 0);
    const totalWeight = factors.reduce((s, f) => s + f.weight, 0) || 1;
    const direction = score >= CFG.SIGNAL_THRESHOLD ? 'LONG' : score <= -CFG.SIGNAL_THRESHOLD ? 'SHORT' : 'WAIT';
    const confidence = Math.min(95, Math.round(Math.abs(score) / totalWeight * 100));

    // trade levels
    let levels = null;
    if (direction !== 'WAIT') {
      const a = analysis.atr;
      const long = direction === 'LONG';
      const zone = activeOB || activeFVG;
      const entry = zone ? (zone.top + zone.bottom) / 2 : price;
      let stop;
      if (sweep && ((long && sweep.dir === 'low') || (!long && sweep.dir === 'high'))) {
        stop = long ? candles[sweep.idx].low - 0.25 * a : candles[sweep.idx].high + 0.25 * a;
      } else if (zone) {
        stop = long ? zone.bottom - 0.25 * a : zone.top + 0.25 * a;
      } else {
        stop = long ? price - 1.5 * a : price + 1.5 * a;
      }
      // targets: nearest opposite liquidity pools, else ATR multiples
      const pools = analysis.liquidity.pools
        .filter((p) => (long ? p.type === 'high' && p.price > entry : p.type === 'low' && p.price < entry))
        .sort((x, y) => long ? x.price - y.price : y.price - x.price);
      const t1 = pools[0] ? pools[0].price : (long ? entry + 1.5 * a : entry - 1.5 * a);
      const t2 = pools[1] ? pools[1].price : (long ? entry + 3 * a : entry - 3 * a);
      const rr = Math.abs(t1 - entry) / Math.max(1e-9, Math.abs(entry - stop));
      levels = { entry, stop, t1, t2, rr };
    }

    return { direction, score, confidence, factors, levels, price };
  }

  function avgAbsDelta(candles, len = 20) {
    const from = Math.max(0, candles.length - len);
    let s = 0, n = 0;
    for (let i = from; i < candles.length; i++) { s += Math.abs(candles[i].delta); n++; }
    return n ? s / n : 0;
  }

  function fmt(x) { return typeof x === 'number' ? x.toPrecision(5).replace(/\.?0+$/, '') : x; }
  function fmtQty(x) {
    const a = Math.abs(x);
    const s = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0);
    return (x < 0 ? '-' : '+') + s;
  }
  function fmtUsd(x) {
    const a = Math.abs(x);
    return '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0));
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  const api = { computeSignal, fmtQty, fmtUsd };
  if (typeof window !== 'undefined') window.Signals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
