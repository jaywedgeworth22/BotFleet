import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEEPSEEK_PRICE_PER_MILLION, deepSeekPriceRows, formatPerMillionUsd } from "./deepseek-prices";

const driver = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../server/drivers/deepseek.ts"),
  "utf8",
);

describe("DeepSeek published rates", () => {
  it("stays in lockstep with computeDeepSeekCost in the DeepSeek driver", () => {
    expect(driver).toMatch(/uncachedInput \* 0\.7/);
    expect(driver).toMatch(/cachedTokens \* 0\.175/);
    expect(driver).toMatch(/outputTokens \* 1\.4/);
    expect(driver).toMatch(/uncachedInput \* 1\.4/);
    expect(driver).toMatch(/cachedTokens \* 0\.14/);
    expect(driver).toMatch(/outputTokens \* 2\.8/);
  });

  it("formats the usage table from those same numbers", () => {
    const { flash, pro } = DEEPSEEK_PRICE_PER_MILLION;
    expect(formatPerMillionUsd(flash.input)).toBe("$0.70");
    expect(formatPerMillionUsd(flash.cache)).toBe("$0.175");
    expect(formatPerMillionUsd(flash.output)).toBe("$1.40");
    expect(formatPerMillionUsd(pro.input)).toBe("$1.40");
    expect(formatPerMillionUsd(pro.cache)).toBe("$0.14");
    expect(formatPerMillionUsd(pro.output)).toBe("$2.80");
    expect(deepSeekPriceRows().map((row) => [row.model, row.input, row.cache, row.output, row.badge])).toEqual([
      ["DeepSeek V4 Flash", "$0.70", "$0.175", "$1.40", "API"],
      ["DeepSeek V4 Pro", "$1.40", "$0.14", "$2.80", "Default MoE"],
    ]);
  });
});
