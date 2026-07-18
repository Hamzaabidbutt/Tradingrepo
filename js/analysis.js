// Pure analysis engine: takes an array of closed candles
// ({time, open, high, low, close, volume, delta}) and returns detected
// structures. No DOM, no network — unit-testable in Node.
(function (global) {
  const CFG = (typeof window !== 'undefined' ? window.CFG : global.CFG);

  function sma(arr, i, len) {
    const from = Math.max(0, i - len + 1);
    let s = 0;
    for (let j = from; j <= i; j++) s += arr[j];
    return s / (i - from + 1);
  }

  function atr(candles, i, len = 14) {
    const from = Math.max(1, i - len + 1);
    let s = 0, n = 0;
    for (let j = from; j <= i; j++) {
      const tr = Math.max(
        candles[j].high - candles[j].low,
        Math.abs(candles[j].high - candles[j - 1].close),
        Math.abs(candles[j].low - candles[j - 1].close)
      );
      s += tr; n++;
    }
    return n ? s / n : candles[i].high - candles[i].low;
  }

  // ---------- swing pivots (fractals) ----------
  function findPivots(candles, k) {
    const pivots = [];
    for (let i = k; i < candles.length - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isH = false;
        if (candles[j].low <= candles[i].low) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) pivots.push({ idx: i, time: candles[i].time, price: candles[i].high, type: 'H' });
      if (isL) pivots.push({ idx: i, time: candles[i].time, price: candles[i].low, type: 'L' });
    }
    return pivots;
  }

  // ---------- market structure: trend, BOS, CHoCH ----------
  function analyzeStructure(candles, pivots) {
    const events = []; // {idx, time, kind:'BOS'|'CHoCH', dir:'up'|'down', level}
    let trend = 'range';
    let lastHigh = null, lastLow = null;
    let pi = 0;
    for (let i = 0; i < candles.length; i++) {
      while (pi < pivots.length && pivots[pi].idx + CFG.PIVOT_LOOKBACK === i) {
        // pivot at pivots[pi].idx confirms once k bars have printed after it
        const p = pivots[pi];
        if (p.type === 'H') lastHigh = p; else lastLow = p;
        pi++;
      }
      const c = candles[i];
      if (lastHigh && c.close > lastHigh.price) {
        const kind = trend === 'down' ? 'CHoCH' : 'BOS';
        events.push({ idx: i, time: c.time, kind, dir: 'up', level: lastHigh.price });
        trend = 'up';
        lastHigh = null; // consumed; wait for a new swing
      } else if (lastLow && c.close < lastLow.price) {
        const kind = trend === 'up' ? 'CHoCH' : 'BOS';
        events.push({ idx: i, time: c.time, kind, dir: 'down', level: lastLow.price });
        trend = 'down';
        lastLow = null;
      }
    }
    return { trend, events };
  }

  // ---------- order blocks ----------
  // Last opposite candle before an impulsive structure break; tracked
  // through tested/respected/mitigated states.
  function findOrderBlocks(candles, structureEvents) {
    const blocks = [];
    for (const ev of structureEvents) {
      const dir = ev.dir;
      // scan back from the break bar for the last opposite-direction candle
      let obIdx = -1;
      for (let j = ev.idx; j >= Math.max(0, ev.idx - 12); j--) {
        const c = candles[j];
        const bearish = c.close < c.open, bullish = c.close > c.open;
        if ((dir === 'up' && bearish) || (dir === 'down' && bullish)) { obIdx = j; break; }
      }
      if (obIdx < 0) continue;
      const c = candles[obIdx];
      const a = atr(candles, ev.idx);
      const move = Math.abs(candles[ev.idx].close - (dir === 'up' ? c.low : c.high));
      if (move < a * CFG.IMPULSE_ATR_MULT) continue; // not impulsive enough
      // bullish OB: candle low..body top; bearish OB: body bottom..candle high
      blocks.push({
        idx: obIdx, time: c.time,
        top: dir === 'up' ? Math.max(c.open, c.close) : c.high,
        bottom: dir === 'up' ? c.low : Math.min(c.open, c.close),
        dir, // 'up' = bullish (demand), 'down' = bearish (supply)
        state: 'fresh', // fresh -> respected -> mitigated
        touches: 0,
        fromEvent: ev.kind,
      });
    }
    // dedupe overlapping blocks from the same bar
    const seen = new Set();
    const unique = blocks.filter((b) => {
      const key = b.idx + b.dir;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // walk price forward to classify state
    for (const b of unique) {
      for (let i = b.idx + 2; i < candles.length; i++) {
        const c = candles[i];
        if (b.dir === 'up') {
          if (c.close < b.bottom) { b.state = 'mitigated'; b.mitigatedAt = i; break; }
          if (c.low <= b.top && c.low >= b.bottom - (b.top - b.bottom)) {
            b.touches++;
            // reaction: closes back above the zone with buying delta
            if (c.close > b.top && c.delta > 0) { b.state = 'respected'; b.respectedAt = i; }
          }
        } else {
          if (c.close > b.top) { b.state = 'mitigated'; b.mitigatedAt = i; break; }
          if (c.high >= b.bottom && c.high <= b.top + (b.top - b.bottom)) {
            b.touches++;
            if (c.close < b.bottom && c.delta < 0) { b.state = 'respected'; b.respectedAt = i; }
          }
        }
      }
    }
    const active = unique.filter((b) => b.state !== 'mitigated');
    return active.slice(-CFG.MAX_ZONES);
  }

  // ---------- fair value gaps ----------
  function findFVGs(candles) {
    const gaps = [];
    for (let i = 2; i < candles.length; i++) {
      const a = candles[i - 2], c = candles[i];
      if (c.low > a.high) {
        gaps.push({ idx: i - 1, time: candles[i - 1].time, top: c.low, bottom: a.high, dir: 'up', filled: false });
      } else if (c.high < a.low) {
        gaps.push({ idx: i - 1, time: candles[i - 1].time, top: a.low, bottom: c.high, dir: 'down', filled: false });
      }
    }
    for (const g of gaps) {
      for (let i = g.idx + 2; i < candles.length; i++) {
        const c = candles[i];
        if (g.dir === 'up' && c.low <= g.bottom) { g.filled = true; break; }
        if (g.dir === 'down' && c.high >= g.top) { g.filled = true; break; }
      }
    }
    return gaps.filter((g) => !g.filled).slice(-CFG.MAX_ZONES);
  }

  // ---------- liquidity pools & hunts ----------
  function findLiquidity(candles, pivots) {
    const pools = []; // {price, type:'high'|'low', idxs:[], swept:false}
    const highs = pivots.filter((p) => p.type === 'H');
    const lows = pivots.filter((p) => p.type === 'L');
    const group = (arr, type) => {
      const used = new Set();
      for (let i = 0; i < arr.length; i++) {
        if (used.has(i)) continue;
        const cluster = [arr[i]];
        for (let j = i + 1; j < arr.length; j++) {
          if (Math.abs(arr[j].price - arr[i].price) / arr[i].price < CFG.EQ_LEVEL_TOL) {
            cluster.push(arr[j]); used.add(j);
          }
        }
        if (cluster.length >= 2) {
          pools.push({
            price: cluster.reduce((s, p) => s + p.price, 0) / cluster.length,
            type, idxs: cluster.map((p) => p.idx), eq: true,
          });
        }
      }
    };
    group(highs, 'high');
    group(lows, 'low');
    // recent single-swing extremes are liquidity too
    if (highs.length) pools.push({ price: highs[highs.length - 1].price, type: 'high', idxs: [highs[highs.length - 1].idx], eq: false });
    if (lows.length) pools.push({ price: lows[lows.length - 1].price, type: 'low', idxs: [lows[lows.length - 1].idx], eq: false });

    // sweeps: wick beyond a pool, close back inside
    const sweeps = [];
    for (const pool of pools) {
      const startIdx = Math.max(...pool.idxs) + 1;
      for (let i = startIdx; i < candles.length; i++) {
        const c = candles[i];
        if (pool.type === 'low' && c.low < pool.price && c.close > pool.price) {
          sweeps.push({ idx: i, time: c.time, dir: 'low', level: pool.price, eq: pool.eq, volSpike: c.volume > CFG.VOL_SPIKE_MULT * volSMA(candles, i) });
          pool.swept = true; break;
        }
        if (pool.type === 'high' && c.high > pool.price && c.close < pool.price) {
          sweeps.push({ idx: i, time: c.time, dir: 'high', level: pool.price, eq: pool.eq, volSpike: c.volume > CFG.VOL_SPIKE_MULT * volSMA(candles, i) });
          pool.swept = true; break;
        }
        // pool invalidated if price closes through it
        if (pool.type === 'low' && c.close < pool.price) { pool.broken = true; break; }
        if (pool.type === 'high' && c.close > pool.price) { pool.broken = true; break; }
      }
    }
    return {
      pools: pools.filter((p) => !p.swept && !p.broken).slice(-6),
      sweeps: sweeps.slice(-10),
    };
  }

  function volSMA(candles, i, len = 20) {
    const from = Math.max(0, i - len + 1);
    let s = 0;
    for (let j = from; j <= i; j++) s += candles[j].volume;
    return s / (i - from + 1);
  }

  // ---------- absorption ----------
  // High volume + strong delta, but price barely moves (effort vs result).
  function findAbsorption(candles) {
    const out = [];
    for (let i = 20; i < candles.length; i++) {
      const c = candles[i];
      const a = atr(candles, i);
      const range = c.high - c.low;
      const vAvg = volSMA(candles, i - 1);
      const dAvg = deltaAbsSMA(candles, i - 1);
      if (c.volume > CFG.VOL_SPIKE_MULT * vAvg && range < CFG.ABSORPTION_RANGE_MULT * a && Math.abs(c.delta) > 1.2 * dAvg) {
        // heavy selling absorbed near lows => bullish; heavy buying absorbed near highs => bearish
        const side = c.delta < 0 ? 'bullish' : 'bearish';
        out.push({ idx: i, time: c.time, side, delta: c.delta, volume: c.volume });
      }
    }
    return out.slice(-8);
  }

  function deltaAbsSMA(candles, i, len = 20) {
    const from = Math.max(0, i - len + 1);
    let s = 0;
    for (let j = from; j <= i; j++) s += Math.abs(candles[j].delta);
    return s / (i - from + 1);
  }

  // ---------- CVD + divergence ----------
  function computeCVD(candles) {
    const cvd = [];
    let acc = 0;
    for (const c of candles) { acc += c.delta; cvd.push({ time: c.time, value: acc }); }
    return cvd;
  }

  function findDeltaDivergence(candles, pivots, cvd) {
    // price higher high while CVD lower high => bearish; inverse => bullish
    const highs = pivots.filter((p) => p.type === 'H').slice(-2);
    const lows = pivots.filter((p) => p.type === 'L').slice(-2);
    let divergence = null;
    if (highs.length === 2 && highs[1].price > highs[0].price && cvd[highs[1].idx].value < cvd[highs[0].idx].value) {
      divergence = { side: 'bearish', idx: highs[1].idx, time: highs[1].time };
    }
    if (lows.length === 2 && lows[1].price < lows[0].price && cvd[lows[1].idx].value > cvd[lows[0].idx].value) {
      divergence = { side: 'bullish', idx: lows[1].idx, time: lows[1].time };
    }
    return divergence;
  }

  // ---------- top-level ----------
  function analyze(candles) {
    if (candles.length < 30) return null;
    const pivots = findPivots(candles, CFG.PIVOT_LOOKBACK);
    const structure = analyzeStructure(candles, pivots);
    const orderBlocks = findOrderBlocks(candles, structure.events);
    const fvgs = findFVGs(candles);
    const liquidity = findLiquidity(candles, pivots);
    const absorption = findAbsorption(candles);
    const cvd = computeCVD(candles);
    const divergence = findDeltaDivergence(candles, pivots, cvd);
    const lastATR = atr(candles, candles.length - 1);
    return {
      pivots, structure, orderBlocks, fvgs, liquidity, absorption, cvd,
      divergence, atr: lastATR,
      lastVolSMA: volSMA(candles, candles.length - 1),
    };
  }

  const api = { analyze, findPivots, analyzeStructure, findOrderBlocks, findFVGs, findLiquidity, findAbsorption, computeCVD, findDeltaDivergence, atr };
  if (typeof window !== 'undefined') window.Analysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
