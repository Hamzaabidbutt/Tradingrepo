// Live reasoning feed: turns engine events into timestamped, human
// sentences explaining WHY — the hunt, the volume shift, who got liquidated.
(function () {
  const MAX_ITEMS = 60;

  class Reasoning {
    constructor(container) {
      this.container = container;
      this.items = [];
      this.seen = new Set();
    }

    // key must be stable per event so re-analysis doesn't duplicate entries
    push(key, tag, cls, text, time) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.items.push({ tag, cls, text, time: time || Date.now() });
      if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
      this.render();
    }

    clear() {
      this.items = [];
      this.seen = new Set();
      this.render();
    }

    render() {
      if (!this.container) return;
      this.container.innerHTML = this.items
        .slice()
        .reverse()
        .map((it) => {
          const t = new Date(it.time);
          const hh = String(t.getHours()).padStart(2, '0');
          const mm = String(t.getMinutes()).padStart(2, '0');
          const ss = String(t.getSeconds()).padStart(2, '0');
          return `<div class="feed-item">
            <span class="feed-time">${hh}:${mm}:${ss}</span>
            <span class="feed-tag ${it.cls}">${it.tag}</span>
            <span class="feed-text">${escapeHtml(it.text)}</span>
          </div>`;
        })
        .join('');
    }

    // Generate feed entries from a fresh analysis pass over closed candles.
    fromAnalysis(symbol, tf, candles, analysis) {
      const lastIdx = candles.length - 1;
      const px = (v) => formatPrice(v);
      const horizon = 20; // only narrate recent events

      for (const ev of analysis.structure.events) {
        if (lastIdx - ev.idx > horizon) continue;
        const key = `${symbol}:${tf}:ev:${ev.kind}:${ev.idx}`;
        if (ev.kind === 'CHoCH') {
          this.push(key, 'CHoCH', 'tag-choch',
            `${symbol} ${tf}: Change of Character ${ev.dir} — price closed ${ev.dir === 'up' ? 'above' : 'below'} ${px(ev.level)}, early sign the ${ev.dir === 'up' ? 'down' : 'up'}trend is reversing.`,
            candles[ev.idx].time * 1000);
        } else {
          this.push(key, 'BOS', 'tag-bos',
            `${symbol} ${tf}: Break of Structure ${ev.dir} through ${px(ev.level)} — trend continuation confirmed.`,
            candles[ev.idx].time * 1000);
        }
      }

      for (const s of analysis.liquidity.sweeps) {
        if (lastIdx - s.idx > horizon) continue;
        const key = `${symbol}:${tf}:sweep:${s.idx}:${s.dir}`;
        const side = s.dir === 'low' ? 'below' : 'above';
        const stops = s.dir === 'low' ? 'long stop-losses' : 'short stop-losses';
        this.push(key, 'HUNT', 'tag-hunt',
          `${symbol} ${tf}: Liquidity hunt ${side} ${px(s.level)}${s.eq ? ' (equal ' + s.dir + 's)' : ''} — wick swept ${stops}${s.volSpike ? ' on a volume spike' : ''}, then price snapped back. Watch for a move the other way.`,
          candles[s.idx].time * 1000);
      }

      for (const a of analysis.absorption) {
        if (lastIdx - a.idx > horizon) continue;
        const key = `${symbol}:${tf}:abs:${a.idx}`;
        const who = a.side === 'bullish' ? 'Aggressive sellers hit the market but price barely dropped — buyers are absorbing.' : 'Aggressive buyers pushed but price barely rose — sellers are absorbing.';
        this.push(key, 'ABSORB', 'tag-absorb',
          `${symbol} ${tf}: Absorption (${a.side}). ${who} Volume ${window.Signals.fmtQty(a.volume)} vs delta ${window.Signals.fmtQty(a.delta)}.`,
          candles[a.idx].time * 1000);
      }

      for (const b of analysis.orderBlocks) {
        if (b.state === 'respected' && lastIdx - (b.respectedAt || 0) <= horizon) {
          const key = `${symbol}:${tf}:obr:${b.idx}:${b.respectedAt}`;
          this.push(key, 'OB', 'tag-ob',
            `${symbol} ${tf}: ${b.dir === 'up' ? 'Demand' : 'Supply'} order block ${px(b.bottom)}–${px(b.top)} was retested and RESPECTED — ${b.dir === 'up' ? 'buyers defended it' : 'sellers defended it'}.`,
            candles[b.respectedAt].time * 1000);
        }
      }

      if (analysis.divergence && lastIdx - analysis.divergence.idx <= horizon) {
        const d = analysis.divergence;
        const key = `${symbol}:${tf}:div:${d.idx}:${d.side}`;
        this.push(key, 'DELTA', 'tag-delta',
          `${symbol} ${tf}: ${d.side === 'bullish' ? 'Price made a lower low but cumulative delta made a higher low — selling is drying up.' : 'Price made a higher high but cumulative delta made a lower high — buying is drying up.'}`,
          candles[d.idx].time * 1000);
      }

      // volume shift on the most recent closed candle
      const c = candles[lastIdx];
      const vAvg = analysis.lastVolSMA;
      if (c.volume > window.CFG.VOL_SPIKE_MULT * vAvg) {
        const key = `${symbol}:${tf}:vol:${lastIdx}`;
        const side = c.delta > 0 ? 'buy-side' : 'sell-side';
        this.push(key, 'VOLUME', 'tag-vol',
          `${symbol} ${tf}: Volume spike ${(c.volume / vAvg).toFixed(1)}× average, mostly ${side} (delta ${window.Signals.fmtQty(c.delta)}).`,
          c.time * 1000);
      }
    }

    // Live liquidation narration (aggregated bursts, not every order).
    liquidationBurst(symbol, side, notional, price) {
      const key = `liq:${symbol}:${side}:${Math.floor(Date.now() / 15000)}`;
      const who = side === 'long' ? 'LONGS liquidated' : 'SHORTS liquidated';
      const meaning = side === 'long'
        ? 'forced selling — often fuels the final flush before a bounce'
        : 'forced buying — often fuels the final squeeze before a drop';
      this.push(key, 'LIQ', side === 'long' ? 'tag-liq-long' : 'tag-liq-short',
        `${symbol}: ${who} ${window.Signals.fmtUsd(notional)} near ${formatPrice(price)} — ${meaning}.`);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function formatPrice(v) {
    if (typeof v !== 'number') return v;
    return v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(5);
  }

  window.Reasoning = Reasoning;
})();
