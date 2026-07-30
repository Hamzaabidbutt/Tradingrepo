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

  // ---------- engulfing candles ----------
  function findEngulfing(candles) {
    const out = [];
    for (let i = Math.max(1, candles.length - 60); i < candles.length; i++) {
      const p = candles[i - 1], c = candles[i];
      const pBody = Math.abs(p.close - p.open);
      const body = Math.abs(c.close - c.open);
      if (pBody === 0 || body < pBody * 1.05) continue;
      const strong = c.volume > CFG.VOL_SPIKE_MULT * volSMA(candles, i - 1);
      if (p.close < p.open && c.close > c.open && c.close >= Math.max(p.open, p.close) && c.open <= Math.min(p.open, p.close)) {
        out.push({ idx: i, time: c.time, side: 'bullish', strong });
      } else if (p.close > p.open && c.close < c.open && c.close <= Math.min(p.open, p.close) && c.open >= Math.max(p.open, p.close)) {
        out.push({ idx: i, time: c.time, side: 'bearish', strong });
      }
    }
    return out.slice(-8);
  }

  // ---------- support / resistance levels (per timeframe) ----------
  // Cluster swing pivots into levels; strength = number of touches.
  function srLevels(candles, tfLabel) {
    if (!candles || candles.length < 30) return [];
    const pivots = findPivots(candles, 2);
    const a = atr(candles, candles.length - 1);
    const lastClose = candles[candles.length - 1].close;
    const tol = Math.max(a * 0.35, lastClose * 0.002);
    const clusters = [];
    for (const p of pivots) {
      let cl = clusters.find((l) => Math.abs(l.priceSum / l.touches - p.price) < tol);
      if (!cl) { cl = { priceSum: 0, touches: 0, lastIdx: 0 }; clusters.push(cl); }
      cl.priceSum += p.price;
      cl.touches++;
      cl.lastIdx = Math.max(cl.lastIdx, p.idx);
    }
    return clusters
      .filter((l) => l.touches >= 2)
      .map((l) => ({
        price: l.priceSum / l.touches,
        tf: tfLabel,
        touches: l.touches,
        strength: l.touches >= 5 ? 'strong' : l.touches >= 3 ? 'medium' : 'weak',
        recency: (candles.length - 1 - l.lastIdx) / candles.length,
      }));
  }

  // ---------- double top / double bottom + break-chance estimate ----------
  function findDoublePattern(candles, pivots, cvd, trend) {
    const lastIdx = candles.length - 1;
    const tolPct = 0.005;
    const build = (pair, type) => {
      const [p1, p2] = pair;
      if (Math.abs(p2.price - p1.price) / p1.price >= tolPct) return null;
      if (lastIdx - p2.idx > 30 || p2.idx - p1.idx < 4) return null;
      // neckline: extreme between the two tests
      let neck = type === 'double-top' ? Infinity : -Infinity;
      for (let i = p1.idx; i <= p2.idx; i++) {
        neck = type === 'double-top' ? Math.min(neck, candles[i].low) : Math.max(neck, candles[i].high);
      }
      // chance that price BREAKS THROUGH the level (vs reversing off it)
      let chance = 45;
      const reasons = [];
      const v1 = candles[p1.idx].volume, v2 = candles[p2.idx].volume;
      if (v2 > v1 * 1.1) { chance += 12; reasons.push('second test came on higher volume'); }
      else if (v2 < v1 * 0.9) { chance -= 12; reasons.push('volume faded on the second test'); }
      const cvdChg = cvd[p2.idx].value - cvd[p1.idx].value;
      const pushDir = type === 'double-top' ? 1 : -1;
      if (cvdChg * pushDir > 0) { chance += 12; reasons.push(type === 'double-top' ? 'buyers kept accumulating between tests (CVD rising)' : 'sellers kept pressing between tests (CVD falling)'); }
      else { chance -= 12; reasons.push(type === 'double-top' ? 'buying pressure faded between tests (CVD falling)' : 'selling pressure faded between tests (CVD rising)'); }
      if ((type === 'double-top' && trend === 'up') || (type === 'double-bottom' && trend === 'down')) {
        chance += 10; reasons.push('the prevailing trend pushes into the level');
      } else if ((type === 'double-top' && trend === 'down') || (type === 'double-bottom' && trend === 'up')) {
        chance -= 10; reasons.push('the prevailing trend leans against a break');
      }
      chance = Math.max(15, Math.min(85, chance));
      return {
        type,
        level: (p1.price + p2.price) / 2,
        neckline: neck,
        time1: p1.time, time2: p2.time, idx2: p2.idx,
        breakChance: chance,
        reasons,
      };
    };
    const highs = pivots.filter((p) => p.type === 'H').slice(-2);
    const lows = pivots.filter((p) => p.type === 'L').slice(-2);
    const top = highs.length === 2 ? build(highs, 'double-top') : null;
    const bottom = lows.length === 2 ? build(lows, 'double-bottom') : null;
    if (top && bottom) return top.idx2 >= bottom.idx2 ? top : bottom; // most recent wins
    return top || bottom;
  }

  // ---------- volume profile: where the buying / selling actually happened ----------
  function volumeProfile(candles, bins = 24) {
    const from = Math.max(0, candles.length - 120);
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i < candles.length; i++) {
      lo = Math.min(lo, candles[i].low);
      hi = Math.max(hi, candles[i].high);
    }
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins;
    const vols = new Array(bins).fill(0);
    const deltas = new Array(bins).fill(0);
    for (let i = from; i < candles.length; i++) {
      const c = candles[i];
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((c.high + c.low) / 2 - lo) / step)));
      vols[b] += c.volume;
      deltas[b] += c.delta;
    }
    let poc = 0, buyB = 0, sellB = 0;
    for (let i = 0; i < bins; i++) {
      if (vols[i] > vols[poc]) poc = i;
      if (deltas[i] > deltas[buyB]) buyB = i;
      if (deltas[i] < deltas[sellB]) sellB = i;
    }
    const price = (b) => lo + step * (b + 0.5);
    return {
      poc: price(poc),
      buyArea: price(buyB), buyDelta: deltas[buyB],
      sellArea: price(sellB), sellDelta: deltas[sellB],
    };
  }

  // ---------- accumulation / distribution phase (Wyckoff-style heuristic) ----------
  function marketPhase(candles, cvd) {
    const n = candles.length;
    const from = Math.max(0, n - 40);
    const pchg = (candles[n - 1].close - candles[from].close) / candles[from].close;
    const cvdChg = cvd[n - 1].value - cvd[from].value;
    let totalAbs = 0;
    for (let i = from; i < n; i++) totalAbs += Math.abs(candles[i].delta);
    const ratio = totalAbs ? cvdChg / totalAbs : 0;
    const flat = Math.abs(pchg) < 0.02;
    if (flat && ratio > 0.06) return { phase: 'accumulation', note: 'price is going sideways while net buying quietly builds — smart money may be accumulating' };
    if (flat && ratio < -0.06) return { phase: 'distribution', note: 'price is going sideways while net selling quietly builds — smart money may be distributing' };
    if (pchg > 0.02 && ratio > 0) return { phase: 'markup', note: 'price and net buying are rising together — healthy uptrend participation' };
    if (pchg < -0.02 && ratio < 0) return { phase: 'markdown', note: 'price and net selling are falling together — sellers remain in control' };
    if (pchg > 0.02 && ratio < 0) return { phase: 'weak rally', note: 'price is rising but net flow is selling — rally lacks real buying, be careful' };
    if (pchg < -0.02 && ratio > 0) return { phase: 'weak selloff', note: 'price is falling but net flow is buying — dip is being bought' };
    return { phase: 'neutral', note: 'no clear accumulation or distribution footprint right now' };
  }

  // ---------- fibonacci retracement of the latest swing ----------
  // Anchored to the most recent significant swing pair; retracement levels
  // plus 1.272 / 1.618 extensions, with the 0.618–0.786 "golden pocket".
  function computeFib(candles) {
    const LOOKBACK = 120;
    const from = Math.max(0, candles.length - LOOKBACK);
    let hiIdx = from, loIdx = from;
    for (let i = from; i < candles.length; i++) {
      if (candles[i].high >= candles[hiIdx].high) hiIdx = i;
      if (candles[i].low <= candles[loIdx].low) loIdx = i;
    }
    const high = candles[hiIdx].high, low = candles[loIdx].low;
    const range = high - low;
    if (range <= 0) return null;
    const up = hiIdx > loIdx; // most recent extreme defines the impulse direction
    const startIdx = Math.min(hiIdx, loIdx);
    const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1];
    const levels = ratios.map((r) => ({
      label: r === 0 ? (up ? '0 (swing high)' : '0 (swing low)') : r === 1 ? '1.0 (swing origin)' : String(r),
      ratio: r,
      price: up ? high - r * range : low + r * range,
    }));
    for (const r of [1.272, 1.618]) {
      levels.push({ label: `${r} ext`, ratio: r, ext: true, price: up ? high + (r - 1) * range : low - (r - 1) * range });
    }
    const golden = up
      ? { top: high - 0.618 * range, bottom: high - 0.786 * range }
      : { top: low + 0.786 * range, bottom: low + 0.618 * range };
    return { up, high, low, startTime: candles[startIdx].time, levels, golden };
  }

  // ---------- Volume Spread Analysis (Wyckoff / Tom Williams rules) ----------
  // Compares each bar's SPREAD (range), CLOSE POSITION within that range and
  // VOLUME against recent averages to classify effort-vs-result anomalies.
  function volumeSpreadAnalysis(candles) {
    const out = [];
    const start = Math.max(2, candles.length - 120);
    for (let i = start; i < candles.length; i++) {
      const c = candles[i];
      const spread = c.high - c.low;
      if (spread <= 0) continue;
      const avgSpread = avgOf(candles, i - 1, 20, (x) => x.high - x.low);
      const avgVol = avgOf(candles, i - 1, 20, (x) => x.volume);
      if (!avgSpread || !avgVol) continue;

      const spreadR = spread / avgSpread;   // wide (>1.4) vs narrow (<0.7)
      const volR = c.volume / avgVol;       // high (>1.5) vs low (<0.7)
      const closePos = (c.close - c.low) / spread; // 0 = at low, 1 = at high
      const up = c.close > c.open;
      const prev = candles[i - 1];
      const trendUp = c.close > candles[Math.max(0, i - 5)].close;

      const wide = spreadR > 1.4, narrow = spreadR < 0.7;
      const highVol = volR > 1.5, lowVol = volR < 0.7, ultraVol = volR > 2.5;

      const add = (type, bias, label, note) => out.push({
        idx: i, time: c.time, type, bias, label, note,
        spreadR, volR, closePos, volume: c.volume,
      });

      // --- classic VSA signatures, most specific first ---
      if (wide && ultraVol && closePos > 0.7 && !trendUp) {
        add('stopping-volume', 'bullish', 'STOP VOL',
          `Huge volume (${volR.toFixed(1)}× avg) on a wide down-move but the bar closed near its high — sellers are being absorbed, a floor is being built.`);
      } else if (wide && ultraVol && closePos < 0.3 && trendUp) {
        add('buying-climax', 'bearish', 'CLIMAX',
          `Climactic volume (${volR.toFixed(1)}× avg) into new highs closing near the low — demand is being met with heavy supply. Distribution.`);
      } else if (wide && highVol && closePos < 0.35 && up) {
        add('upthrust', 'bearish', 'UPTHRUST',
          `Upthrust: price pushed up on ${volR.toFixed(1)}× volume then closed near the low — the move up was rejected, trapping buyers.`);
      } else if (wide && highVol && closePos > 0.65 && !up && c.low < prev.low) {
        add('spring', 'bullish', 'SPRING',
          `Spring/shakeout: dipped under the prior low on ${volR.toFixed(1)}× volume and closed strong — weak holders shaken out.`);
      } else if (narrow && highVol) {
        add('absorption', closePos > 0.5 ? 'bullish' : 'bearish', 'ABSORB',
          `Effort vs result mismatch: ${volR.toFixed(1)}× volume produced only a ${spreadR.toFixed(1)}× spread — someone large is absorbing the flow.`);
      } else if (wide && lowVol) {
        add('no-liquidity', up ? 'bearish' : 'bullish', 'THIN',
          `Wide ${up ? 'up' : 'down'} bar on only ${volR.toFixed(1)}× volume — the move went through thin liquidity, not real participation. Easily reversed.`);
      } else if (narrow && lowVol && up && trendUp) {
        add('no-demand', 'bearish', 'NO DEMAND',
          `No-demand bar: an up bar on ${volR.toFixed(1)}× volume with a narrow spread — buyers are not supporting this rally.`);
      } else if (narrow && lowVol && !up && !trendUp) {
        add('no-supply', 'bullish', 'NO SUPPLY',
          `No-supply bar: a down bar on ${volR.toFixed(1)}× volume with a narrow spread — sellers have dried up.`);
      } else if (ultraVol) {
        add('unusual-volume', closePos > 0.5 ? 'bullish' : 'bearish', 'VOL SPIKE',
          `Unusual volume: ${volR.toFixed(1)}× the 20-bar average, closing ${closePos > 0.5 ? 'in the upper' : 'in the lower'} half of the range.`);
      }
    }
    return out.slice(-40);
  }

  function avgOf(candles, endIdx, len, fn) {
    const from = Math.max(0, endIdx - len + 1);
    let s = 0, n = 0;
    for (let i = from; i <= endIdx; i++) { s += fn(candles[i]); n++; }
    return n ? s / n : 0;
  }

  // ---------- key moving averages ----------
  function movingAverages(candles) {
    const close = candles.map((c) => c.close);
    const price = close[close.length - 1];
    const emaSeries = (len) => {
      const k = 2 / (len + 1);
      const out = [];
      let e = close[0];
      for (let i = 0; i < close.length; i++) { e = i ? close[i] * k + e * (1 - k) : close[0]; out.push(e); }
      return out;
    };
    const smaSeries = (len) => close.map((_, i) => {
      if (i < len - 1) return null;
      let s = 0;
      for (let j = i - len + 1; j <= i; j++) s += close[j];
      return s / len;
    });

    const defs = [
      { key: 'ema20', label: 'EMA 20', len: 20, kind: 'ema' },
      { key: 'ema50', label: 'EMA 50', len: 50, kind: 'ema' },
      { key: 'ema100', label: 'EMA 100', len: 100, kind: 'ema' },
      { key: 'ema200', label: 'EMA 200', len: 200, kind: 'ema' },
      { key: 'sma200', label: 'SMA 200', len: 200, kind: 'sma' },
    ];
    const lines = [];
    for (const d of defs) {
      if (candles.length < d.len) continue;
      const series = d.kind === 'ema' ? emaSeries(d.len) : smaSeries(d.len);
      const value = series[series.length - 1];
      if (value == null) continue;
      lines.push({
        ...d,
        value,
        series: series.map((v, i) => (v == null ? null : { time: candles[i].time, value: v })).filter(Boolean),
        distancePct: ((price - value) / value) * 100,
        above: price > value,
      });
    }
    // golden / death cross on the 50 vs 200
    let cross = null;
    const f = lines.find((l) => l.key === 'ema50'), s = lines.find((l) => l.key === 'ema200');
    if (f && s && f.series.length > 3 && s.series.length > 3) {
      const fPrev = f.series[f.series.length - 3].value, sPrev = s.series[s.series.length - 3].value;
      if (fPrev <= sPrev && f.value > s.value) cross = { type: 'golden', note: 'EMA 50 just crossed above EMA 200 — a golden cross, a classic bullish regime shift.' };
      else if (fPrev >= sPrev && f.value < s.value) cross = { type: 'death', note: 'EMA 50 just crossed below EMA 200 — a death cross, a classic bearish regime shift.' };
    }
    const aboveCount = lines.filter((l) => l.above).length;
    const stacked = lines.length >= 4 && (aboveCount === lines.length || aboveCount === 0);
    return {
      lines, cross, aboveCount, total: lines.length, stacked,
      regime: aboveCount === lines.length ? 'bullish' : aboveCount === 0 ? 'bearish' : 'mixed',
      nearest: lines.slice().sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))[0] || null,
    };
  }

  // ---------- market structure & liquidity (external/internal, premium/discount) ----------
  // External structure = major swings (the dealing range). Internal = the
  // minor structure inside it. Premium/discount is measured against the
  // equilibrium (50%) of the current dealing range.
  function marketStructure(candles, pivots, structure, cvd) {
    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;

    const majorPivots = findPivots(candles, Math.max(5, CFG.PIVOT_LOOKBACK * 2));
    const majorHighs = majorPivots.filter((p) => p.type === 'H');
    const majorLows = majorPivots.filter((p) => p.type === 'L');

    const bias = (highs, lows) => {
      if (highs.length < 2 || lows.length < 2) return 'neutral';
      const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
      const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
      if (hh && hl) return 'bullish';
      if (!hh && !hl) return 'bearish';
      return 'neutral';
    };

    const external = bias(majorHighs, majorLows);
    const internal = structure.trend === 'up' ? 'bullish' : structure.trend === 'down' ? 'bearish' : 'neutral';

    // dealing range from the most recent major swing high/low
    const rangeHigh = majorHighs.length ? majorHighs[majorHighs.length - 1].price : Math.max(...candles.slice(-60).map((c) => c.high));
    const rangeLow = majorLows.length ? majorLows[majorLows.length - 1].price : Math.min(...candles.slice(-60).map((c) => c.low));
    const eq = (rangeHigh + rangeLow) / 2;
    const span = Math.max(1e-9, rangeHigh - rangeLow);
    const position = Math.max(0, Math.min(1, (price - rangeLow) / span)); // 0 = low, 1 = high
    const zone = position > 0.55 ? 'premium' : position < 0.45 ? 'discount' : 'equilibrium';

    // continuation vs reversal odds
    let continuation = 50;
    const reasons = [];
    if (external !== 'neutral' && external === internal) { continuation += 18; reasons.push('external and internal structure agree'); }
    else if (external !== 'neutral' && internal !== 'neutral') { continuation -= 18; reasons.push('internal structure disagrees with the higher-timeframe trend'); }
    // buying in premium / selling in discount is poor location -> favors reversal
    if (internal === 'bullish' && zone === 'premium') { continuation -= 14; reasons.push('bullish but price sits in premium — poor location for longs'); }
    if (internal === 'bearish' && zone === 'discount') { continuation -= 14; reasons.push('bearish but price sits in discount — poor location for shorts'); }
    if (internal === 'bullish' && zone === 'discount') { continuation += 12; reasons.push('bullish with price in discount — good location'); }
    if (internal === 'bearish' && zone === 'premium') { continuation += 12; reasons.push('bearish with price in premium — good location'); }
    const lastEv = structure.events[structure.events.length - 1];
    if (lastEv && lastIdx - lastEv.idx <= 10) {
      if (lastEv.kind === 'CHoCH') { continuation -= 16; reasons.push('a recent CHoCH warns the trend is turning'); }
      else { continuation += 10; reasons.push('a recent BOS confirms trend continuation'); }
    }
    if (cvd && cvd.length === candles.length) {
      const cvdChg = cvd[lastIdx].value - cvd[Math.max(0, lastIdx - 10)].value;
      const priceUp = candles[lastIdx].close > candles[Math.max(0, lastIdx - 10)].close;
      if ((priceUp && cvdChg < 0) || (!priceUp && cvdChg > 0)) { continuation -= 10; reasons.push('order flow diverges from price'); }
    }
    continuation = Math.max(10, Math.min(90, continuation));

    // most recent structure event for the footer line
    const recentEvents = structure.events.slice(-3).reverse().map((e) => ({
      kind: e.kind, dir: e.dir, level: e.level,
      scope: majorHighs.some((p) => Math.abs(p.price - e.level) / e.level < 0.0015) || majorLows.some((p) => Math.abs(p.price - e.level) / e.level < 0.0015) ? 'ext' : 'int',
      barsAgo: lastIdx - e.idx,
    }));

    return {
      external, internal, zone, eq, rangeHigh, rangeLow, position,
      continuation, reversal: 100 - continuation, reasons,
      recentEvents,
    };
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
    const fib = computeFib(candles);
    const engulfing = findEngulfing(candles);
    const doublePattern = findDoublePattern(candles, pivots, cvd, structure.trend);
    const profile = volumeProfile(candles);
    const phase = marketPhase(candles, cvd);
    const mstructure = marketStructure(candles, pivots, structure, cvd);
    const vsa = volumeSpreadAnalysis(candles);
    const mas = movingAverages(candles);
    const lastATR = atr(candles, candles.length - 1);
    return {
      pivots, structure, orderBlocks, fvgs, liquidity, absorption, cvd,
      divergence, fib, engulfing, doublePattern, profile, phase, mstructure, vsa, mas, atr: lastATR,
      lastVolSMA: volSMA(candles, candles.length - 1),
    };
  }

  const api = { analyze, findPivots, analyzeStructure, findOrderBlocks, findFVGs, findLiquidity, findAbsorption, computeCVD, findDeltaDivergence, computeFib, findEngulfing, srLevels, marketStructure, volumeSpreadAnalysis, movingAverages, findDoublePattern, volumeProfile, marketPhase, atr };
  if (typeof window !== 'undefined') window.Analysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
