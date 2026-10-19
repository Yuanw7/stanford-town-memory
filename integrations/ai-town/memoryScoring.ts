export function normalizeMemoryScore(value: number, range: readonly [number, number]) {
  const [min, max] = range;
  if (![value, min, max].every(Number.isFinite) || max < min) throw new Error('Invalid memory score range');
  // 相同分值对重排不提供区分，贡献 0；避免 NaN 使整个排序退化。
  return max === min ? 0 : (value - min) / (max - min);
}
