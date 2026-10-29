/** Where to cut `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
export function cutPoint(text: string, max: number): number {
  if (text.length <= max) return text.length
  const high = text.charCodeAt(max - 1)
  return high >= 0xd800 && high <= 0xdbff ? max - 1 : max
}
