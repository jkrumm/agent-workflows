export type Rgb = [number, number, number]

/** `#rrggbb` as 0..255 channels. */
export const hexRgb = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb

/** Relative brightness 0..1 of sRGB channels (0.2126R + 0.7152G + 0.0722B on 0..1 values, no gamma expansion). */
export const luminance = ([r, g, b]: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

export const rgbHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
