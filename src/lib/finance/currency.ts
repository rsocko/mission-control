import { z } from 'zod';

export const supportedCurrencyCodes = Object.freeze(
  [...Intl.supportedValuesOf('currency')].sort(),
);

const supportedCurrencies = new Set(supportedCurrencyCodes);

export const currencySchema = z.string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
  .refine((value) => supportedCurrencies.has(value));

export function isSupportedCurrency(value: unknown): value is string {
  return currencySchema.safeParse(value).success;
}
