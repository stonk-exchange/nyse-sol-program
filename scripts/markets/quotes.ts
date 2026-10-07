/**
 * The mints a token can be priced in — the "PAIR WITH" list.
 *
 * SOL plus the Backed Finance xStocks that hours.fun offers. Every xStock is
 * Token-2022 with 8 decimals; SOL (wrapped) is the classic token program with
 * 9. The decimals matter because every quote-denominated number in a DBC
 * config -- sqrtStartPrice, the curve points, the migration threshold -- is in
 * the quote's base units, so a config built for SOL cannot be reused for an
 * xStock.
 *
 * Mints were read off mainnet: each is a DBC-badged Token-2022 mint whose
 * on-chain TokenMetadata symbol matches. Regenerate with
 *   npx tsx scripts/check-quotes.ts --cluster mainnet-beta
 * which re-reads every mint and fails if a symbol, decimal or badge moved.
 */
export type Quote = {
  /** Symbol as hours.fun labels it. */
  symbol: string;
  /** Human name from the mint's on-chain metadata. */
  name: string;
  mint: string;
  decimals: number;
};

export const QUOTES: Record<string, Quote> = {
  SOL:    { symbol: "SOL",    name: "Wrapped SOL",          mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  // Stablecoins. Classic SPL, so no DBC token badge is needed, and 6 decimals
  // rather than SOL's 9 -- every quote-denominated number in a curve is in base
  // units, so a SOL curve cannot be reused for these.
  USDC:   { symbol: "USDC",   name: "USD Coin",             mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT:   { symbol: "USDT",   name: "Tether USD",           mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  SPYx:   { symbol: "SPYx",   name: "SP500 xStock",         mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",  decimals: 8 },
  QQQx:   { symbol: "QQQx",   name: "Nasdaq xStock",        mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",  decimals: 8 },
  GLDx:   { symbol: "GLDx",   name: "Gold xStock",          mint: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re",  decimals: 8 },
  TSLAx:  { symbol: "TSLAx",  name: "Tesla xStock",         mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",  decimals: 8 },
  NVDAx:  { symbol: "NVDAx",  name: "NVIDIA xStock",        mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",  decimals: 8 },
  AAPLx:  { symbol: "AAPLx",  name: "Apple xStock",         mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",  decimals: 8 },
  MSFTx:  { symbol: "MSFTx",  name: "Microsoft xStock",     mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",  decimals: 8 },
  GOOGLx: { symbol: "GOOGLx", name: "Alphabet xStock",      mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",  decimals: 8 },
  AMZNx:  { symbol: "AMZNx",  name: "Amazon.com xStock",    mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",  decimals: 8 },
  METAx:  { symbol: "METAx",  name: "Meta xStock",          mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",  decimals: 8 },
  COINx:  { symbol: "COINx",  name: "Coinbase xStock",      mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",  decimals: 8 },
  HOODx:  { symbol: "HOODx",  name: "Robinhood xStock",     mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg",  decimals: 8 },
  MSTRx:  { symbol: "MSTRx",  name: "MicroStrategy xStock", mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",  decimals: 8 },
  CRCLx:  { symbol: "CRCLx",  name: "Circle xStock",        mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",  decimals: 8 },
  PLTRx:  { symbol: "PLTRx",  name: "Palantir xStock",      mint: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4",  decimals: 8 },
};

/**
 * Accepts a symbol from QUOTES or a raw mint address.
 *
 * USDC has roughly twice USDT's supply on Solana and 100 hooked DBC configs to
 * USDT's zero, so it is the stablecoin worth reaching for first.
 */
export function resolveQuote(spec: string): { mint: string; decimals?: number; symbol: string } {
  const bySymbol = QUOTES[spec] ?? Object.values(QUOTES).find((q) => q.symbol.toLowerCase() === spec.toLowerCase());
  if (bySymbol) return bySymbol;
  // An address still works; decimals get read from the chain.
  return { mint: spec, symbol: spec };
}
