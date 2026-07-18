// Global configuration for the dashboard.
window.CFG = {
  SYMBOLS: [
    { id: 'UNIUSDT', base: 'UNI', name: 'Uniswap', pricePrecision: 4, sample: 9.2 },
    { id: 'ORDIUSDT', base: 'ORDI', name: 'Ordinals', pricePrecision: 3, sample: 11.5 },
    { id: 'BTCUSDT', base: 'BTC', name: 'Bitcoin', pricePrecision: 1, sample: 100000 },
    { id: 'ETHUSDT', base: 'ETH', name: 'Ethereum', pricePrecision: 2, sample: 3500 },
    { id: 'SOLUSDT', base: 'SOL', name: 'Solana', pricePrecision: 3, sample: 160 },
    { id: 'BNBUSDT', base: 'BNB', name: 'BNB', pricePrecision: 2, sample: 650 },
  ],

  // multi-timeframe support/resistance sources
  SR_TIMEFRAMES: [['1h', 'hourly'], ['1d', 'daily'], ['1w', 'weekly'], ['1M', 'monthly']],

  TIMEFRAMES: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'],
  DEFAULT_TF: '15m',
  HISTORY_LIMIT: 500,

  REST_BASE: 'https://fapi.binance.com',
  WS_BASE: 'wss://fstream.binance.com/stream',

  // Analysis thresholds
  PIVOT_LOOKBACK: 3,          // bars each side for a fractal swing
  EQ_LEVEL_TOL: 0.0012,       // equal highs/lows tolerance (fraction of price)
  MAX_ZONES: 8,               // max order blocks / FVGs kept on chart
  VOL_SPIKE_MULT: 1.6,        // volume > mult * SMA20 counts as a spike
  ABSORPTION_RANGE_MULT: 0.65,// candle range < mult * ATR for absorption
  IMPULSE_ATR_MULT: 1.2,      // move size to qualify as impulsive
  SWEEP_CLOSE_BACK: true,     // sweep requires close back inside the level

  // Signal weights (sum of aligned weights -> confidence)
  WEIGHTS: {
    trend: 20,
    bos: 10,
    choch: 15,
    orderBlock: 20,
    fvg: 10,
    sweep: 15,
    delta: 10,
    liquidation: 10,
    absorption: 10,
    fib: 8,
    engulfing: 8,
    doublePattern: 8,
    funding: 5,
  },
  SIGNAL_THRESHOLD: 35,       // |score| needed for LONG/SHORT

  // Validated dark-surface palette (see README)
  COLORS: {
    up: '#26a69a',
    down: '#ef5350',
    upDim: 'rgba(38,166,154,0.45)',
    downDim: 'rgba(239,83,80,0.45)',
    longLiq: '#d97706',   // longs got liquidated
    shortLiq: '#3b82f6',  // shorts got liquidated
    cvd: '#d1d4dc',
    obBull: 'rgba(38,166,154,0.16)',
    obBullRespected: 'rgba(38,166,154,0.30)',
    obBear: 'rgba(239,83,80,0.16)',
    obBearRespected: 'rgba(239,83,80,0.30)',
    fvgBull: 'rgba(59,130,246,0.12)',
    fvgBear: 'rgba(217,119,6,0.12)',
    liquidity: '#8b93a7',
    fibLine: 'rgba(139,147,167,0.55)',
    fibGold: 'rgba(217,119,6,0.10)',
    fibLabel: '#a9b1c4',
    srSupport: 'rgba(38,166,154,0.7)',
    srResistance: 'rgba(239,83,80,0.7)',
    entry: '#3b82f6',
    stop: '#ef5350',
    target: '#26a69a',
    surface: '#131722',
    grid: '#1e2430',
    ink: '#d1d4dc',
    inkMuted: '#8b93a7',
  },
};
