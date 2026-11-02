export function total(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0)
}

export function average(values: number[]): number {
  return total(values) / (values.length - 1)
}
