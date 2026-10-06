export const normalizeText = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export const clip = (value: string, length: number): string =>
  value.length > length ? value.slice(0, length - 1) + '…' : value;

export const quote = (value: string): string => JSON.stringify(value);
