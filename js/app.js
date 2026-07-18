// App glue: state per symbol, coin tabs, timeframe switching, wiring the
// feed -> analysis -> signal -> chart/panels render loop.
(function () {
  const CFG = window.CFG;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    symbol: CFG.SYMBOLS[0].id,
    tf: CFG.DEFAULT_TF,
    candles: [],          // closed candles for active symbol+tf
    liveCandle: null,
    liq: {},              // per symbol: {long, short, bars: Map(bucketTime -> {long, short})}
    stats: {},            // per symbol REST stats
    demo: false,
  };
  for (const s of CFG.SYMBOLS) state.liq[s.id] = { long: 0, short: 0, bars: new Map() };

  const feed = new window.Feed();
  const reasoning = new window.Reasoning($('#feed'));
  let dash = null;
  let analysisResult = null;
  let signal = null;
  let analyzeTimer = null;

  // ---------- boot ----------
  async function boot() {
    buildTabs();
    buildTfPills();
    buildLayerToggles();
    dash = new window.Dashboard($('#chart'), symMeta().pricePrecision);

    feed.on('kline', onKline);
    feed.on('aggTrade', onAggTrade);
    feed.on('forceOrder', onForceOrder);
    feed.on('status', onStatus);

    await loadSymbol();
    if (!state.demo) feed.connect();
    setInterval(refreshStats, 60000);
  }

  function symMeta() { return CFG.SYMBOLS.find((s) => s.id === state.symbol); }

  async function loadSymbol() {
    setStatus('loading', `Loading ${state.symbol} ${state.tf}…`);
    dash.setPricePrecision(symMeta().pricePrecision);
    reasoning.clear();
    try {
      if (state.demo) throw new Error('demo');
      state.candles = await feed.fetchKlines(state.symbol, state.tf, CFG.HISTORY_LIMIT);
    } catch (e) {
      if (!state.demo) {
        state.demo = true;
        feed.enterDemoMode();
        $('#demoBanner').classList.remove('hidden');
      }
      state.candles = feed.demoKlines(state.symbol, state.tf, CFG.HISTORY_LIMIT);
    }
    state.liveCandle = null;
    bigOrders.avg = 0; bigOrders.n = 0; bigOrders.list = [];
    dash.setHistory(state.candles, liqBarsFor(state.symbol));
    feed.setKlineStream(state.symbol, state.tf);
    runAnalysis();
    refreshStats();
    loadSR(); // multi-timeframe S/R in the background
    setStatus(state.demo ? 'demo' : 'live', state.demo ? 'DEMO DATA' : 'LIVE');
  }

  // ---- multi-timeframe support / resistance ----
  async function loadSR() {
    const sym = state.symbol;
    const jobs = CFG.SR_TIMEFRAMES.map(async ([tf, label]) => {
      try {
        const cs = state.demo
          ? feed.demoKlines(sym, tf, tf === '1M' ? 120 : 250)
          : await feed.fetchKlines(sym, tf, tf === '1M' ? 120 : 250);
        return window.Analysis.srLevels(cs, label);
      } catch (e) { return []; }
    });
    const levels = (await Promise.all(jobs)).flat();
    if (sym !== state.symbol) return; // user switched coins meanwhile
    state.sr = levels;
    applySR();
  }

  function applySR() {
    if (!state.sr || !state.candles.length) return;
    const price = state.candles[state.candles.length - 1].close;
    const near = state.sr
      .filter((l) => Math.abs(l.price - price) / price < 0.25)
      .map((l) => ({ ...l, kind: l.price >= price ? 'R' : 'S' }))
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, 8);
    dash.setSR(near);
    state.srNear = near;
  }

  // ---------- feed handlers ----------
  function onKline({ symbol, interval, candle }) {
    if (symbol !== state.symbol || interval !== state.tf) return;
    const last = state.candles[state.candles.length - 1];
    if (candle.closed) {
      if (last && last.time === candle.time) state.candles[state.candles.length - 1] = candle;
      else if (!last || candle.time > last.time) state.candles.push(candle);
      if (state.candles.length > CFG.HISTORY_LIMIT + 100) state.candles.splice(0, state.candles.length - CFG.HISTORY_LIMIT);
      state.liveCandle = null;
      dash.updateCandle(candle);
      runAnalysis();
    } else {
      // Binance's kline history includes the still-forming candle as its
      // last row, so live updates for that same bucket must REPLACE it —
      // this is what keeps candles moving without a page refresh.
      if (last && candle.time === last.time) {
        state.candles[state.candles.length - 1] = candle;
      } else {
        state.liveCandle = candle;
      }
      dash.updateCandle(candle);
      scheduleLiveAnalysis();
    }
    updatePriceHeader(candle.close);
  }

  function onAggTrade(t) {
    if (t.symbol !== state.symbol) return;
    rollDelta(t);
    trackBigOrder(t);
    updatePriceHeader(t.price); // tick-by-tick price, faster than kline pushes
  }

  // ---- big orders (whale prints) ----
  const bigOrders = { avg: 0, n: 0, list: [] };
  function trackBigOrder(t) {
    const notional = t.qty * t.price;
    bigOrders.n++;
    bigOrders.avg += (notional - bigOrders.avg) / Math.min(bigOrders.n, 500);
    const threshold = Math.max(state.demo ? 400 : 15000, bigOrders.avg * 25);
    if (bigOrders.n > 30 && notional >= threshold) {
      bigOrders.list.push({ side: t.side, notional, price: t.price, time: Date.now() });
      if (bigOrders.list.length > 6) bigOrders.list.shift();
      renderKnowledge();
    }
  }

  const deltaWindow = [];
  function rollDelta(t) {
    const now = Date.now();
    deltaWindow.push({ time: now, signed: (t.side === 'buy' ? 1 : -1) * t.qty * t.price });
    while (deltaWindow.length && now - deltaWindow[0].time > 60000) deltaWindow.shift();
    const net = deltaWindow.reduce((s, x) => s + x.signed, 0);
    const el = $('#stat-delta1m');
    if (el) {
      el.textContent = window.Signals.fmtUsd(net).replace('$', net >= 0 ? '+$' : '-$');
      el.className = 'stat-value ' + (net >= 0 ? 'pos' : 'neg');
    }
  }

  function onForceOrder(o) {
    const rec = state.liq[o.symbol];
    if (!rec) return;
    rec[o.liquidated] += o.notional;
    // bucket by active timeframe for the chart pane
    const step = window.intervalSeconds(state.tf);
    const bucket = Math.floor(o.time / 1000 / step) * step;
    const bar = rec.bars.get(bucket) || { time: bucket, long: 0, short: 0 };
    bar[o.liquidated] += o.notional;
    rec.bars.set(bucket, bar);
    if (o.symbol === state.symbol) dash.updateLiquidationBar(bar);
    updateLiqPanel();
    // narrate meaningful bursts only
    burstTracker.add(o);
  }

  const burstTracker = {
    acc: {},
    add(o) {
      const key = `${o.symbol}:${o.liquidated}`;
      const now = Date.now();
      const rec = this.acc[key] || { notional: 0, first: now, lastPrice: o.price };
      if (now - rec.first > 15000) { rec.notional = 0; rec.first = now; }
      rec.notional += o.notional;
      rec.lastPrice = o.price;
      this.acc[key] = rec;
      if (rec.notional > (state.demo ? 5000 : 20000)) {
        reasoning.liquidationBurst(o.symbol, o.liquidated, rec.notional, rec.lastPrice);
        rec.notional = 0;
      }
    },
  };

  function liqBarsFor(symbol) {
    const rec = state.liq[symbol];
    const step = window.intervalSeconds(state.tf);
    const out = [];
    for (const [bucket, bar] of rec.bars) {
      // rebucket if timeframe changed
      const b = Math.floor(bucket / step) * step;
      const found = out.find((x) => x.time === b);
      if (found) { found.long += bar.long; found.short += bar.short; }
      else out.push({ time: b, long: bar.long, short: bar.short });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  function onStatus(s) {
    if (s.demo) return;
    setStatus(s.connected ? 'live' : 'reconnect', s.connected ? 'LIVE' : 'RECONNECTING…');
  }

  // ---------- analysis / signal ----------
  function runAnalysis() {
    analysisResult = window.Analysis.analyze(state.candles);
    if (!analysisResult) return;
    signal = window.Signals.computeSignal({
      candles: state.candles,
      analysis: analysisResult,
      liq: recentLiq(),
      funding: (state.stats[state.symbol] || {}).funding,
    });
    dash.applyAnalysis(analysisResult, signal);
    renderSignalCard();
    renderTrendBadge();
    renderKnowledge();
    applySR();
    reasoning.fromAnalysis(state.symbol, state.tf, state.candles, analysisResult);
  }

  // ---- market knowledge panel ----
  function renderKnowledge() {
    const el = $('#knowledge');
    if (!el || !analysisResult) return;
    const a = analysisResult;
    const S = window.Signals;
    const candles = state.candles;
    const lastIdx = candles.length - 1;
    const last = candles[lastIdx];
    const p = symMeta().pricePrecision;
    const px = (v) => (typeof v === 'number' ? v.toFixed(p) : v);
    const sections = [];

    // 1. what's happening
    const trend = a.structure.trend;
    const lastEv = a.structure.events[a.structure.events.length - 1];
    const sweep = a.liquidity.sweeps[a.liquidity.sweeps.length - 1];
    let story = trend === 'up' ? 'Structure is bullish (higher highs and higher lows).'
      : trend === 'down' ? 'Structure is bearish (lower highs and lower lows).'
      : 'Price is ranging with no clear structure.';
    if (lastEv && lastIdx - lastEv.idx <= 10) {
      story += ` Most recent event: ${lastEv.kind} ${lastEv.dir} through ${px(lastEv.level)}${lastEv.kind === 'CHoCH' ? ' — an early reversal warning' : ' — trend confirmation'}.`;
    }
    if (sweep && lastIdx - sweep.idx <= 8) {
      story += ` A liquidity hunt just ran stops ${sweep.dir === 'low' ? 'below' : 'above'} ${px(sweep.level)}.`;
    }
    sections.push(['What’s happening', story]);

    // 2. volume: change + why
    const vAvg = a.lastVolSMA;
    const recentV = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
    const ratio = vAvg ? recentV / vAvg : 1;
    const recentD = candles.slice(-3).reduce((s, c) => s + c.delta, 0);
    let volTxt;
    if (ratio > 1.4) volTxt = `Volume is pumping — ${ratio.toFixed(1)}× its average, dominated by ${recentD >= 0 ? 'aggressive buyers' : 'aggressive sellers'} (3-bar delta ${S.fmtQty(recentD)}).`;
    else if (ratio < 0.7) volTxt = `Volume is drying up (${ratio.toFixed(1)}× average) — moves here are less reliable, watch for the next injection of volume.`;
    else volTxt = `Volume is normal (${ratio.toFixed(1)}× average), net flow ${recentD >= 0 ? 'buy' : 'sell'}-side (${S.fmtQty(recentD)}).`;
    if (ratio > 1.4) {
      if (sweep && lastIdx - sweep.idx <= 5) volTxt += ' Likely cause: the stop-hunt flush forcing traders out.';
      else if (lastEv && lastIdx - lastEv.idx <= 5) volTxt += ` Likely cause: breakout participation after the ${lastEv.kind}.`;
      else volTxt += ' No obvious structural catalyst — possibly news-driven or a large player working an order.';
    }
    sections.push(['Volume', volTxt]);

    // 3. phase: accumulation / distribution
    sections.push(['Phase', `${cap(a.phase.phase)} — ${a.phase.note}.`]);

    // 4. buying / selling areas (volume profile)
    if (a.profile) {
      sections.push(['Key areas', `Heaviest BUYING around ${px(a.profile.buyArea)} · heaviest SELLING around ${px(a.profile.sellArea)} · most traded price (POC) ${px(a.profile.poc)}. Expect reactions when price revisits these.`]);
    }

    // 5. double top / bottom
    if (a.doublePattern) {
      const dp = a.doublePattern;
      sections.push([dp.type === 'double-top' ? 'Double top' : 'Double bottom',
        `${dp.type === 'double-top' ? 'Double top' : 'Double bottom'} at ${px(dp.level)} (neckline ${px(dp.neckline)}). Estimated ~${dp.breakChance}% chance the level BREAKS: ${dp.reasons.join('; ')}.`]);
    }

    // 6. nearest S/R with strength
    if (state.srNear && state.srNear.length) {
      const res = state.srNear.filter((l) => l.kind === 'R')[0];
      const sup = state.srNear.filter((l) => l.kind === 'S')[0];
      const bits = [];
      if (res) bits.push(`resistance ${px(res.price)} (${res.tf}, ${res.strength}, ${res.touches} touches)`);
      if (sup) bits.push(`support ${px(sup.price)} (${sup.tf}, ${sup.strength}, ${sup.touches} touches)`);
      if (bits.length) sections.push(['Nearest S/R', `Closest ${bits.join(' · ')}. Strength = how many times the level has been respected across hourly/daily/weekly/monthly charts.`]);
    }

    // 7. big orders
    if (bigOrders.list.length) {
      const rows = bigOrders.list.slice().reverse().map((o) => {
        const t = new Date(o.time);
        return `<div class="ko-row ${o.side}"><span>${o.side === 'buy' ? '🟢 BUY' : '🔴 SELL'}</span><b>${S.fmtUsd(o.notional)}</b><span>@ ${px(o.price)}</span><span class="ko-time">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}</span></div>`;
      }).join('');
      sections.push(['Big orders (whales)', rows, true]);
    }

    el.innerHTML = sections.map(([title, body, raw]) =>
      `<div class="k-section"><div class="k-title">${title}</div><div class="k-body">${raw ? body : escapeText(body)}</div></div>`
    ).join('');
    void last;
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function escapeText(s) {
    return String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  }

  function scheduleLiveAnalysis() {
    if (analyzeTimer) return;
    analyzeTimer = setTimeout(() => {
      analyzeTimer = null;
      // analyze including the live candle so everything reacts in real time
      const merged = state.liveCandle ? state.candles.concat([state.liveCandle]) : state.candles;
      const a = window.Analysis.analyze(merged);
      if (!a) return;
      analysisResult = a;
      signal = window.Signals.computeSignal({
        candles: merged, analysis: a, liq: recentLiq(),
        funding: (state.stats[state.symbol] || {}).funding,
      });
      dash.applyAnalysis(a, signal);
      renderSignalCard();
      renderTrendBadge();
      renderKnowledge();
    }, 1200);
  }

  function recentLiq() {
    const rec = state.liq[state.symbol];
    const step = window.intervalSeconds(state.tf);
    const cutoff = Math.floor(Date.now() / 1000 / step) * step - step * 3;
    let recentLong = 0, recentShort = 0;
    for (const [bucket, bar] of rec.bars) {
      if (bucket >= cutoff) { recentLong += bar.long; recentShort += bar.short; }
    }
    return { long: rec.long, short: rec.short, recentLong, recentShort };
  }

  // ---------- UI ----------
  function buildTabs() {
    const el = $('#tabs');
    el.innerHTML = CFG.SYMBOLS.map((s) => `
      <button class="tab ${s.id === state.symbol ? 'active' : ''}" data-sym="${s.id}">
        <span class="tab-base">${s.base}</span><span class="tab-name">${s.name}</span>
      </button>`).join('');
    el.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.sym === state.symbol) return;
      state.symbol = b.dataset.sym;
      el.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.sym === state.symbol));
      await loadSymbol();
    }));
  }

  function buildTfPills() {
    const el = $('#tfs');
    el.innerHTML = CFG.TIMEFRAMES.map((tf) => `<button class="pill ${tf === state.tf ? 'active' : ''}" data-tf="${tf}">${tf}</button>`).join('');
    el.querySelectorAll('.pill').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.tf === state.tf) return;
      state.tf = b.dataset.tf;
      el.querySelectorAll('.pill').forEach((x) => x.classList.toggle('active', x.dataset.tf === state.tf));
      await loadSymbol();
    }));
  }

  function buildLayerToggles() {
    document.querySelectorAll('[data-layer]').forEach((cb) => {
      cb.addEventListener('change', () => dash.setLayer(cb.dataset.layer, cb.checked));
    });
  }

  function updatePriceHeader(price) {
    const el = $('#livePrice');
    const prev = parseFloat(el.dataset.prev || '0');
    el.textContent = price.toFixed(symMeta().pricePrecision);
    el.className = 'live-price ' + (price >= prev ? 'pos' : 'neg');
    el.dataset.prev = price;
  }

  function renderTrendBadge() {
    const el = $('#trendBadge');
    if (!analysisResult) return;
    const t = analysisResult.structure.trend;
    el.textContent = t === 'up' ? 'UPTREND' : t === 'down' ? 'DOWNTREND' : 'RANGE';
    el.className = 'badge ' + (t === 'up' ? 'badge-up' : t === 'down' ? 'badge-down' : 'badge-neutral');
  }

  function renderSignalCard() {
    if (!signal) return;
    const dirEl = $('#sigDirection');
    dirEl.textContent = signal.direction;
    dirEl.className = 'sig-direction ' + (signal.direction === 'LONG' ? 'pos' : signal.direction === 'SHORT' ? 'neg' : 'wait');

    $('#sigConfidence').textContent = signal.confidence + '%';
    $('#sigConfBar').style.width = signal.confidence + '%';
    $('#sigConfBar').className = 'conf-fill ' + (signal.direction === 'LONG' ? 'fill-pos' : signal.direction === 'SHORT' ? 'fill-neg' : 'fill-wait');

    const lv = $('#sigLevels');
    if (signal.levels) {
      const p = symMeta().pricePrecision;
      const L = signal.levels;
      lv.innerHTML = `
        <div class="level"><span>Entry zone</span><b class="entry-c">${L.entry.toFixed(p)}</b></div>
        <div class="level"><span>Stop loss</span><b class="neg">${L.stop.toFixed(p)}</b></div>
        <div class="level"><span>Target 1</span><b class="pos">${L.t1.toFixed(p)}</b></div>
        <div class="level"><span>Target 2</span><b class="pos">${L.t2.toFixed(p)}</b></div>
        <div class="level"><span>Risk : Reward</span><b>1 : ${L.rr.toFixed(2)}</b></div>`;
    } else {
      lv.innerHTML = '<div class="level-wait">No high-confluence setup right now — waiting for price to reach a zone of interest.</div>';
    }

    $('#sigFactors').innerHTML = signal.factors.map((f) => `
      <div class="factor">
        <span class="factor-dot ${f.dir > 0 ? 'dot-pos' : f.dir < 0 ? 'dot-neg' : 'dot-wait'}"></span>
        <div><div class="factor-name">${f.name} <span class="factor-w">w${f.weight}</span></div>
        <div class="factor-note">${f.note}</div></div>
      </div>`).join('');
  }

  async function refreshStats() {
    let st;
    try {
      st = state.demo ? feed.demoStats(state.symbol) : await feed.fetchStats(state.symbol);
    } catch (e) { return; }
    state.stats[state.symbol] = st;
    $('#stat-funding').textContent = (st.funding * 100).toFixed(4) + '%';
    $('#stat-funding').className = 'stat-value ' + (st.funding >= 0 ? 'pos' : 'neg');
    $('#stat-oi').textContent = window.Signals.fmtUsd(st.openInterest * st.markPrice);
    $('#stat-change').textContent = (st.change24h >= 0 ? '+' : '') + st.change24h.toFixed(2) + '%';
    $('#stat-change').className = 'stat-value ' + (st.change24h >= 0 ? 'pos' : 'neg');
    $('#stat-vol24').textContent = window.Signals.fmtUsd(st.volume24h);
    if (st.high24h) $('#stat-hl').textContent = `${st.high24h.toFixed(symMeta().pricePrecision)} / ${st.low24h.toFixed(symMeta().pricePrecision)}`;
    updatePriceHeader(st.lastPrice);
  }

  function updateLiqPanel() {
    const rec = state.liq[state.symbol];
    $('#liq-long').textContent = window.Signals.fmtUsd(rec.long);
    $('#liq-short').textContent = window.Signals.fmtUsd(rec.short);
    const total = rec.long + rec.short;
    $('#liq-bar-long').style.width = total ? (rec.long / total * 100) + '%' : '50%';
  }

  function setStatus(kind, text) {
    const el = $('#connStatus');
    el.textContent = text;
    el.className = 'conn ' + kind;
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
