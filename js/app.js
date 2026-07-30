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
  const flowEngine = new window.Engines.OrderFlowEngine();
  const liqEngine = new window.Engines.LiquidationEngine();
  let whaleEngine = new window.Engines.WhaleDetector(false);
  let dash = null;
  let analysisResult = null;
  let signal = null;
  let analyzeTimer = null;

  // Surface any runtime error on the page itself so remote users can report it.
  window.addEventListener('error', (e) => {
    const el = document.getElementById('errBanner');
    if (el) {
      el.textContent = '⚠ App error: ' + (e.message || 'unknown') + ' — please hard-refresh (Ctrl+Shift+R); if it persists, screenshot this message.';
      el.classList.remove('hidden');
    }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- boot ----------
  async function boot() {
    buildTabs();
    buildTfPills();
    buildLayerToggles();
    dash = new window.Dashboard($('#chart'), symMeta().pricePrecision);
    applyPreset('simple'); // needs the chart to exist

    feed.on('kline', (m) => { lastWsKline = Date.now(); onKline(m); });
    feed.on('aggTrade', onAggTrade);
    feed.on('forceOrder', onForceOrder);
    feed.on('status', onStatus);

    const bt = $('#buildTag');
    if (bt) bt.textContent = 'v' + CFG.VERSION;

    await loadSymbol();
    if (!state.demo) feed.connect();
    setInterval(refreshStats, 60000);
    setInterval(renderCountdown, 1000);
    setInterval(flushDirtyCandle, 250);
    setInterval(wsWatchdog, 4000);
    setInterval(renderEngines, 1000); // AI intelligence + order flow tick every second
    checkForUpdate();
    setInterval(checkForUpdate, 60000);
  }

  // ---- auto-update: if a newer deploy exists, reload with a cache-busting
  // URL so stale CDN/browser caches can never pin users to an old build ----
  let reloadedForUpdate = false;
  async function checkForUpdate() {
    if (reloadedForUpdate) return;
    try {
      const res = await fetch('version.json?ts=' + Date.now(), { cache: 'no-store' });
      const v = (await res.json()).version;
      if (typeof v === 'number' && v > CFG.VERSION) {
        reloadedForUpdate = true;
        window.location.replace(window.location.pathname + '?_v=' + v);
      }
    } catch (e) { /* offline or blocked — ignore */ }
  }

  function symMeta() { return CFG.SYMBOLS.find((s) => s.id === state.symbol); }

  async function loadSymbol() {
    setStatus('loading', `Loading ${state.symbol} ${state.tf}…`);
    dash.setPricePrecision(symMeta().pricePrecision);
    reasoning.clear();
    try {
      if (state.demo) throw new Error('demo');
      try {
        state.candles = await feed.fetchKlines(state.symbol, state.tf, CFG.HISTORY_LIMIT);
      } catch (e1) {
        await sleep(1500); // transient failure — retry once before giving up on live data
        state.candles = await feed.fetchKlines(state.symbol, state.tf, CFG.HISTORY_LIMIT);
      }
    } catch (e) {
      if (!state.demo) {
        state.demo = true;
        feed.enterDemoMode();
        $('#demoBanner').classList.remove('hidden');
      }
      state.candles = feed.demoKlines(state.symbol, state.tf, CFG.HISTORY_LIMIT);
    }
    state.liveCandle = null;
    candleDirty = null;
    lastWsKline = Date.now(); // grace period before the polling fallback kicks in
    flowEngine.reset();
    whaleEngine = new window.Engines.WhaleDetector(state.demo);
    flowEngine.seed(state.candles);
    if (state.candles.length) flowEngine.setBar(state.candles[state.candles.length - 1]);
    dash.setHistory(state.candles, liqBarsFor(state.symbol));
    dash.setSessions(state.candles, state.tf);
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
    lastDataAt = Date.now();
    flowEngine.setBar(candle); // exact per-bar buy/sell split from the candle
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
    lastDataAt = Date.now();
    rollDelta(t);
    updatePriceHeader(t.price); // tick-by-tick price, faster than kline pushes
    applyTradeToCandle(t);      // move the forming candle on every trade
    flowEngine.onTrade(t);
    if (whaleEngine.onTrade(t)) { renderWhales(); pushWhaleMarker(); }
  }

  // ---- tick-level candle movement ----
  // Every trade nudges the forming candle immediately instead of waiting
  // for the next kline push; flushed to the chart at up to 4 fps.
  let candleDirty = null;
  function applyTradeToCandle(t) {
    const step = window.intervalSeconds(state.tf);
    const bucket = Math.floor(t.time / 1000 / step) * step;
    let c = state.liveCandle;
    const last = state.candles[state.candles.length - 1];
    if (!c && last && last.time === bucket) c = last;
    if (c && c.time === bucket) {
      c.close = t.price;
      c.high = Math.max(c.high, t.price);
      c.low = Math.min(c.low, t.price);
      c.volume += t.qty;
      c.delta += t.side === 'buy' ? t.qty : -t.qty;
    } else if (!c || bucket > c.time) {
      // a new bucket opened before the first kline push arrived
      c = {
        time: bucket, open: t.price, high: t.price, low: t.price, close: t.price,
        volume: t.qty, delta: t.side === 'buy' ? t.qty : -t.qty, closed: false,
      };
      state.liveCandle = c;
    } else {
      return;
    }
    candleDirty = c;
  }

  function flushDirtyCandle() {
    if (!candleDirty || !dash) return;
    flowEngine.setBar(candleDirty);
    dash.updateCandle({ ...candleDirty });
    candleDirty = null;
  }

  // ---- candle-close countdown + data-freshness readout ----
  let lastDataAt = Date.now(); // any kline/trade for the active symbol
  function renderCountdown() {
    const el = $('#countdown');
    if (!el) return;
    const step = window.intervalSeconds(state.tf);
    const now = Math.floor(Date.now() / 1000);
    const last = state.liveCandle || state.candles[state.candles.length - 1];
    const closeAt = last ? last.time + step : (Math.floor(now / step) + 1) * step;
    const remaining = Math.max(0, closeAt - now);
    const age = (Date.now() - lastDataAt) / 1000;
    const ageTxt = age < 2 ? 'live' : `${age.toFixed(0)}s ago`;
    el.innerHTML = `${state.tf} candle closes in ${fmtDur(remaining)} · <span class="${age < 5 ? 'pos' : 'neg'}">data: ${ageTxt}</span>`;
  }

  function fmtDur(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    if (d) return `${d}d ${String(h).padStart(2, '0')}:${mm}:${ss}`;
    if (h) return `${h}:${mm}:${ss}`;
    return `${mm}:${ss}`;
  }

  // ---- WebSocket watchdog: fall back to fast REST polling if the kline
  // stream goes quiet (some networks block WebSockets entirely) ----
  let lastWsKline = Date.now();
  let pollTimer = null;
  function wsWatchdog() {
    if (state.demo) return;
    const stale = Date.now() - lastWsKline > 8000;
    if (stale && !pollTimer) {
      pollTimer = setInterval(pollKlines, 1500);
      setStatus('live', 'LIVE · POLLING');
    } else if (!stale && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      setStatus('live', 'LIVE');
    }
  }

  async function pollKlines() {
    if (state.demo) return;
    try {
      const rows = await feed.fetchKlines(state.symbol, state.tf, 2);
      if (!rows.length) return;
      if (rows.length === 2) onKline({ symbol: state.symbol, interval: state.tf, candle: { ...rows[0], closed: true } });
      const lastRow = { ...rows[rows.length - 1], closed: false };
      onKline({ symbol: state.symbol, interval: state.tf, candle: lastRow });
    } catch (e) { /* transient — next poll retries */ }
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
    if (o.symbol === state.symbol) {
      dash.updateLiquidationBar(bar);
      liqEngine.onLiquidation(o, step);
      renderLiquidationEngine();
    }
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
    dash.setMAs(analysisResult.mas);
    dash.setTechnicals(analysisResult.ta, state.candles);
    renderSignalEngine();
    renderTrendBadge();
    renderEngines();
    applySR();
    reasoning.fromAnalysis(state.symbol, state.tf, state.candles, analysisResult);
  }

  // ---- AI intelligence + engine panels (re-rendered every second) ----
  function barProgress() {
    const step = window.intervalSeconds(state.tf);
    const last = state.liveCandle || state.candles[state.candles.length - 1];
    if (!last) return 1;
    const elapsed = Math.floor(Date.now() / 1000) - last.time;
    return Math.min(1, Math.max(0.02, elapsed / step));
  }

  function renderEngines() {
    // each panel is isolated: one failing renderer must never blank the others
    for (const [name, fn] of [
      ['intelligence', renderIntelligence],
      ['signal', renderSignalEngine],
      ['technicals', renderTechnicals],
      ['vsa', renderVSA],
      ['mas', renderMAs],
      ['orderflow', renderOrderFlow],
      ['liquidations', renderLiquidationEngine],
      ['structure', renderMarketStructure],
      ['whales', renderWhales],
      ['sessions', renderSessions],
    ]) {
      try { fn(); } catch (e) { console.error('panel ' + name + ' failed:', e); }
    }
  }

  // ---- signal engine (fires only on strong confluence) ----
  function renderSignalEngine() {
    const el = $('#signalEngine');
    if (!el || !signal) return;
    const p = symMeta().pricePrecision;
    if (signal.direction === 'WAIT' || !signal.levels) {
      el.innerHTML = `<div class="sig-empty">
        <div class="sig-empty-icon">🎯</div>
        <div>No high-probability setup right now.<br>
        Composite confidence <b>${signal.confidence}%</b> is below the signal threshold — the engine only fires on strong confluence.</div>
      </div>`;
      return;
    }
    const L = signal.levels;
    el.innerHTML = `
      <div class="sig-row">
        <span class="sig-direction ${signal.direction === 'LONG' ? 'pos' : 'neg'}">${signal.direction}</span>
        <div class="sig-conf">
          <div class="conf-top"><span>confluence</span><b>${signal.confidence}%</b></div>
          <div class="conf-track"><div class="conf-fill ${signal.direction === 'LONG' ? 'fill-pos' : 'fill-neg'}" style="width:${signal.confidence}%"></div></div>
        </div>
      </div>
      <div class="sig-levels">
        <div class="level"><span>Entry zone</span><b class="entry-c">${L.entry.toFixed(p)}</b></div>
        <div class="level"><span>Stop loss</span><b class="neg">${L.stop.toFixed(p)}</b></div>
        <div class="level"><span>Target 1</span><b class="pos">${L.t1.toFixed(p)}</b></div>
        <div class="level"><span>Target 2</span><b class="pos">${L.t2.toFixed(p)}</b></div>
        <div class="level"><span>Risk : Reward</span><b>1 : ${L.rr.toFixed(2)}</b></div>
      </div>
      <div class="card-subtitle">Why</div>
      <div class="sig-factors">${signal.factors.map((f) => `
        <div class="factor">
          <span class="factor-dot ${f.dir > 0 ? 'dot-pos' : f.dir < 0 ? 'dot-neg' : 'dot-wait'}"></span>
          <div><div class="factor-name">${escapeText(f.name)} <span class="factor-w">w${f.weight}</span></div>
          <div class="factor-note">${escapeText(f.note)}</div></div>
        </div>`).join('')}</div>`;
  }

  // ---- market structure & liquidity ----
  function renderMarketStructure() {
    const el = $('#mstructure');
    if (!el || !analysisResult || !analysisResult.mstructure) return;
    const m = analysisResult.mstructure;
    const p = symMeta().pricePrecision;
    const badge = (txt, cls) => `<span class="ms-badge ${cls}">${txt}</span>`;
    const extCls = m.external === 'bullish' ? 'bull' : m.external === 'bearish' ? 'bear' : 'neutral';
    const intCls = m.internal === 'bullish' ? 'bull' : m.internal === 'bearish' ? 'bear' : 'neutral';
    const zoneCls = m.zone === 'premium' ? 'bear' : m.zone === 'discount' ? 'bull' : 'neutral';
    const events = m.recentEvents.map((e) => `
      <div class="ms-event">
        <span class="ms-scope">${e.scope} ${e.kind}</span>
        <span class="${e.dir === 'up' ? 'pos' : 'neg'}">${e.dir === 'up' ? '▲' : '▼'}</span>
        <span class="ms-at">@${e.level.toFixed(p)}</span>
      </div>`).join('');
    el.innerHTML = `
      <div class="ms-badges">
        ${badge('EXTERNAL ' + m.external.toUpperCase(), extCls)}
        ${badge('INTERNAL ' + m.internal.toUpperCase(), intCls)}
        ${badge(m.zone.toUpperCase(), zoneCls)}
      </div>
      <div class="of-grid tight">
        <div class="of-cell"><span>Continuation</span><b class="${m.continuation >= 50 ? 'pos' : ''}">${m.continuation}%</b></div>
        <div class="of-cell"><span>Reversal</span><b class="${m.reversal > 50 ? 'neg' : ''}">${m.reversal}%</b></div>
      </div>
      <div class="ms-range">
        <div class="ms-range-head">
          <span>${m.rangeLow.toFixed(p)}</span>
          <span>EQ ${m.eq.toFixed(p)}</span>
          <span>${m.rangeHigh.toFixed(p)}</span>
        </div>
        <div class="ms-bar"><span class="ms-dot" style="left:${(m.position * 100).toFixed(1)}%"></span></div>
        <div class="ms-range-head"><span class="pos">DISCOUNT</span><span class="neg">PREMIUM</span></div>
      </div>
      <div class="ms-events">${events || '<span class="muted">no recent structure events</span>'}</div>
      ${m.reasons.length ? `<div class="ms-note">${escapeText(m.reasons[0])}.</div>` : ''}`;
  }

  // ---- AI intelligence: streaming analyst feed ----
  const aiFeed = { items: [], seen: new Map() };

  function renderIntelligence() {
    const el = $('#knowledge');
    if (!el || !analysisResult) return;
    const res = window.Engines.insights({
      analysis: analysisResult,
      candles: state.candles,
      tf: state.tf,
      symbol: symMeta().base,
      signal,
      price: (state.liveCandle || state.candles[state.candles.length - 1]).close,
      pricePrecision: symMeta().pricePrecision,
      flow: flowEngine.snapshot(barProgress()),
      liq: liqEngine.snapshot(),
      whales: whaleEngine.snapshot(),
      session: window.Engines.sessionInfo(),
    });

    // stream in only genuinely new headlines; allow re-surfacing after 3 min
    const now = Date.now();
    const fresh = [];
    for (const ins of res.list) {
      const key = `${ins.category}:${ins.headline}`;
      const last = aiFeed.seen.get(key);
      if (last && now - last < 180000) continue;
      aiFeed.seen.set(key, now);
      fresh.push({ ...ins, time: now });
    }
    if (fresh.length) {
      aiFeed.items = fresh.reverse().concat(aiFeed.items).slice(0, 40);
    }

    const dot = (s) => s === 'critical' ? 'sev-critical' : s === 'warning' ? 'sev-warning' : 'sev-info';
    const head = `
      <div class="ai-head">
        <span class="bias-badge ${res.bias}">${res.bias.toUpperCase()} BIAS</span>
        <span class="ai-meta">${symMeta().base} · ${state.tf}</span>
      </div>
      <div class="prob-wrap">
        <div class="prob-track"><div class="prob-fill" style="width:${res.bullish}%"></div></div>
        <div class="prob-legend"><span class="pos">${res.bullish}% bullish</span><span class="neg">${100 - res.bullish}% bearish</span></div>
      </div>`;

    const body = aiFeed.items.length
      ? aiFeed.items.map((ins) => `
        <article class="insight ${ins.bias}">
          <div class="insight-head">
            <span class="sev ${dot(ins.severity)}"></span>
            <h4 class="insight-title ${ins.bias}">${escapeText(ins.headline)}</h4>
            <time class="insight-time">${timeAgo(ins.time)}</time>
          </div>
          <p class="insight-detail">${escapeText(ins.detail)}</p>
        </article>`).join('')
      : '<p class="ai-empty">Analyst warming up — insights arrive within seconds…</p>';

    el.innerHTML = head + `<div class="insight-list">${body}</div>`;
    const stamp = $('#aiStamp');
    if (stamp) stamp.textContent = new Date().toLocaleTimeString();
  }

  function timeAgo(t) {
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 10) return 'now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  // ---- technical analysis panel ----
  function renderTechnicals() {
    const el = $('#technicals');
    if (!el || !analysisResult || !analysisResult.ta) return;
    const ta = analysisResult.ta;
    const p = symMeta().pricePrecision;
    const rows = ta.readings.map((r) => `
      <details class="ind">
        <summary>
          <span class="ind-dot ${r.bias}"></span>
          <span class="ind-name">${escapeText(r.label)}</span>
          <b class="ind-val ${r.bias}">${escapeText(r.value)}</b>
        </summary>
        <p class="ind-note">${escapeText(r.note)}</p>
      </details>`).join('');
    const pat = ta.patterns.length ? `
      <div class="card-subtitle">Candle patterns</div>
      <div class="pattern-list">${ta.patterns.map((x) => `
        <div class="pattern ${x.bias}">
          <b>${escapeText(x.name)}</b>
          <span class="muted">${x.barsAgo === 0 ? 'this bar' : x.barsAgo + ' bars ago'}</span>
          <div class="pattern-note">${escapeText(x.note)}</div>
        </div>`).join('')}</div>` : '';
    const piv = ta.pivots ? `
      <div class="card-subtitle">Pivot levels</div>
      <div class="pivot-row">
        <span class="neg">R2 ${ta.pivots.r2.toFixed(p)}</span>
        <span class="neg">R1 ${ta.pivots.r1.toFixed(p)}</span>
        <span>P ${ta.pivots.p.toFixed(p)}</span>
        <span class="pos">S1 ${ta.pivots.s1.toFixed(p)}</span>
        <span class="pos">S2 ${ta.pivots.s2.toFixed(p)}</span>
      </div>` : '';
    el.innerHTML = `
      <div class="ta-head">
        <span class="ms-badge ${ta.verdict === 'bullish' ? 'bull' : ta.verdict === 'bearish' ? 'bear' : 'neutral'}">${ta.verdict.toUpperCase()}</span>
        <div class="ta-score">
          <div class="prob-track"><div class="prob-fill" style="width:${ta.score}%"></div></div>
          <span class="muted">${ta.score}% of indicators lean bullish</span>
        </div>
      </div>
      <div class="ind-list">${rows}</div>
      ${pat}${piv}`;
  }

  // ---- volume spread analysis panel ----
  function renderVSA() {
    const el = $('#vsa');
    if (!el || !analysisResult) return;
    const vsa = analysisResult.vsa || [];
    const lastIdx = state.candles.length - 1;
    const recent = vsa.slice(-6).reverse();
    const counts = {};
    for (const v of vsa) counts[v.type] = (counts[v.type] || 0) + 1;
    const bullN = vsa.filter((v) => v.bias === 'bullish').length;
    const bearN = vsa.filter((v) => v.bias === 'bearish').length;
    const verdict = bullN > bearN * 1.3 ? 'Supply is drying up — net bullish signatures'
      : bearN > bullN * 1.3 ? 'Supply is overwhelming demand — net bearish signatures'
      : 'Mixed signatures — no clear VSA edge right now';
    el.innerHTML = `
      <div class="of-grid tight">
        <div class="of-cell"><span>Bullish signatures</span><b class="pos">${bullN}</b></div>
        <div class="of-cell"><span>Bearish signatures</span><b class="neg">${bearN}</b></div>
      </div>
      <div class="ms-note">${escapeText(verdict)} (last ${Math.min(120, state.candles.length)} bars).</div>
      <div class="vsa-list">
        ${recent.length ? recent.map((v) => `
          <div class="vsa-item ${v.bias}">
            <div class="vsa-head">
              <span class="vsa-tag ${v.bias}">${escapeText(v.label)}</span>
              <span class="vsa-meta">spread ${v.spreadR.toFixed(1)}× · vol ${v.volR.toFixed(1)}× · ${lastIdx - v.idx === 0 ? 'this bar' : (lastIdx - v.idx) + ' bars ago'}</span>
            </div>
            <div class="vsa-note">${escapeText(v.note)}</div>
          </div>`).join('')
          : '<span class="muted">no unusual volume/spread activity in range</span>'}
      </div>`;
  }

  // ---- key moving averages panel ----
  function renderMAs() {
    const el = $('#mas');
    if (!el || !analysisResult || !analysisResult.mas) return;
    const m = analysisResult.mas;
    const p = symMeta().pricePrecision;
    const rows = m.lines.slice().sort((a, b) => b.value - a.value).map((l) => `
      <div class="ma-row">
        <span class="ma-swatch" style="background:${CFG.COLORS['ma' + l.len] || CFG.COLORS.ma200}"></span>
        <span class="ma-name">${l.label}</span>
        <b class="ma-val">${l.value.toFixed(p)}</b>
        <span class="ma-dist ${l.above ? 'pos' : 'neg'}">${l.above ? '+' : ''}${l.distancePct.toFixed(2)}%</span>
      </div>`).join('');
    el.innerHTML = `
      <div class="ms-badges">
        <span class="ms-badge ${m.regime === 'bullish' ? 'bull' : m.regime === 'bearish' ? 'bear' : 'neutral'}">${m.regime.toUpperCase()} REGIME</span>
        <span class="ms-badge neutral">${m.aboveCount}/${m.total} ABOVE</span>
        ${m.cross ? `<span class="ms-badge ${m.cross.type === 'golden' ? 'bull' : 'bear'}">${m.cross.type.toUpperCase()} CROSS</span>` : ''}
      </div>
      <div class="ma-list">${rows || '<span class="muted">not enough history for MAs on this timeframe</span>'}</div>
      ${m.cross ? `<div class="ms-note">${escapeText(m.cross.note)}</div>` : m.nearest ? `<div class="ms-note">Nearest level: ${m.nearest.label} at ${m.nearest.value.toFixed(p)} (${Math.abs(m.nearest.distancePct).toFixed(2)}% away) — the line trend traders defend.</div>` : ''}`;
  }

  // ---- signal engine (fires only on strong confluence) ----
  function renderSignalEngine() {
    const el = $('#signalEngine');
    if (!el || !signal) return;
    const p = symMeta().pricePrecision;
    if (signal.direction === 'WAIT' || !signal.levels) {
      el.innerHTML = `<div class="sig-empty">
        <div class="sig-empty-icon">🎯</div>
        <div>No high-probability setup right now.<br>
        Composite confidence <b>${signal.confidence}%</b> is below the signal threshold — the engine only fires on strong confluence.</div>
      </div>`;
      return;
    }
    const L = signal.levels;
    el.innerHTML = `
      <div class="sig-row">
        <span class="sig-direction ${signal.direction === 'LONG' ? 'pos' : 'neg'}">${signal.direction}</span>
        <div class="sig-conf">
          <div class="conf-top"><span>confluence</span><b>${signal.confidence}%</b></div>
          <div class="conf-track"><div class="conf-fill ${signal.direction === 'LONG' ? 'fill-pos' : 'fill-neg'}" style="width:${signal.confidence}%"></div></div>
        </div>
      </div>
      <div class="sig-levels">
        <div class="level"><span>Entry zone</span><b class="entry-c">${L.entry.toFixed(p)}</b></div>
        <div class="level"><span>Stop loss</span><b class="neg">${L.stop.toFixed(p)}</b></div>
        <div class="level"><span>Target 1</span><b class="pos">${L.t1.toFixed(p)}</b></div>
        <div class="level"><span>Target 2</span><b class="pos">${L.t2.toFixed(p)}</b></div>
        <div class="level"><span>Risk : Reward</span><b>1 : ${L.rr.toFixed(2)}</b></div>
      </div>
      <div class="card-subtitle">Why</div>
      <div class="sig-factors">${signal.factors.map((f) => `
        <div class="factor">
          <span class="factor-dot ${f.dir > 0 ? 'dot-pos' : f.dir < 0 ? 'dot-neg' : 'dot-wait'}"></span>
          <div><div class="factor-name">${escapeText(f.name)} <span class="factor-w">w${f.weight}</span></div>
          <div class="factor-note">${escapeText(f.note)}</div></div>
        </div>`).join('')}</div>`;
  }

  // ---- market structure & liquidity ----
  function renderMarketStructure() {
    const el = $('#mstructure');
    if (!el || !analysisResult || !analysisResult.mstructure) return;
    const m = analysisResult.mstructure;
    const p = symMeta().pricePrecision;
    const badge = (txt, cls) => `<span class="ms-badge ${cls}">${txt}</span>`;
    const extCls = m.external === 'bullish' ? 'bull' : m.external === 'bearish' ? 'bear' : 'neutral';
    const intCls = m.internal === 'bullish' ? 'bull' : m.internal === 'bearish' ? 'bear' : 'neutral';
    const zoneCls = m.zone === 'premium' ? 'bear' : m.zone === 'discount' ? 'bull' : 'neutral';
    const events = m.recentEvents.map((e) => `
      <div class="ms-event">
        <span class="ms-scope">${e.scope} ${e.kind}</span>
        <span class="${e.dir === 'up' ? 'pos' : 'neg'}">${e.dir === 'up' ? '▲' : '▼'}</span>
        <span class="ms-at">@${e.level.toFixed(p)}</span>
      </div>`).join('');
    el.innerHTML = `
      <div class="ms-badges">
        ${badge('EXTERNAL ' + m.external.toUpperCase(), extCls)}
        ${badge('INTERNAL ' + m.internal.toUpperCase(), intCls)}
        ${badge(m.zone.toUpperCase(), zoneCls)}
      </div>
      <div class="of-grid tight">
        <div class="of-cell"><span>Continuation</span><b class="${m.continuation >= 50 ? 'pos' : ''}">${m.continuation}%</b></div>
        <div class="of-cell"><span>Reversal</span><b class="${m.reversal > 50 ? 'neg' : ''}">${m.reversal}%</b></div>
      </div>
      <div class="ms-range">
        <div class="ms-range-head">
          <span>${m.rangeLow.toFixed(p)}</span>
          <span>EQ ${m.eq.toFixed(p)}</span>
          <span>${m.rangeHigh.toFixed(p)}</span>
        </div>
        <div class="ms-bar"><span class="ms-dot" style="left:${(m.position * 100).toFixed(1)}%"></span></div>
        <div class="ms-range-head"><span class="pos">DISCOUNT</span><span class="neg">PREMIUM</span></div>
      </div>
      <div class="ms-events">${events || '<span class="muted">no recent structure events</span>'}</div>
      ${m.reasons.length ? `<div class="ms-note">${escapeText(m.reasons[0])}.</div>` : ''}`;
  }

  function renderOrderFlow() {
    const el = $('#orderflow');
    if (!el) return;
    const f = flowEngine.snapshot(barProgress());
    const S = window.Signals;
    const gauge = (pct, color, label) => {
      const r = 26, circ = 2 * Math.PI * r;
      const dash = (pct / 100) * circ;
      return `<div class="gauge">
        <svg viewBox="0 0 64 64" class="gauge-svg" aria-hidden="true">
          <circle cx="32" cy="32" r="${r}" class="gauge-track"></circle>
          <circle cx="32" cy="32" r="${r}" stroke="${color}" stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}" class="gauge-fill"></circle>
        </svg>
        <span class="gauge-val" style="color:${color}">${pct}</span>
        <span class="gauge-label">${label}</span>
      </div>`;
    };
    const maxD = Math.max(1, ...f.deltaBars.map((b) => Math.abs(b.delta)));
    const spark = f.deltaBars.map((b) => {
      const h = Math.max(8, Math.round((Math.abs(b.delta) / maxD) * 100));
      const up = b.delta >= 0;
      return `<span class="ofb ${up ? 'up' : 'down'}" style="height:${h}%; align-self:${up ? 'flex-end' : 'flex-start'}"></span>`;
    }).join('');
    el.innerHTML = `
      <div class="gauges">
        ${gauge(f.buyPct, CFG.COLORS.up, 'Buy<br>pressure')}
        ${gauge(f.sellPct, CFG.COLORS.down, 'Sell<br>pressure')}
      </div>
      <div class="of-sparkhead"><span>Delta per bar</span><b class="${f.cvd >= 0 ? 'pos' : 'neg'}">CVD ${S.fmtUsd(f.cvd)}</b></div>
      <div class="of-spark">${spark || '<span class="muted">collecting…</span>'}</div>
      <div class="of-grid">
        <div class="of-cell"><span>Buying vol (bar)</span><b class="pos">${S.fmtUsd(f.barBuy)}</b></div>
        <div class="of-cell"><span>Selling vol (bar)</span><b class="neg">${S.fmtUsd(f.barSell)}</b></div>
        <div class="of-cell"><span>Relative volume</span><b>${f.relVolume.toFixed(2)}×</b></div>
        <div class="of-cell"><span>Aggression</span><b class="${f.skew > 0.15 ? 'pos' : f.skew < -0.15 ? 'neg' : ''}">${f.aggression}</b></div>
      </div>`;
  }

  function renderLiquidationEngine() {
    const el = $('#liqEngine');
    if (!el) return;
    const L = liqEngine.analysis({ candles: state.candles });
    const S = window.Signals;
    const tile = (label, val, cls) => `<div class="liq-tile"><b class="${cls || ''}">${val}</b><span>${label}</span></div>`;
    el.innerHTML = `
      <div class="liq-tiles">
        ${tile('LONG PRESSURE', L.longPressure, L.longPressure > 50 ? 'long-c' : '')}
        ${tile('SHORT PRESSURE', L.shortPressure, L.shortPressure > 50 ? 'short-c' : '')}
        ${tile('CASCADE RISK', L.cascadeRisk, L.cascadeRisk > 50 ? 'neg' : '')}
      </div>
      <div class="ms-badges">
        ${L.whaleDriven ? '<span class="ms-badge purple">WHALE-DRIVEN</span>' : ''}
        <span class="ms-badge ${L.reversalOdds >= 55 ? 'bull' : 'neutral'}">REVERSAL ODDS ${L.reversalOdds}%</span>
      </div>
      <ul class="liq-bullets">${L.bullets.map((b) => `<li>${escapeText(b)}</li>`).join('')}</ul>
      <div class="of-grid tight">
        <div class="of-cell"><span>Longs rekt</span><b class="long-c">${S.fmtUsd(L.long)}</b></div>
        <div class="of-cell"><span>Shorts rekt</span><b class="short-c">${S.fmtUsd(L.short)}</b></div>
        <div class="of-cell"><span>Rate</span><b>${S.fmtUsd(L.perMin)}/min</b></div>
        <div class="of-cell"><span>Biggest</span><b>${L.biggest ? S.fmtUsd(L.biggest.notional) : '—'}</b></div>
      </div>`;
  }

  // plot whale prints on the price chart, snapped to their candle bucket
  function pushWhaleMarker() {
    const step = window.intervalSeconds(state.tf);
    const orders = whaleEngine.snapshot().recent.map((o) => ({
      ...o, barTime: Math.floor(o.time / 1000 / step) * step,
    }));
    dash.setWhales(orders);
  }

  function renderWhales() {
    const el = $('#whales');
    if (!el) return;
    const W = whaleEngine.snapshot();
    const S = window.Signals;
    const p = symMeta().pricePrecision;
    const rows = W.recent.map((o) => {
      const t = new Date(o.time);
      return `<div class="ko-row ${o.side}">
        <span>${o.side === 'buy' ? '🟢 BUY' : '🔴 SELL'}</span>
        <b>${S.fmtUsd(o.notional)}</b>
        <span class="muted">@ ${o.price.toFixed(p)}</span>
        <span class="ko-time">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span>
      </div>`;
    }).join('');
    const biasTxt = Math.abs(W.bias) < 0.15 ? 'Two-way' : W.bias > 0 ? 'Buying' : 'Selling';
    el.innerHTML = `
      <div class="of-grid tight">
        <div class="of-cell"><span>Whale bias (15m)</span><b class="${W.bias > 0.15 ? 'pos' : W.bias < -0.15 ? 'neg' : ''}">${biasTxt}</b></div>
        <div class="of-cell"><span>Trigger size</span><b>${S.fmtUsd(W.threshold)}</b></div>
      </div>
      <div class="whale-list">${rows || '<span class="muted">watching for large market orders…</span>'}</div>`;
  }

  function renderSessions() {
    const el = $('#sessions');
    if (!el) return;
    const info = window.Engines.sessionInfo();
    const chips = CFG.SESSIONS.map((s) => {
      const on = info.active.some((a) => a.id === s.id);
      return `<span class="sess-chip ${s.id} ${on ? 'on' : ''}">${s.emoji} ${s.name}${on ? ' · LIVE' : ''}</span>`;
    }).join('');
    const utc = new Date().toUTCString().slice(17, 25);
    el.innerHTML = `
      <div class="sess-chips">${chips}</div>
      <div class="k-body">${escapeText(info.note)}</div>
      <div class="sess-meta"><span>UTC ${utc}</span>${info.next ? `<span>${info.next.name} opens in ${fmtMinsShort(info.nextInMinutes)}</span>` : ''}</div>`;
  }

  function fmtMinsShort(m) {
    if (m == null) return '';
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? `${h}h ${mm}m` : `${mm}m`;
  }

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
      dash.setMAs(a.mas);
      dash.setTechnicals(a.ta, merged);
      renderSignalEngine();
      renderTrendBadge();
      renderEngines();
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

  // Presets keep the chart approachable: Simple shows just price context,
  // Smart money adds the SMC layers, Everything turns all of it on.
  const PRESETS = {
    simple:  { zones: false, vsa: true,  mas: true,  bb: false, vwap: false, pivots: false, sr: false, liquidity: false, markers: false, fib: false, levels: false, whales: false, sessions: true },
    smart:   { zones: true,  vsa: true,  mas: true,  bb: false, vwap: false, pivots: false, sr: true,  liquidity: true,  markers: true,  fib: false, levels: true,  whales: true,  sessions: true },
    full:    { zones: true,  vsa: true,  mas: true,  bb: true,  vwap: true,  pivots: true,  sr: true,  liquidity: true,  markers: true,  fib: true,  levels: true,  whales: true,  sessions: true },
  };

  function buildLayerToggles() {
    document.querySelectorAll('[data-layer]').forEach((cb) => {
      cb.addEventListener('change', () => dash.setLayer(cb.dataset.layer, cb.checked));
    });
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyPreset(btn.dataset.preset);
        document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
  }

  function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    for (const [layer, on] of Object.entries(preset)) {
      const cb = document.querySelector(`[data-layer="${layer}"]`);
      if (cb) cb.checked = on;
      dash.setLayer(layer, on);
    }
  }

  // rAF-throttled: BTC pushes dozens of trades per second
  let pricePending = null, priceRaf = null;
  function updatePriceHeader(price) {
    pricePending = price;
    if (priceRaf) return;
    priceRaf = requestAnimationFrame(() => {
      priceRaf = null;
      const el = $('#livePrice');
      const prev = parseFloat(el.dataset.prev || '0');
      el.textContent = pricePending.toFixed(symMeta().pricePrecision);
      el.className = 'live-price ' + (pricePending >= prev ? 'pos' : 'neg');
      el.dataset.prev = pricePending;
    });
  }

  function renderTrendBadge() {
    const el = $('#trendBadge');
    if (!analysisResult) return;
    const t = analysisResult.structure.trend;
    el.textContent = t === 'up' ? 'UPTREND' : t === 'down' ? 'DOWNTREND' : 'RANGE';
    el.className = 'badge ' + (t === 'up' ? 'badge-up' : t === 'down' ? 'badge-down' : 'badge-neutral');
  }

  async function refreshStats() {
    let st;
    try {
      st = state.demo ? feed.demoStats(state.symbol) : await feed.fetchStats(state.symbol);
    } catch (e) { return; }
    state.stats[state.symbol] = st;
    const p = symMeta().pricePrecision;
    $('#stat-funding').textContent = (st.funding * 100).toFixed(4) + '%';
    $('#stat-funding').className = 'stat-value ' + (st.funding >= 0 ? 'pos' : 'neg');
    $('#stat-oi').textContent = window.Signals.fmtUsd(st.openInterest * st.markPrice);
    $('#stat-change').textContent = (st.change24h >= 0 ? '+' : '') + st.change24h.toFixed(2) + '%';
    $('#stat-change').className = 'stat-value ' + (st.change24h >= 0 ? 'pos' : 'neg');
    $('#stat-vol24').textContent = window.Signals.fmtUsd(st.volume24h);
    if (st.high24h) $('#stat-hl').textContent = `${st.high24h.toFixed(p)} / ${st.low24h.toFixed(p)}`;
    updatePriceHeader(st.lastPrice);
  }

  function setStatus(kind, text) {
    const el = $('#connStatus');
    el.textContent = text;
    el.className = 'conn ' + kind;
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
