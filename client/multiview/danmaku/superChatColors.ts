export interface SuperChatColors {
  background: string;
  body: string;
  price: string;
}

// Bilibili SC price bands; upstream colors take precedence when supplied.
// Also documented by DD_Monitor_CE/ddm/super_chat.py (SC_PRICE_TIERS).
const tiers = [
  [30, '#edf5ff', '#2a60b2', '#7497cd'],
  [50, '#dbfffd', '#427d9e', '#7da4bd'],
  [100, '#fff1c5', '#e2b52b', '#eccf75'],
  [500, '#ffead2', '#e09443', '#e8af79'],
  [1000, '#ffe7e4', '#e54d4d', '#ee8b8b'],
  [2000, '#ffd8d8', '#ab1a32', '#c86a7a'],
] as const;

/** Only opaque RGB colors can enter inline styles from the upstream payload. */
export function superChatHexColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
}

const priceTier = (price: number) => {
  const amount = Number.isFinite(price) ? price : 0;
  return [...tiers].reverse().find(([minimum]) => amount >= minimum) ?? tiers[0];
};

export function superChatTier(price = 0): number {
  return priceTier(price)[0];
}

export function resolveSuperChatColors(price = 0, overrides?: Partial<SuperChatColors>): SuperChatColors {
  const tier = priceTier(price);
  return {
    background: superChatHexColor(overrides?.background) ?? tier[1],
    body: superChatHexColor(overrides?.body) ?? tier[2],
    price: superChatHexColor(overrides?.price) ?? tier[3],
  };
}

/** Keep official light and dark SC backgrounds readable without changing their colors. */
export function superChatTextColor(background: string): '#ffffff' | '#111827' {
  const color = superChatHexColor(background);
  if (!color) return '#ffffff';
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => 0.2126 * linear(parseInt(hex.slice(1, 3), 16))
    + 0.7152 * linear(parseInt(hex.slice(3, 5), 16)) + 0.0722 * linear(parseInt(hex.slice(5, 7), 16));
  const base = luminance(color);
  const dark = luminance('#111827');
  const darkContrast = (base + 0.05) / (dark + 0.05);
  const lightContrast = 1.05 / (base + 0.05);
  return darkContrast >= lightContrast ? '#111827' : '#ffffff';
}
