// Market data layer: Binance USDT-M futures REST + WebSocket, with a
// synthetic demo fallback when Binance is unreachable (e.g. blocked region).
(function () {
  const CFG = window.CFG;

  class Feed {
    constructor() {
      this.ws = null;
      this.wsId = 1;
      this.reconnectDelay = 1000;
      this.demo = false;
      this.subscribedKline = null; // 'uniusdt@kline_15m'
      this.handlers = { kline: [], aggTrade: [], forceOrder: [], status: [] };
      this._demoTimers = [];
    }

    on(type, fn) { this.handlers[type].push(fn); }
    _emit(type, payload) { this.handlers[type].forEach((fn) => fn(payload)); }

    // ---------- REST ----------
    async fetchKlines(symbol, interval, limit) {
      const url = `${CFG.REST_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await this._fetch(url);
      // kline: [openTime, o, h, l, c, vol, closeTime, quoteVol, trades, takerBuyBase, ...]
      return res.map((k) => {
        const vol = +k[5];
        const takerBuy = +k[9];
        return {
          time: Math.floor(k[0] / 1000),
          open: +k[1], high: +k[2], low: +k[3], close: +k[4],
          volume: vol,
          delta: 2 * takerBuy - vol, // taker buys minus taker sells
          closed: true,
        };
      });
    }

    async fetchStats(symbol) {
      const [premium, oi, ticker] = await Promise.all([
        this._fetch(`${CFG.REST_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`),
        this._fetch(`${CFG.REST_BASE}/fapi/v1/openInterest?symbol=${symbol}`),
        this._fetch(`${CFG.REST_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      ]);
      return {
        funding: +premium.lastFundingRate,
        markPrice: +premium.markPrice,
        openInterest: +oi.openInterest,
        change24h: +ticker.priceChangePercent,
        lastPrice: +ticker.lastPrice,
        volume24h: +ticker.quoteVolume,
        high24h: +ticker.highPrice,
        low24h: +ticker.lowPrice,
      };
    }

    async _fetch(url) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(t);
      }
    }

    // ---------- WebSocket ----------
    connect() {
      if (this.demo) return;
      const streams = [];
      for (const s of CFG.SYMBOLS) {
        const sym = s.id.toLowerCase();
        streams.push(`${sym}@aggTrade`, `${sym}@forceOrder`);
      }
      if (this.subscribedKline) streams.push(this.subscribedKline);
      try {
        this.ws = new WebSocket(`${CFG.WS_BASE}?streams=${streams.join('/')}`);
      } catch (e) {
        this._emit('status', { connected: false });
        return;
      }
      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
        this._emit('status', { connected: true });
      };
      this.ws.onmessage = (ev) => this._onMessage(ev);
      this.ws.onclose = () => {
        this._emit('status', { connected: false });
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      };
      this.ws.onerror = () => { try { this.ws.close(); } catch (e) { /* noop */ } };
    }

    setKlineStream(symbol, interval) {
      const stream = `${symbol.toLowerCase()}@kline_${interval}`;
      if (stream === this.subscribedKline) return;
      const prev = this.subscribedKline;
      this.subscribedKline = stream;
      if (this.demo) { this._restartDemoKline(symbol, interval); return; }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (prev) this._send('UNSUBSCRIBE', [prev]);
        this._send('SUBSCRIBE', [stream]);
      }
    }

    _send(method, params) {
      this.ws.send(JSON.stringify({ method, params, id: this.wsId++ }));
    }

    _onMessage(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const d = msg.data;
      if (!d || !d.e) return;
      if (d.e === 'kline') {
        const k = d.k;
        this._emit('kline', {
          symbol: d.s,
          interval: k.i,
          candle: {
            time: Math.floor(k.t / 1000),
            open: +k.o, high: +k.h, low: +k.l, close: +k.c,
            volume: +k.v,
            delta: 2 * +k.V - +k.v, // V = taker buy volume
            closed: k.x,
          },
        });
      } else if (d.e === 'aggTrade') {
        this._emit('aggTrade', {
          symbol: d.s,
          price: +d.p,
          qty: +d.q,
          // m=true: buyer is maker, i.e. an aggressive SELL hit the bid
          side: d.m ? 'sell' : 'buy',
          time: d.T,
        });
      } else if (d.e === 'forceOrder') {
        const o = d.o;
        this._emit('forceOrder', {
          symbol: o.s,
          // On a liquidation order, SELL = a long position was liquidated
          liquidated: o.S === 'SELL' ? 'long' : 'short',
          price: +o.ap || +o.p,
          qty: +o.q,
          notional: (+o.ap || +o.p) * +o.q,
          time: o.T,
        });
      }
    }

    // ---------- Demo fallback ----------
    enterDemoMode() {
      this.demo = true;
      if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) { /* noop */ } }
      this._emit('status', { connected: true, demo: true });
    }

    demoKlines(symbol, interval, limit) {
      const meta = CFG.SYMBOLS.find((s) => s.id === symbol);
      const step = intervalSeconds(interval);
      const now = Math.floor(Date.now() / 1000);
      const start = now - (now % step) - step * (limit - 1);
      let price = meta.sample;
      let rngState = hashCode(symbol + interval);
      const rand = () => {
        rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
        return rngState / 0x7fffffff;
      };
      const candles = [];
      let trendBias = 0;
      for (let i = 0; i < limit; i++) {
        if (i % 40 === 0) trendBias = (rand() - 0.5) * 0.004; // regime shift
        const drift = trendBias + (rand() - 0.5) * 0.006;
        const open = price;
        let close = open * (1 + drift);
        // occasional stop-hunt wick
        const hunt = rand() < 0.06;
        const wick = open * 0.004 * (1 + rand() * 2);
        let high = Math.max(open, close) + open * 0.0015 * rand();
        let low = Math.min(open, close) - open * 0.0015 * rand();
        if (hunt) { if (rand() < 0.5) low -= wick; else high += wick; }
        const vol = 20000 * (0.4 + rand() * (hunt ? 3.5 : 1.2));
        const deltaShare = (close >= open ? 1 : -1) * (0.1 + rand() * 0.5);
        candles.push({
          time: start + i * step,
          open: round(open), high: round(high), low: round(low), close: round(close),
          volume: vol, delta: vol * deltaShare, closed: true,
        });
        price = close;
      }
      function round(x) { return +x.toFixed(meta.pricePrecision); }
      return candles;
    }

    _restartDemoKline(symbol, interval) {
      this._demoTimers.forEach(clearInterval);
      this._demoTimers = [];
      const meta = CFG.SYMBOLS.find((s) => s.id === symbol);
      const step = intervalSeconds(interval);
      let last = null;
      const tick = () => {
        const now = Math.floor(Date.now() / 1000);
        const bucket = now - (now % step);
        const px = (last ? last.close : meta.sample) * (1 + (Math.random() - 0.5) * 0.002);
        if (!last || last.time !== bucket) {
          if (last) { last.closed = true; this._emit('kline', { symbol, interval, candle: last }); }
          last = { time: bucket, open: px, high: px, low: px, close: px, volume: 0, delta: 0, closed: false };
        }
        last.close = px;
        last.high = Math.max(last.high, px);
        last.low = Math.min(last.low, px);
        const q = 200 + Math.random() * 800;
        last.volume += q;
        const side = Math.random() < 0.5 ? 'buy' : 'sell';
        last.delta += side === 'buy' ? q : -q;
        this._emit('kline', { symbol, interval, candle: { ...last } });
        this._emit('aggTrade', { symbol, price: px, qty: q / px, side, time: Date.now() });
        if (Math.random() < 0.04) {
          this._emit('forceOrder', {
            symbol: CFG.SYMBOLS[Math.floor(Math.random() * CFG.SYMBOLS.length)].id,
            liquidated: Math.random() < 0.5 ? 'long' : 'short',
            price: px, qty: q / px, notional: q * (1 + Math.random() * 20), time: Date.now(),
          });
        }
      };
      this._demoTimers.push(setInterval(tick, 900));
      tick();
    }

    demoStats(symbol) {
      const meta = CFG.SYMBOLS.find((s) => s.id === symbol);
      return {
        funding: (Math.random() - 0.45) * 0.0004,
        markPrice: meta.sample,
        openInterest: 2500000 + Math.random() * 500000,
        change24h: (Math.random() - 0.5) * 8,
        lastPrice: meta.sample,
        volume24h: 50e6 + Math.random() * 20e6,
        high24h: meta.sample * 1.04,
        low24h: meta.sample * 0.96,
      };
    }
  }

  function intervalSeconds(tf) {
    const n = parseInt(tf, 10);
    if (tf.endsWith('M')) return n * 2592000; // calendar month, approximated
    if (tf.endsWith('w')) return n * 604800;
    if (tf.endsWith('d')) return n * 86400;
    if (tf.endsWith('h')) return n * 3600;
    if (tf.endsWith('m')) return n * 60;
    return 900;
  }

  function hashCode(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) & 0x7fffffff; }
    return h;
  }

  window.Feed = Feed;
  window.intervalSeconds = intervalSeconds;
})();
