// Global configuration for the dashboard.
window.CFG = {
  VERSION: 10,
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
    up: '#00e5a0',
    down: '#ff4d6d',
    upDim: 'rgba(0,229,160,0.40)',
    downDim: 'rgba(255,77,109,0.40)',
    longLiq: '#fbbf24',   // longs got liquidated
    shortLiq: '#22d3ee',  // shorts got liquidated
    cvd: '#e5e9f0',
    obBull: 'rgba(0,229,160,0.14)',
    obBullRespected: 'rgba(0,229,160,0.26)',
    obBear: 'rgba(255,77,109,0.14)',
    obBearRespected: 'rgba(255,77,109,0.26)',
    fvgBull: 'rgba(34,211,238,0.11)',
    fvgBear: 'rgba(251,191,36,0.11)',
    liquidity: '#8792ab',
    fibLine: 'rgba(167,139,250,0.55)',
    fibGold: 'rgba(251,191,36,0.09)',
    fibLabel: '#a78bfa',
    srSupport: 'rgba(0,229,160,0.7)',
    srResistance: 'rgba(255,77,109,0.7)',
    entry: '#22d3ee',
    stop: '#ff4d6d',
    target: '#00e5a0',
    surface: '#05070d',
    grid: '#141a2b',
    ink: '#e5e9f0',
    inkMuted: '#8792ab',
    violet: '#a78bfa',
    amber: '#fbbf24',
    cyan: '#22d3ee',
    ma20: '#22d3ee',
    ma50: '#a78bfa',
    ma100: '#fbbf24',
    ma200: '#e5e9f0',
    sessionAsia: 'rgba(34,211,238,0.045)',
    sessionLondon: 'rgba(251,191,36,0.045)',
    sessionNY: 'rgba(0,229,160,0.045)',
  },


  // Trading sessions in UTC hours [start, end)
  SESSIONS: [
    { id: 'asia', name: 'Asia', short: 'ASIA', start: 0, end: 8, emoji: '🌏' },
    { id: 'london', name: 'London', short: 'LDN', start: 7, end: 16, emoji: '🇬🇧' },
    { id: 'ny', name: 'New York', short: 'NY', start: 12, end: 21, emoji: '🗽' },
  ],
};
