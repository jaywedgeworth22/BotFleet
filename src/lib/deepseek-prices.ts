/** Published DeepSeek API rates, USD per million tokens.
 *
 * Must stay in lockstep with `computeDeepSeekCost` in server/drivers/deepseek.ts.
 * The Vite client cannot import that driver (Node-only), so this is the
 * display copy of the same numbers. */
export const DEEPSEEK_PRICE_PER_MILLION = {
  flash: { input: 0.7, cache: 0.175, output: 1.4 },
  pro: { input: 1.4, cache: 0.14, output: 2.8 },
} as const;

export function formatPerMillionUsd(usd: number): string {
  if (Number.isInteger(usd)) return `$${usd}`;
  const hundredths = Math.round(usd * 100) / 100;
  if (Math.abs(hundredths - usd) < 1e-9) return `$${hundredths.toFixed(2)}`;
  return `$${usd.toFixed(3).replace(/0+$/, "")}`;
}

export type DeepSeekPriceRow = {
  model: string;
  provider: string;
  input: string;
  cache: string;
  output: string;
  badge: string;
};

export function deepSeekPriceRows(): DeepSeekPriceRow[] {
  const { flash, pro } = DEEPSEEK_PRICE_PER_MILLION;
  return [
    {
      model: "DeepSeek V4 Flash",
      provider: "DeepSeek",
      input: formatPerMillionUsd(flash.input),
      cache: formatPerMillionUsd(flash.cache),
      output: formatPerMillionUsd(flash.output),
      badge: "API",
    },
    {
      model: "DeepSeek V4 Pro",
      provider: "DeepSeek",
      input: formatPerMillionUsd(pro.input),
      cache: formatPerMillionUsd(pro.cache),
      output: formatPerMillionUsd(pro.output),
      badge: "Default MoE",
    },
  ];
}
