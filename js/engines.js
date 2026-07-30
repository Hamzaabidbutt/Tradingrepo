// Real-time engines: order flow, liquidations, whale detection, trading
// sessions, and the AI intelligence narrator. All pure-ish state machines
// fed by the live feed; rendering lives in app.js.
(function (global) {
  const CFG = (typeof window !== 'undefined' ? window.CFG : global.CFG);

  // ================= ORDER FLOW ENGINE =================
  // Tracks aggressive buy vs sell flow on the forming bar and over a
  // rolling window, producing pressure %, aggression rating and CVD.
  class OrderFlowEngine {
    constructor() { this.reset(); }

    reset() {
      this.barBuy = 0;
      this.barSell = 0;
      this.barTime = 0;
      this.window = [];      // recent trades for short-term pressure
      this.deltaBars = [];   // [{time, delta}] closed bars for the sparkline
      this.cvd = 0;
      this.avgBarVol = 0;
      this.barsSeen = 0;
      this.largestTrade = 0;
    }

    // Called for every trade — maintains the rolling pressure window and CVD.
    // Per-bar buy/sell totals come from the candle itself (see setBar) so they
    // include volume that traded before the page was opened.
    onTrade(t) {
      const notional = t.qty * t.price;
      if (t.side === 'buy') this.cvd += notional; else this.cvd -= notional;
      this.largestTrade = Math.max(this.largestTrade, notional);
      const now = t.time || Date.now();
      this.window.push({ time: now, side: t.side, notional });
      const cutoff = now - 60000;
      while (this.window.length && this.window[0].time < cutoff) this.window.shift();
    }

    // Authoritative per-bar split from the live candle: total notional and
    // delta give exact aggressive buy vs sell volume for the whole bar.
    setBar(candle) {
      const total = candle.volume * candle.close;
      const delta = candle.delta * candle.close;
      if (candle.time !== this.barTime) {
        if (this.barTime) this._closeBar();
        this.barTime = candle.time;
      }
      this.barBuy = Math.max(0, (total + delta) / 2);
      this.barSell = Math.max(0, (total - delta) / 2);
    }

    _closeBar() {
      const total = this.barBuy + this.barSell;
      this.deltaBars.push({ time: this.barTime, delta: this.barBuy - this.barSell, volume: total });
      if (this.deltaBars.length > 40) this.deltaBars.shift();
      this.barsSeen++;
      this.avgBarVol += (total - this.avgBarVol) / Math.min(this.barsSeen, 20);
    }

    // Seed from historical candles so the panel is meaningful immediately.
    seed(candles) {
      this.deltaBars = candles.slice(-40).map((c) => ({ time: c.time, delta: c.delta * c.close, volume: c.volume * c.close }));
      const vols = candles.slice(-20).map((c) => c.volume * c.close);
      this.avgBarVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      this.barsSeen = vols.length;
      this.cvd = candles.slice(-100).reduce((s, c) => s + c.delta * c.close, 0);
    }

    // barProgress (0..1) lets relative volume measure PACE rather than the
    // raw total, so a fresh bar isn't reported as "no volume".
    snapshot(barProgress) {
      const barTotal = this.barBuy + this.barSell;
      const buyPct = barTotal ? Math.round((this.barBuy / barTotal) * 100) : 50;
      let wBuy = 0, wSell = 0;
      for (const t of this.window) { if (t.side === 'buy') wBuy += t.notional; else wSell += t.notional; }
      const wTotal = wBuy + wSell;
      const skew = wTotal ? (wBuy - wSell) / wTotal : 0;
      const prog = Math.min(1, Math.max(0.08, barProgress || 1));
      const relVolume = this.avgBarVol ? (barTotal / prog) / this.avgBarVol : 0; // pace vs average bar
      const absSkew = Math.abs(skew);
      let aggression = 'Balanced';
      if (absSkew > 0.35) aggression = skew > 0 ? 'Strong buying' : 'Strong selling';
      else if (absSkew > 0.15) aggression = skew > 0 ? 'Buyers active' : 'Sellers active';
      return {
        buyPct, sellPct: 100 - buyPct,
        barBuy: this.barBuy, barSell: this.barSell,
        delta: this.barBuy - this.barSell,
        cvd: this.cvd,
        relVolume, aggression, skew,
        deltaBars: this.deltaBars.slice(-24),
        minuteBuy: wBuy, minuteSell: wSell,
      };
    }
  }

  // ================= LIQUIDATION ENGINE =================
  // Aggregates forced orders: totals, rate, cascade detection, biggest hit.
  class LiquidationEngine {
    constructor() { this.reset(); }

    reset() {
      this.long = 0;
      this.short = 0;
      this.events = [];   // recent {time, side, notional, price}
      this.biggest = null;
      this.bars = new Map();
    }

    onLiquidation(o, bucketSeconds) {
      this[o.liquidated] += o.notional;
      this.events.push({ time: o.time || Date.now(), side: o.liquidated, notional: o.notional, price: o.price });
      if (this.events.length > 300) this.events.shift();
      if (!this.biggest || o.notional > this.biggest.notional) {
        this.biggest = { side: o.liquidated, notional: o.notional, price: o.price, time: o.time || Date.now() };
      }
      const bucket = Math.floor((o.time || Date.now()) / 1000 / bucketSeconds) * bucketSeconds;
      const bar = this.bars.get(bucket) || { time: bucket, long: 0, short: 0 };
      bar[o.liquidated] += o.notional;
      this.bars.set(bucket, bar);
      return bar;
    }

    // Rich read of the liquidation state: directional pressure (0-100),
    // cascade risk, whale-driven detection and reversal odds.
    analysis(ctx) {
      const s = this.snapshot();
      const now = Date.now();
      const window = this.events.filter((e) => now - e.time < 600000); // 10 min
      const totalW = window.reduce((a, e) => a + e.notional, 0) || 1;
      let longW = 0, shortW = 0, big = 0;
      for (const e of window) {
        if (e.side === 'long') longW += e.notional; else shortW += e.notional;
        if (e.notional > 50000) big += e.notional;
      }
      const scale = (v) => Math.max(0, Math.min(100, Math.round(v)));
      // pressure = share of flow x recency-weighted rate
      const rateFactor = Math.min(1, s.perMin / 50000);
      const longPressure = scale((longW / totalW) * 100 * (window.length ? rateFactor + 0.35 : 0));
      const shortPressure = scale((shortW / totalW) * 100 * (window.length ? rateFactor + 0.35 : 0));
      const dominance = Math.abs(longW - shortW) / totalW;
      const cascadeRisk = scale((s.cascade ? 60 : 0) + dominance * 25 + rateFactor * 40);
      const whaleDriven = window.length > 0 && big / totalW > 0.5;

      // reversal odds: heavy one-sided liquidations exhaust that side
      let reversal = 50;
      const bullets = [];
      if (window.length) {
        const side = longW > shortW ? 'long' : 'short';
        const moves = ctx && ctx.candles ? recentMove(ctx.candles) : 0;
        reversal += dominance * 25;
        if (s.cascade) { reversal += 10; }
        if (whaleDriven) { reversal += 5; }
        reversal = scale(reversal);
        bullets.push(`${side === 'long' ? 'Longs' : 'Shorts'} were liquidated on the last impulse (intensity ${Math.round(dominance * 100)}/100, move ${Math.abs(moves).toFixed(2)}%).`);
        if (whaleDriven) bullets.push('Order size profile suggests whales triggered the cascade deliberately.');
        bullets.push(`Net liquidation pressure sits on ${side}s — squeezing that side is fuel for a move ${side === 'long' ? 'up' : 'down'} once it clears.`);
      } else {
        bullets.push('No liquidations recorded yet on this session — the panel fills as forced orders print.');
      }
      return { ...s, longPressure, shortPressure, cascadeRisk, whaleDriven, reversalOdds: reversal, bullets };
    }

    snapshot() {
      const now = Date.now();
      const recent = this.events.filter((e) => now - e.time < 300000); // 5 min
      let rLong = 0, rShort = 0;
      for (const e of recent) { if (e.side === 'long') rLong += e.notional; else rShort += e.notional; }
      const perMin = recent.length ? (rLong + rShort) / 5 : 0;
      // cascade: a burst of liquidations on one side inside 60s
      const lastMin = this.events.filter((e) => now - e.time < 60000);
      let mLong = 0, mShort = 0;
      for (const e of lastMin) { if (e.side === 'long') mLong += e.notional; else mShort += e.notional; }
      const dominant = mLong > mShort ? 'long' : 'short';
      const domShare = (mLong + mShort) ? Math.max(mLong, mShort) / (mLong + mShort) : 0;
      const cascade = lastMin.length >= 5 && domShare > 0.7;
      return {
        long: this.long, short: this.short,
        recentLong: rLong, recentShort: rShort,
        minuteLong: mLong, minuteShort: mShort,
        perMin, cascade, cascadeSide: dominant,
        biggest: this.biggest,
        count: this.events.length,
      };
    }
  }

  // ================= WHALE DETECTOR =================
  // Flags outsized market orders relative to the running average trade size.
  class WhaleDetector {
    constructor(demo) { this.demo = !!demo; this.reset(); }

    reset() {
      this.avg = 0;
      this.n = 0;
      this.orders = [];
      this.buyNotional = 0;
      this.sellNotional = 0;
      this.sizes = [];      // rolling sample of recent trade notionals
      this.threshold = 0;
    }

    // Threshold is the 99th percentile of recent trade sizes (with an
    // absolute floor) — this adapts across coins and volatility regimes,
    // unlike a fixed multiple of the mean.
    _recomputeThreshold() {
      if (this.sizes.length < 20) return;
      const sorted = this.sizes.slice().sort((a, b) => a - b);
      const p99 = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1];
      const floor = this.demo ? 250 : 20000;
      this.threshold = Math.max(floor, p99);
    }

    onTrade(t) {
      const notional = t.qty * t.price;
      this.n++;
      this.avg += (notional - this.avg) / Math.min(this.n, 500);
      this.sizes.push(notional);
      if (this.sizes.length > 500) this.sizes.shift();
      if (this.n % 25 === 0 || !this.threshold) this._recomputeThreshold();
      const threshold = this.threshold || (this.demo ? 250 : 20000);
      if (this.n > 20 && notional >= threshold) {
        const o = { side: t.side, notional, price: t.price, time: t.time || Date.now(), ratio: this.avg ? notional / this.avg : 0 };
        this.orders.push(o);
        if (this.orders.length > 40) this.orders.shift();
        if (t.side === 'buy') this.buyNotional += notional; else this.sellNotional += notional;
        return o;
      }
      return null;
    }

    snapshot() {
      const now = Date.now();
      const recent = this.orders.filter((o) => now - o.time < 900000); // 15 min
      let b = 0, s = 0;
      for (const o of recent) { if (o.side === 'buy') b += o.notional; else s += o.notional; }
      const total = b + s;
      return {
        recent: recent.slice(-8).reverse(),
        buyNotional: b, sellNotional: s,
        bias: total ? (b - s) / total : 0,
        count: recent.length,
        threshold: this.threshold || (this.demo ? 250 : 20000),
      };
    }
  }

  // ================= TRADING SESSIONS =================
  function activeSessions(date) {
    const h = (date || new Date()).getUTCHours() + (date || new Date()).getUTCMinutes() / 60;
    return CFG.SESSIONS.filter((s) => h >= s.start && h < s.end);
  }

  function sessionInfo(date) {
    const d = date || new Date();
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    const active = activeSessions(d);
    // next session boundary
    let next = null, minDelta = Infinity;
    for (const s of CFG.SESSIONS) {
      const delta = (s.start - h + 24) % 24;
      if (delta > 0 && delta < minDelta) { minDelta = delta; next = s; }
    }
    const overlap = active.length > 1;
    return {
      active,
      names: active.map((s) => s.name),
      label: active.length ? active.map((s) => s.short).join(' + ') : 'Off-hours',
      overlap,
      next,
      nextInMinutes: next ? Math.round(minDelta * 60) : null,
      note: overlap
        ? `${active.map((s) => s.name).join(' / ')} overlap — historically the highest-volume, most volatile window.`
        : active.length
          ? `${active[0].name} session — ${active[0].id === 'asia' ? 'typically ranging, lower volume; ranges set here often get swept later.' : active[0].id === 'london' ? 'high volume, frequent stop-hunts of the Asian range.' : 'US flow, strong trends and the biggest liquidation cascades.'}`
          : 'Between sessions — thin liquidity, moves can be erratic and less reliable.',
    };
  }

  // ================= AI INTELLIGENCE NARRATOR =================
  // Streaming analyst feed (imported from the tradingmaster model): each
  // insight carries a category, severity, bias, headline and the evidence
  // behind it — never a bare BUY/SELL label.
  function insights(ctx) {
    const { analysis, candles, tf, flow, liq, whales, session, symbol, signal, price, pricePrecision } = ctx;
    if (!analysis || !candles || !candles.length) return { list: [], bias: 'neutral', bullish: 50 };
    const px = (v) => (typeof v === 'number' ? v.toFixed(pricePrecision) : v);
    const S = window.Signals;
    const list = [];
    const lastIdx = candles.length - 1;
    const push = (category, severity, bias, headline, detail) =>
      list.push({ category, severity, bias, headline, detail });

    // --- structure ---
    const trend = analysis.structure.trend;
    const ms = analysis.mstructure;
    push('structure', 'info', trend === 'up' ? 'bullish' : trend === 'down' ? 'bearish' : 'neutral',
      trend === 'up' ? 'Market structure remains bullish' : trend === 'down' ? 'Market structure remains bearish' : 'Market structure is neutral',
      `${symbol} on ${tf}: ${trend === 'range' ? 'price is ranging with no clean swing sequence' : `swings are making ${trend === 'up' ? 'higher highs and higher lows' : 'lower highs and lower lows'}`}. Price ${px(price)}, sitting in ${ms ? ms.zone : 'the range'}${ms ? ` of the ${px(ms.rangeLow)}–${px(ms.rangeHigh)} dealing range (EQ ${px(ms.eq)})` : ''}.`);

    if (ms && ms.external !== ms.internal && ms.internal !== 'neutral' && ms.external !== 'neutral') {
      push('structure', 'warning', ms.internal, 'Potential reversal forming',
        `Internal structure shifted ${ms.internal} against the external ${ms.external} trend — an early reversal warning. Reversal probability ${ms.reversal}%.`);
    }

    const lastEv = analysis.structure.events[analysis.structure.events.length - 1];
    if (lastEv && lastIdx - lastEv.idx <= 8) {
      push('structure', lastEv.kind === 'CHoCH' ? 'critical' : 'info', lastEv.dir === 'up' ? 'bullish' : 'bearish',
        lastEv.kind === 'CHoCH' ? `Change of character ${lastEv.dir}` : `Break of structure ${lastEv.dir}`,
        `Price closed ${lastEv.dir === 'up' ? 'above' : 'below'} ${px(lastEv.level)} ${lastEv.idx === lastIdx ? 'on this bar' : `${lastIdx - lastEv.idx} bars ago`}. ${lastEv.kind === 'CHoCH' ? 'This is the first break against the prevailing trend — treat prior levels as suspect.' : 'Continuation confirmed; pullbacks into the origin block are the higher-probability entries.'}`);
    }

    // --- liquidity ---
    const sweep = analysis.liquidity.sweeps[analysis.liquidity.sweeps.length - 1];
    if (sweep && lastIdx - sweep.idx <= 10) {
      push('liquidity', 'critical', sweep.dir === 'low' ? 'bullish' : 'bearish',
        sweep.dir === 'low' ? 'Liquidity swept below the lows' : 'Liquidity swept above the highs',
        `A wick ran ${sweep.dir === 'low' ? 'stops under' : 'stops above'} ${px(sweep.level)}${sweep.eq ? ' (equal ' + sweep.dir + 's)' : ''} and price closed back inside${sweep.volSpike ? ' on a volume spike' : ''}. That is engineered liquidity — the side that just got stopped out is now fuel for the opposite move.`);
    }
    const pool = analysis.liquidity.pools[0];
    if (pool) {
      push('liquidity', 'info', 'neutral', 'Resting liquidity is the next magnet',
        `Untapped ${pool.eq ? 'equal ' + pool.type + 's' : 'swing ' + pool.type} at ${px(pool.price)} — price is drawn toward resting stop orders, so expect a reaction there.`);
    }

    // --- order flow ---
    if (flow) {
      const rv = flow.relVolume;
      if (Math.abs(flow.skew) > 0.15) {
        push('order_flow', 'info', flow.skew > 0 ? 'bullish' : 'bearish',
          flow.skew > 0 ? 'Aggressive buy flow dominating' : 'Aggressive sell flow dominating',
          `${flow.skew > 0 ? flow.buyPct : flow.sellPct}% of this bar's taker flow is ${flow.skew > 0 ? 'buying' : 'selling'} (${S.fmtUsd(Math.abs(flow.delta))} net). Cumulative delta is ${flow.cvd >= 0 ? 'positive' : 'negative'} at ${S.fmtUsd(flow.cvd)}.`);
      }
      if (rv > 1.5) {
        push('order_flow', 'warning', 'neutral', 'Volume is running hot',
          `Bar volume is pacing ${rv.toFixed(1)}× the 20-bar average. ${sweep && lastIdx - sweep.idx <= 4 ? 'The stop-hunt flush is the cause.' : liq && liq.cascade ? 'A liquidation cascade is driving it.' : lastEv && lastIdx - lastEv.idx <= 4 ? 'Breakout participation after the structure break.' : 'No structural cause visible — treat as news or a large player working an order.'}`);
      } else if (rv < 0.6) {
        push('order_flow', 'info', 'neutral', 'Participation is thin',
          `Volume is only ${rv.toFixed(1)}× average. Moves on thin volume reverse easily — wait for volume to confirm any breakout.`);
      }
    }

    // --- VSA ---
    const vsa = (analysis.vsa || []).filter((v) => lastIdx - v.idx <= 6);
    const lastVsa = vsa[vsa.length - 1];
    if (lastVsa) {
      push('vsa', lastVsa.type === 'stopping-volume' || lastVsa.type === 'buying-climax' ? 'critical' : 'warning',
        lastVsa.bias, `VSA: ${lastVsa.label.toLowerCase()} detected`, lastVsa.note);
    }

    // --- moving averages ---
    const mas = analysis.mas;
    if (mas && mas.lines.length) {
      if (mas.cross) push('trend', 'critical', mas.cross.type === 'golden' ? 'bullish' : 'bearish',
        mas.cross.type === 'golden' ? 'Golden cross printed' : 'Death cross printed', mas.cross.note);
      const n = mas.nearest;
      if (n && Math.abs(n.distancePct) < 0.6) {
        push('trend', 'warning', n.above ? 'bullish' : 'bearish', `Price is testing the ${n.label}`,
          `${n.label} sits at ${px(n.value)}, only ${Math.abs(n.distancePct).toFixed(2)}% away. This is where trend traders defend — a clean reclaim or rejection here sets the next leg.`);
      } else {
        push('trend', 'info', mas.regime === 'bullish' ? 'bullish' : mas.regime === 'bearish' ? 'bearish' : 'neutral',
          `Price is ${mas.aboveCount}/${mas.total} key MAs ${mas.aboveCount >= mas.total / 2 ? 'above' : 'below'}`,
          `${mas.stacked ? 'MAs are fully stacked — a clean trending regime.' : 'MAs are tangled — a mixed, chop-prone regime.'} Nearest is the ${n ? n.label + ' at ' + px(n.value) : 'n/a'}.`);
      }
    }

    // --- liquidations ---
    if (liq && (liq.long + liq.short) > 0) {
      const side = liq.minuteLong > liq.minuteShort ? 'long' : 'short';
      push('liquidation', liq.cascade ? 'critical' : 'warning', side === 'long' ? 'bullish' : 'bearish',
        liq.cascade ? `Cascade: ${liq.cascadeSide}s being wiped out` : `${side === 'long' ? 'Long' : 'Short'} liquidations increasing`,
        `${S.fmtUsd(liq.long)} of longs and ${S.fmtUsd(liq.short)} of shorts have been force-closed since you opened the page, running at ${S.fmtUsd(liq.perMin)}/min. Forced ${side === 'long' ? 'selling' : 'buying'} exhausts that side — these flushes frequently mark short-term ${side === 'long' ? 'lows' : 'highs'}.`);
    }

    // --- whales ---
    if (whales && whales.count) {
      push('whales', 'warning', Math.abs(whales.bias) < 0.15 ? 'neutral' : whales.bias > 0 ? 'bullish' : 'bearish',
        'Large orders are hitting the tape',
        `${whales.count} prints above ${S.fmtUsd(whales.threshold)} in the last 15 minutes — ${S.fmtUsd(whales.buyNotional)} buying against ${S.fmtUsd(whales.sellNotional)} selling. ${Math.abs(whales.bias) < 0.15 ? 'Big players are two-way here, no clear side.' : whales.bias > 0 ? 'Size is leaning long.' : 'Size is leaning short.'}`);
    }

    // --- phase & areas ---
    push('phase', 'info', /accum|markup|weak selloff/.test(analysis.phase.phase) ? 'bullish' : /distrib|markdown|weak rally/.test(analysis.phase.phase) ? 'bearish' : 'neutral',
      `${cap(analysis.phase.phase)} phase`, `${cap(analysis.phase.note)}.${analysis.profile ? ` Heaviest buying sits near ${px(analysis.profile.buyArea)}, heaviest selling near ${px(analysis.profile.sellArea)}, with the most-traded price at ${px(analysis.profile.poc)}.` : ''}`);

    // --- session ---
    if (session) {
      push('session', session.overlap ? 'warning' : 'info', 'neutral',
        session.active.length ? `${session.label} session is live` : 'Between sessions',
        `${session.note}${session.next ? ` ${session.next.name} opens in ${fmtMins(session.nextInMinutes)}.` : ''}`);
    }

    // --- setup ---
    if (signal) {
      if (signal.direction === 'WAIT') {
        push('setup', 'info', 'neutral', 'No high-probability setup yet',
          `Composite confluence is ${signal.confidence}%, below the firing threshold. The engine is waiting for price to reach a zone of interest with agreeing flow rather than forcing a trade.`);
      } else {
        const L = signal.levels;
        push('setup', 'critical', signal.direction === 'LONG' ? 'bullish' : 'bearish',
          `${signal.direction} setup active at ${signal.confidence}% confluence`,
          `Entry ${px(L.entry)}, stop ${px(L.stop)}, targets ${px(L.t1)} and ${px(L.t2)} (1:${L.rr.toFixed(2)} R). Driven by: ${signal.factors.filter((f) => f.dir !== 0).slice(0, 3).map((f) => f.name.toLowerCase()).join(', ')}.`);
      }
    }

    // overall bias / probability
    const score = list.reduce((s, i) => s + (i.bias === 'bullish' ? 1 : i.bias === 'bearish' ? -1 : 0) * (i.severity === 'critical' ? 3 : i.severity === 'warning' ? 2 : 1), 0);
    const maxScore = list.reduce((s, i) => s + (i.severity === 'critical' ? 3 : i.severity === 'warning' ? 2 : 1), 0) || 1;
    const bullish = Math.round(50 + (score / maxScore) * 50);
    return {
      list,
      bias: bullish > 58 ? 'bullish' : bullish < 42 ? 'bearish' : 'neutral',
      bullish: Math.max(2, Math.min(98, bullish)),
    };
  }

  function recentMove(candles) {
    const n = candles.length;
    if (n < 6) return 0;
    const from = candles[n - 6].close;
    return ((candles[n - 1].close - from) / from) * 100;
  }

  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
  function fmtMins(m) {
    if (m == null) return '';
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? `${h}h ${mm}m` : `${mm}m`;
  }

  const api = { OrderFlowEngine, LiquidationEngine, WhaleDetector, activeSessions, sessionInfo, insights };
  if (typeof window !== 'undefined') window.Engines = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
