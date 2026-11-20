import sharp from 'sharp'

/** RGB scaled by alpha: pixels at alpha 0 carry no colour in an ICNS ARGB chunk, so compare through this. */
export function premultiply(rgba: Buffer): Buffer {
  const out = Buffer.from(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const alpha = out[i + 3] as number
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(((out[i + c] as number) * alpha) / 255)
  }
  return out
}

/** Independent reader of an ic04/ic05 body: the four planes (A, R, G, B) PackBits-style, to premultiplied RGBA. */
export function decodeArgb(body: Buffer, size: number): Buffer {
  const pixels = size * size
  const out = Buffer.alloc(pixels * 4)
  let at = 4
  for (const offset of [3, 0, 1, 2]) {
    let written = 0
    while (written < pixels) {
      const control = body[at++] as number
      if (control < 0x80) {
        for (let n = 0; n <= control; n++) out[written++ * 4 + offset] = body[at++] as number
      } else {
        const value = body[at++] as number
        for (let n = 0; n < control - 125; n++) out[written++ * 4 + offset] = value
      }
    }
  }
  if (at !== body.length - 1)
    throw new Error(`ARGB body: read ${at} of ${body.length} bytes, expected all but the pad byte`)
  return out
}

/** The PNG an ic04/ic05 body stands for, with the alpha divided back out as macOS does on read. */
export function argbToPng(body: Buffer, size: number): Promise<Buffer> {
  const rgba = decodeArgb(body, size)
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] as number
    if (alpha === 0 || alpha === 255) continue
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.round(((rgba[i + c] as number) * 255) / alpha))
  }
  return sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
}
