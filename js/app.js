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
    dash.setHistory(state.candles, liqBarsFor(state.symbol));
    feed.setKlineStream(state.symbol, state.tf);
    runAnalysis();
    refreshStats();
    setStatus(state.demo ? 'demo' : 'live', state.demo ? 'DEMO DATA' : 'LIVE');
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
      if (last && candle.time === last.time) return; // stale
      state.liveCandle = candle;
      dash.updateCandle(candle);
      scheduleLiveAnalysis();
    }
    updatePriceHeader(candle.close);
  }

  function onAggTrade(t) {
    // rolling delta readout in the stats strip for the active symbol
    if (t.symbol !== state.symbol) return;
    rollDelta(t);
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
    reasoning.fromAnalysis(state.symbol, state.tf, state.candles, analysisResult);
  }

  function scheduleLiveAnalysis() {
    if (analyzeTimer) return;
    analyzeTimer = setTimeout(() => {
      analyzeTimer = null;
      // analyze including the live candle so entries react in real time
      if (!state.liveCandle) return;
      const merged = state.candles.concat([state.liveCandle]);
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
    }, 2500);
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
