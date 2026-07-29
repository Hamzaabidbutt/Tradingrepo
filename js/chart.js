// Chart layer: lightweight-charts v5 with 4 panes (price, volume,
// delta+CVD, liquidations), a custom primitive that paints order-block /
// FVG zones, structure markers and entry/stop/target lines.
(function () {
  const LWC = window.LightweightCharts;
  const C = window.CFG.COLORS;
  const C_SESSIONS = window.CFG.SESSIONS.map((s) => ({
    ...s,
    color: s.id === 'asia' ? C.sessionAsia : s.id === 'london' ? C.sessionLondon : C.sessionNY,
  }));

  // ----- custom primitive: translucent zone rectangles extending right -----
  class ZonesPrimitive {
    constructor() {
      this.zones = []; // {timeStart, top, bottom, color, border, label}
      this._chart = null;
      this._series = null;
      this._requestUpdate = null;
      const self = this;
      this._paneView = {
        renderer() {
          return {
            draw(target) {
              target.useBitmapCoordinateSpace((scope) => self._draw(scope));
            },
          };
        },
        zOrder() { return 'bottom'; },
      };
    }

    attached({ chart, series, requestUpdate }) {
      this._chart = chart;
      this._series = series;
      this._requestUpdate = requestUpdate;
    }

    detached() { this._chart = null; this._series = null; }

    paneViews() { return [this._paneView]; }

    setZones(zones) {
      this.zones = zones;
      if (this._requestUpdate) this._requestUpdate();
    }

    _draw(scope) {
      if (!this._chart || !this._series) return;
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const ts = this._chart.timeScale();
      const range = ts.getVisibleRange();
      if (!range) return;
      const rightEdge = scope.bitmapSize.width;
      ctx.save();
      ctx.font = `${Math.round(10 * vr)}px 'Inter', sans-serif`;
      for (const z of this.zones) {
        if (z.timeStart > range.to) continue;
        let x1 = ts.timeToCoordinate(z.timeStart);
        if (x1 === null) x1 = z.timeStart < range.from ? 0 : null;
        if (x1 === null) continue;
        const yTop = this._series.priceToCoordinate(z.top);
        const yBot = this._series.priceToCoordinate(z.bottom);
        if (yTop === null || yBot === null) continue;
        const bx = Math.round(x1 * hr);
        const by = Math.round(Math.min(yTop, yBot) * vr);
        const bh = Math.max(1, Math.round(Math.abs(yBot - yTop) * vr));
        ctx.fillStyle = z.color;
        ctx.fillRect(bx, by, rightEdge - bx, bh);
        if (z.border) {
          ctx.strokeStyle = z.border;
          ctx.lineWidth = Math.max(1, Math.round(hr));
          ctx.strokeRect(bx, by, rightEdge - bx, bh);
        }
        if (z.label) {
          ctx.fillStyle = z.labelColor || C.inkMuted;
          ctx.fillText(z.label, bx + 4 * hr, by + Math.min(bh - 2, 11 * vr));
        }
      }
      ctx.restore();
    }
  }

  // ----- custom primitive: fibonacci lines + golden pocket band -----
  class FibPrimitive {
    constructor() {
      this.fib = null;
      this._chart = null;
      this._series = null;
      this._requestUpdate = null;
      const self = this;
      this._paneView = {
        renderer() {
          return { draw(target) { target.useBitmapCoordinateSpace((scope) => self._draw(scope)); } };
        },
        zOrder() { return 'bottom'; },
      };
    }

    attached({ chart, series, requestUpdate }) {
      this._chart = chart; this._series = series; this._requestUpdate = requestUpdate;
    }
    detached() { this._chart = null; this._series = null; }
    paneViews() { return [this._paneView]; }
    setFib(fib) { this.fib = fib; if (this._requestUpdate) this._requestUpdate(); }

    _draw(scope) {
      if (!this._chart || !this._series || !this.fib) return;
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const ts = this._chart.timeScale();
      const range = ts.getVisibleRange();
      if (!range) return;
      const f = this.fib;
      let x1 = ts.timeToCoordinate(f.startTime);
      if (x1 === null) x1 = f.startTime < range.from ? 0 : null;
      if (x1 === null) return;
      const bx = Math.round(x1 * hr);
      const rightEdge = scope.bitmapSize.width;
      ctx.save();
      // golden pocket band
      const gTop = this._series.priceToCoordinate(f.golden.top);
      const gBot = this._series.priceToCoordinate(f.golden.bottom);
      if (gTop !== null && gBot !== null) {
        ctx.fillStyle = C.fibGold;
        ctx.fillRect(bx, Math.round(gTop * vr), rightEdge - bx, Math.max(1, Math.round((gBot - gTop) * vr)));
      }
      ctx.font = `${Math.round(9.5 * vr)}px 'Inter', sans-serif`;
      for (const lv of f.levels) {
        const y = this._series.priceToCoordinate(lv.price);
        if (y === null) continue;
        const by = Math.round(y * vr);
        ctx.strokeStyle = C.fibLine;
        ctx.lineWidth = Math.max(1, Math.round(hr * (lv.ext ? 0.5 : 1)));
        ctx.setLineDash(lv.ext ? [6 * hr, 5 * hr] : [2 * hr, 3 * hr]);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(rightEdge, by);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.fibLabel;
        ctx.fillText(`Fib ${lv.label}`, bx + 4 * hr, by - 3 * vr);
      }
      ctx.restore();
    }
  }

  // ----- custom primitive: multi-timeframe support/resistance lines -----
  class SRPrimitive {
    constructor() {
      this.levels = []; // {price, tf, strength, touches, kind:'S'|'R'}
      this._chart = null;
      this._series = null;
      this._requestUpdate = null;
      const self = this;
      this._paneView = {
        renderer() {
          return { draw(target) { target.useBitmapCoordinateSpace((scope) => self._draw(scope)); } };
        },
        zOrder() { return 'bottom'; },
      };
    }
    attached({ chart, series, requestUpdate }) { this._chart = chart; this._series = series; this._requestUpdate = requestUpdate; }
    detached() { this._chart = null; this._series = null; }
    paneViews() { return [this._paneView]; }
    setLevels(levels) { this.levels = levels || []; if (this._requestUpdate) this._requestUpdate(); }

    _draw(scope) {
      if (!this._chart || !this._series || !this.levels.length) return;
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const width = scope.bitmapSize.width;
      ctx.save();
      ctx.font = `600 ${Math.round(9.5 * vr)}px 'Inter', sans-serif`;
      for (const lv of this.levels) {
        const y = this._series.priceToCoordinate(lv.price);
        if (y === null) continue;
        const by = Math.round(y * vr);
        const color = lv.kind === 'S' ? C.srSupport : C.srResistance;
        const w = lv.strength === 'strong' ? 2.5 : lv.strength === 'medium' ? 1.6 : 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, Math.round(w * hr));
        ctx.setLineDash([8 * hr, 4 * hr]);
        ctx.beginPath();
        ctx.moveTo(0, by);
        ctx.lineTo(width, by);
        ctx.stroke();
        ctx.setLineDash([]);
        const stars = lv.strength === 'strong' ? '★★★' : lv.strength === 'medium' ? '★★' : '★';
        ctx.fillStyle = color;
        ctx.fillText(`${lv.kind === 'S' ? 'SUP' : 'RES'} ${lv.tf} ${stars} (${lv.touches}x)`, 8 * hr, by - 3 * vr);
      }
      ctx.restore();
    }
  }

  // ----- custom primitive: trading-session background bands -----
  class SessionsPrimitive {
    constructor() {
      this.bands = []; // {from, to, color, label}
      this._chart = null;
      this._requestUpdate = null;
      const self = this;
      this._paneView = {
        renderer() {
          return { draw(target) { target.useBitmapCoordinateSpace((scope) => self._draw(scope)); } };
        },
        zOrder() { return 'bottom'; },
      };
    }
    attached({ chart, requestUpdate }) { this._chart = chart; this._requestUpdate = requestUpdate; }
    detached() { this._chart = null; }
    paneViews() { return [this._paneView]; }
    setBands(bands) { this.bands = bands || []; if (this._requestUpdate) this._requestUpdate(); }

    _draw(scope) {
      if (!this._chart || !this.bands.length) return;
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const ts = this._chart.timeScale();
      const range = ts.getVisibleRange();
      if (!range) return;
      const h = scope.bitmapSize.height;
      ctx.save();
      ctx.font = `600 ${Math.round(9 * vr)}px 'Inter', sans-serif`;
      for (const b of this.bands) {
        if (b.to < range.from || b.from > range.to) continue;
        let x1 = ts.timeToCoordinate(Math.max(b.from, range.from));
        let x2 = ts.timeToCoordinate(Math.min(b.to, range.to));
        if (x1 === null || x2 === null || x2 <= x1) continue;
        const bx = Math.round(x1 * hr), bw = Math.round((x2 - x1) * hr);
        ctx.fillStyle = b.color;
        ctx.fillRect(bx, 0, bw, h);
        if (bw > 40 * hr && b.label) {
          ctx.fillStyle = 'rgba(139,147,167,0.75)';
          ctx.fillText(b.label, bx + 5 * hr, h - 6 * vr);
        }
      }
      ctx.restore();
    }
  }

  // ----- custom primitive: whale orders plotted at their trade price -----
  class WhalePrimitive {
    constructor() {
      this.orders = []; // {time, price, side, notional, ratio}
      this._chart = null;
      this._series = null;
      this._requestUpdate = null;
      const self = this;
      this._paneView = {
        renderer() {
          return { draw(target) { target.useBitmapCoordinateSpace((scope) => self._draw(scope)); } };
        },
        zOrder() { return 'top'; },
      };
    }
    attached({ chart, series, requestUpdate }) { this._chart = chart; this._series = series; this._requestUpdate = requestUpdate; }
    detached() { this._chart = null; this._series = null; }
    paneViews() { return [this._paneView]; }
    setOrders(orders) { this.orders = orders || []; if (this._requestUpdate) this._requestUpdate(); }

    _draw(scope) {
      if (!this._chart || !this._series || !this.orders.length) return;
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const ts = this._chart.timeScale();
      const maxN = Math.max(...this.orders.map((o) => o.notional));
      ctx.save();
      ctx.font = `600 ${Math.round(9 * vr)}px 'Inter', sans-serif`;
      for (const o of this.orders) {
        const x = ts.timeToCoordinate(o.barTime);
        const y = this._series.priceToCoordinate(o.price);
        if (x === null || y === null) continue;
        const rel = maxN ? o.notional / maxN : 0.5;
        const r = (4 + rel * 7) * Math.min(hr, vr);
        const bx = x * hr, by = y * vr;
        const color = o.side === 'buy' ? C.up : C.down;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fillStyle = color + 'aa';
        ctx.fill();
        ctx.lineWidth = Math.max(1, Math.round(1.5 * hr));
        ctx.strokeStyle = color;
        ctx.stroke();
        if (rel > 0.55) {
          ctx.fillStyle = color;
          ctx.fillText('🐋 ' + fmtNum(o.notional), bx + r + 3 * hr, by + 3 * vr);
        }
      }
      ctx.restore();
    }
  }

  // ----- custom primitive: numeric delta values printed on the delta pane -----
  class DeltaLabelsPrimitive {
    constructor() {
      this.bars = []; // {time, value}
      this._chart = null;
      this._series = null;
      this._requestUpdate = null;
      const self = this;
      this._paneView = {
        renderer() {
          return { draw(target) { target.useBitmapCoordinateSpace((scope) => self._draw(scope)); } };
        },
        zOrder() { return 'top'; },
      };
    }
    attached({ chart, series, requestUpdate }) { this._chart = chart; this._series = series; this._requestUpdate = requestUpdate; }
    detached() { this._chart = null; this._series = null; }
    paneViews() { return [this._paneView]; }
    setBars(bars) { this.bars = bars || []; if (this._requestUpdate) this._requestUpdate(); }

    _draw(scope) {
      if (!this._chart || !this._series || !this.bars.length) return;
      const ts = this._chart.timeScale();
      const spacing = ts.options().barSpacing || 6;
      const dense = spacing < 11; // too dense to label every bar
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const range = ts.getVisibleRange();
      if (!range) return;
      ctx.save();
      ctx.font = `600 ${Math.round(8.5 * vr)}px 'Inter', sans-serif`;
      ctx.textAlign = 'center';
      // when bars are dense only the newest bar is labelled, so the current
      // delta value is always readable on the indicator
      const bars = dense ? this.bars.slice(-1) : this.bars;
      for (const b of bars) {
        if (b.time < range.from || b.time > range.to) continue;
        const x = ts.timeToCoordinate(b.time);
        const y = this._series.priceToCoordinate(b.value);
        if (x === null || y === null) continue;
        ctx.fillStyle = b.value >= 0 ? C.up : C.down;
        const offset = b.value >= 0 ? -4 * vr : 10 * vr;
        ctx.fillText(fmtSigned(b.value), x * hr, y * vr + offset);
      }
      ctx.restore();
    }
  }

  // ----- custom primitive: a name label written on the pane (top-left) -----
  class PaneLabelPrimitive {
    constructor(text) {
      this.text = text;
      const self = this;
      this._paneView = {
        renderer() {
          return {
            draw(target) {
              target.useBitmapCoordinateSpace((scope) => {
                const ctx = scope.context;
                const vr = scope.verticalPixelRatio;
                const hr = scope.horizontalPixelRatio;
                ctx.save();
                ctx.font = `600 ${Math.round(10 * vr)}px 'Inter', sans-serif`;
                ctx.fillStyle = 'rgba(139,147,167,0.9)';
                ctx.fillText(self.text, 8 * hr, 14 * vr);
                ctx.restore();
              });
            },
          };
        },
        zOrder() { return 'top'; },
      };
    }
    setText(t) { this.text = t; }
    paneViews() { return [this._paneView]; }
  }

  class Dashboard {
    constructor(container, pricePrecision) {
      this.container = container;
      this.pricePrecision = pricePrecision;
      this.priceLines = [];
      this.poolLines = [];
      // Only OB/FVG on by default — a clean chart on open; the rest are opt-in.
      this.layers = { zones: true, markers: false, liquidity: false, levels: false, fib: false, sr: false, sessions: true, whales: true };
      this._srLevels = [];
      this._lastAnalysis = null;
      this._lastSignal = null;
      this._build();
    }

    _build() {
      this.chart = LWC.createChart(this.container, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: C.surface },
          textColor: C.inkMuted,
          fontFamily: "'Inter', -apple-system, sans-serif",
          panes: { separatorColor: C.grid, separatorHoverColor: '#2a3242', enableResize: true },
        },
        grid: {
          vertLines: { color: C.grid },
          horzLines: { color: C.grid },
        },
        crosshair: {
          mode: LWC.CrosshairMode.Normal,
          vertLine: { labelBackgroundColor: '#2a3242' },
          horzLine: { labelBackgroundColor: '#2a3242' },
        },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: C.grid, rightOffset: 8 },
        rightPriceScale: { borderColor: C.grid },
        localization: {
          locale: 'en-US',
          priceFormatter: (p) => p.toFixed(this.pricePrecision),
        },
      });

      const fmt = { type: 'price', precision: this.pricePrecision, minMove: Math.pow(10, -this.pricePrecision) };

      // pane 0: candles
      this.candles = this.chart.addSeries(LWC.CandlestickSeries, {
        upColor: C.up, downColor: C.down,
        wickUpColor: C.up, wickDownColor: C.down,
        borderVisible: false,
        priceFormat: fmt,
      }, 0);
      this.zonesPrimitive = new ZonesPrimitive();
      this.candles.attachPrimitive(this.zonesPrimitive);
      this.fibPrimitive = new FibPrimitive();
      this.candles.attachPrimitive(this.fibPrimitive);
      this.srPrimitive = new SRPrimitive();
      this.candles.attachPrimitive(this.srPrimitive);
      this.sessionsPrimitive = new SessionsPrimitive();
      this.candles.attachPrimitive(this.sessionsPrimitive);
      this.whalePrimitive = new WhalePrimitive();
      this.candles.attachPrimitive(this.whalePrimitive);
      this.priceLabel = new PaneLabelPrimitive('PRICE · Smart-money structures (OB · FVG · liquidity · fib)');
      this.candles.attachPrimitive(this.priceLabel);
      this.markers = LWC.createSeriesMarkers(this.candles, []);

      // pane 1: volume
      this.volume = this.chart.addSeries(LWC.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'right',
        lastValueVisible: false,
        priceLineVisible: false,
      }, 1);
      this.volumeLabel = new PaneLabelPrimitive('VOLUME');
      this.volume.attachPrimitive(this.volumeLabel);

      // pane 2: delta histogram + CVD line
      this.delta = this.chart.addSeries(LWC.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'right',
        base: 0,
        lastValueVisible: false,
        priceLineVisible: false,
      }, 2);
      this.deltaLabel = new PaneLabelPrimitive('DELTA VOLUME (buy − sell) + CVD line');
      this.delta.attachPrimitive(this.deltaLabel);
      this.deltaLabels = new DeltaLabelsPrimitive();
      this.delta.attachPrimitive(this.deltaLabels);
      this.cvd = this.chart.addSeries(LWC.LineSeries, {
        color: C.cvd,
        lineWidth: 2,
        priceScaleId: 'cvd',
        priceFormat: { type: 'volume' },
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      }, 2);

      // pane 3: liquidations (longs drawn down in amber, shorts up in blue)
      this.liqSeries = this.chart.addSeries(LWC.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'right',
        base: 0,
        lastValueVisible: false,
        priceLineVisible: false,
      }, 3);
      this.liqSeries.attachPrimitive(new PaneLabelPrimitive('LIQUIDATIONS · shorts ↑ blue / longs ↓ amber'));

      const panes = this.chart.panes();
      if (panes[1]) panes[1].setHeight(80);
      if (panes[2]) panes[2].setHeight(110);
      if (panes[3]) panes[3].setHeight(80);

      // crosshair OHLC / volume / delta readout
      this.legendEl = document.getElementById('ohlcLegend');
      this.chart.subscribeCrosshairMove((param) => this._renderLegend(param));
    }

    _renderLegend(param) {
      if (!this.legendEl) return;
      const c = param && param.seriesData ? param.seriesData.get(this.candles) : null;
      if (!c || c.open === undefined) { this.legendEl.classList.add('hidden'); return; }
      const vol = param.seriesData.get(this.volume);
      const delta = param.seriesData.get(this.delta);
      const p = this.pricePrecision;
      const dirCls = c.close >= c.open ? 'pos' : 'neg';
      const dVal = delta ? delta.value : 0;
      this.legendEl.classList.remove('hidden');
      this.legendEl.innerHTML =
        `<span>O <b class="${dirCls}">${c.open.toFixed(p)}</b></span>` +
        `<span>H <b class="${dirCls}">${c.high.toFixed(p)}</b></span>` +
        `<span>L <b class="${dirCls}">${c.low.toFixed(p)}</b></span>` +
        `<span>C <b class="${dirCls}">${c.close.toFixed(p)}</b></span>` +
        (vol ? `<span>Vol <b>${fmtNum(vol.value)}</b></span>` : '') +
        (delta ? `<span>Δ <b class="${dVal >= 0 ? 'pos' : 'neg'}">${dVal >= 0 ? '+' : ''}${fmtNum(dVal)}</b></span>` : '');
    }

    setPricePrecision(p) {
      this.pricePrecision = p;
      const fmt = { type: 'price', precision: p, minMove: Math.pow(10, -p) };
      this.candles.applyOptions({ priceFormat: fmt });
    }

    setHistory(candles, liqBars) {
      this.candles.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      this.volume.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? C.upDim : C.downDim })));
      this.delta.setData(candles.map((c) => ({ time: c.time, value: c.delta, color: c.delta >= 0 ? C.up : C.down })));
      let acc = 0;
      this.cvd.setData(candles.map((c) => { acc += c.delta; return { time: c.time, value: acc }; }));
      // Binance history includes the still-forming candle as the last row —
      // treat it as live so streamed updates keep flowing into it.
      const last = candles[candles.length - 1];
      this._cvdAcc = acc - (last ? last.delta : 0);
      this._lastClosedTime = candles.length > 1 ? candles[candles.length - 2].time : 0;
      this._candleTimes = candles.map((c) => c.time);
      this.deltaLabels.setBars(candles.slice(-60).map((c) => ({ time: c.time, value: c.delta })));
      this.setLiquidations(liqBars || []);
      this.chart.timeScale().scrollToRealTime();
    }

    updateCandle(c) {
      if (this._candleTimes && (!this._candleTimes.length || c.time > this._candleTimes[this._candleTimes.length - 1])) {
        this._candleTimes.push(c.time);
      }
      this.candles.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
      this.volume.update({ time: c.time, value: c.volume, color: c.close >= c.open ? C.upDim : C.downDim });
      this.delta.update({ time: c.time, value: c.delta, color: c.delta >= 0 ? C.up : C.down });
      const liveDelta = c.time > this._lastClosedTime ? c.delta : 0; // live bar rides on top of the closed accumulator
      const cvdVal = this._cvdAcc + liveDelta;
      this.cvd.update({ time: c.time, value: cvdVal });
      this._deltaBarMap = this._deltaBarMap || new Map();
      this._deltaBarMap.set(c.time, c.delta);
      const bars = [...this._deltaBarMap.entries()].slice(-60).map(([time, value]) => ({ time, value }));
      this.deltaLabels.setBars(bars);
      // numbers written into the indicator titles
      this.deltaLabel.setText(`DELTA VOLUME  bar ${fmtSigned(c.delta)} · CVD ${fmtSigned(cvdVal)}`);
      this.volumeLabel.setText(`VOLUME  ${fmtNum(c.volume)}`);
      if (c.closed && c.time > this._lastClosedTime) {
        this._cvdAcc += c.delta;
        this._lastClosedTime = c.time;
      }
    }

    // liqBars: [{time, long, short}] — longs plotted downward. Seeded with a
    // zero row for every candle so the pane always has a proper scale.
    setLiquidations(bars) {
      const byTime = new Map((bars || []).map((b) => [b.time, b]));
      const rows = (this._candleTimes || []).map((t) => this._liqRow(byTime.get(t) || { time: t, long: 0, short: 0 }));
      // liquidation buckets newer than the last candle (fresh live events)
      const lastT = this._candleTimes && this._candleTimes.length ? this._candleTimes[this._candleTimes.length - 1] : 0;
      for (const b of bars || []) if (b.time > lastT) rows.push(this._liqRow(b));
      rows.sort((a, b) => a.time - b.time);
      this.liqSeries.setData(rows);
    }

    _liqRow(b) {
      const long = b.long || 0, short = b.short || 0;
      if (!long && !short) return { time: b.time, value: 0, color: 'rgba(0,0,0,0)' };
      return short >= long
        ? { time: b.time, value: short, color: C.shortLiq }
        : { time: b.time, value: -long, color: C.longLiq };
    }

    updateLiquidationBar(b) {
      try {
        this.liqSeries.update(this._liqRow(b));
      } catch (e) { /* out-of-order bucket — ignored, next setHistory reconciles */ }
    }

    setWhales(orders) {
      this._whaleOrders = orders || [];
      this.whalePrimitive.setOrders(this.layers.whales ? this._whaleOrders : []);
    }

    setSR(levels) {
      this._srLevels = levels || [];
      this.srPrimitive.setLevels(this.layers.sr ? this._srLevels : []);
    }

    // Build one band per session per day covered by the visible candles.
    setSessions(candles, tf) {
      this._sessionCandles = candles;
      this._sessionTf = tf;
      if (!this.layers.sessions || !candles.length || window.intervalSeconds(tf) > 14400) {
        this.sessionsPrimitive.setBands([]);
        return;
      }
      const first = candles[0].time, last = candles[candles.length - 1].time;
      const bands = [];
      const dayStart = Math.floor(first / 86400) * 86400;
      for (let d = dayStart; d <= last + 86400; d += 86400) {
        for (const s of C_SESSIONS) {
          const from = d + s.start * 3600, to = d + s.end * 3600;
          if (to < first || from > last) continue;
          bands.push({ from, to, color: s.color, label: s.short });
        }
      }
      this.sessionsPrimitive.setBands(bands);
    }

    setLayer(name, on) {
      this.layers[name] = on;
      if (name === 'sr') { this.srPrimitive.setLevels(on ? this._srLevels : []); return; }
      if (name === 'sessions') { this.setSessions(this._sessionCandles || [], this._sessionTf || '15m'); return; }
      if (name === 'whales') { this.whalePrimitive.setOrders(on ? (this._whaleOrders || []) : []); return; }
      if (this._lastAnalysis) this.applyAnalysis(this._lastAnalysis, this._lastSignal);
    }

    applyAnalysis(analysis, signal) {
      this._lastAnalysis = analysis;
      this._lastSignal = signal;

      // --- zones ---
      const zones = [];
      if (this.layers.zones && analysis) {
        for (const b of analysis.orderBlocks) {
          const respected = b.state === 'respected';
          zones.push({
            timeStart: b.time,
            top: b.top, bottom: b.bottom,
            color: b.dir === 'up' ? (respected ? C.obBullRespected : C.obBull) : (respected ? C.obBearRespected : C.obBear),
            border: respected ? (b.dir === 'up' ? C.up : C.down) : null,
            label: `${b.dir === 'up' ? 'Demand OB' : 'Supply OB'}${respected ? ' ✓ respected' : ''}`,
            labelColor: b.dir === 'up' ? C.up : C.down,
          });
        }
        for (const g of analysis.fvgs) {
          zones.push({
            timeStart: g.time,
            top: g.top, bottom: g.bottom,
            color: g.dir === 'up' ? C.fvgBull : C.fvgBear,
            label: 'FVG',
          });
        }
      }
      this.zonesPrimitive.setZones(zones);
      this.fibPrimitive.setFib(this.layers.fib && analysis ? analysis.fib : null);

      // --- liquidity pool lines ---
      for (const l of this.poolLines) this.candles.removePriceLine(l);
      this.poolLines = [];
      if (this.layers.liquidity && analysis) {
        for (const p of analysis.liquidity.pools) {
          this.poolLines.push(this.candles.createPriceLine({
            price: p.price,
            color: C.liquidity,
            lineWidth: 1,
            lineStyle: LWC.LineStyle.Dashed,
            axisLabelVisible: false,
            title: p.eq ? (p.type === 'high' ? 'EQH liquidity' : 'EQL liquidity') : (p.type === 'high' ? 'swing-high liq' : 'swing-low liq'),
          }));
        }
      }

      // --- markers ---
      const markers = [];
      if (this.layers.markers && analysis) {
        for (const ev of analysis.structure.events.slice(-14)) {
          markers.push({
            time: ev.time,
            position: ev.dir === 'up' ? 'belowBar' : 'aboveBar',
            color: ev.kind === 'CHoCH' ? (ev.dir === 'up' ? C.up : C.down) : C.inkMuted,
            shape: ev.dir === 'up' ? 'arrowUp' : 'arrowDown',
            text: ev.kind,
          });
        }
        for (const s of analysis.liquidity.sweeps.slice(-8)) {
          markers.push({
            time: s.time,
            position: s.dir === 'low' ? 'belowBar' : 'aboveBar',
            color: C.longLiq,
            shape: 'circle',
            text: 'HUNT',
          });
        }
        for (const a of analysis.absorption.slice(-6)) {
          markers.push({
            time: a.time,
            position: a.side === 'bullish' ? 'belowBar' : 'aboveBar',
            color: C.shortLiq,
            shape: 'square',
            text: 'ABS',
          });
        }
        if (analysis.divergence) {
          markers.push({
            time: analysis.divergence.time,
            position: analysis.divergence.side === 'bullish' ? 'belowBar' : 'aboveBar',
            color: C.cvd,
            shape: analysis.divergence.side === 'bullish' ? 'arrowUp' : 'arrowDown',
            text: 'CVD DIV',
          });
        }
        for (const e of (analysis.engulfing || []).slice(-6)) {
          markers.push({
            time: e.time,
            position: e.side === 'bullish' ? 'belowBar' : 'aboveBar',
            color: e.side === 'bullish' ? C.up : C.down,
            shape: e.side === 'bullish' ? 'arrowUp' : 'arrowDown',
            text: e.strong ? 'ENGULF!' : 'ENGULF',
          });
        }
      }
      markers.sort((a, b) => a.time - b.time);
      this.markers.setMarkers(markers);

      // --- entry / stop / targets + swing top/bottom + double pattern ---
      for (const l of this.priceLines) this.candles.removePriceLine(l);
      this.priceLines = [];
      if (this.layers.levels && analysis && analysis.fib) {
        const mkMeta = (price, title) => this.priceLines.push(this.candles.createPriceLine({
          price, color: C.inkMuted, lineWidth: 1, lineStyle: LWC.LineStyle.SparseDotted, axisLabelVisible: true, title,
        }));
        mkMeta(analysis.fib.high, 'TOP');
        mkMeta(analysis.fib.low, 'BOTTOM');
      }
      if (this.layers.levels && analysis && analysis.doublePattern) {
        const dp = analysis.doublePattern;
        this.priceLines.push(this.candles.createPriceLine({
          price: dp.level,
          color: C.longLiq,
          lineWidth: 2,
          lineStyle: LWC.LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: `${dp.type === 'double-top' ? 'DBL TOP' : 'DBL BOTTOM'} · break ${dp.breakChance}%`,
        }));
      }
      if (this.layers.levels && signal && signal.levels) {
        const L = signal.levels;
        const mk = (price, color, title, style) => this.priceLines.push(this.candles.createPriceLine({
          price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title,
        }));
        mk(L.entry, C.entry, `ENTRY ${signal.direction}`, LWC.LineStyle.Solid);
        mk(L.stop, C.stop, 'STOP', LWC.LineStyle.Dashed);
        mk(L.t1, C.target, 'TARGET 1', LWC.LineStyle.Dotted);
        mk(L.t2, C.target, 'TARGET 2', LWC.LineStyle.Dotted);
      }
    }
  }

  function fmtNum(x) {
    const a = Math.abs(x);
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (x / 1e3).toFixed(1) + 'K';
    return x.toFixed(0);
  }

  function fmtSigned(x) { return (x >= 0 ? '+' : '') + fmtNum(x); }

  window.Dashboard = Dashboard;
})();
