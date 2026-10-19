import { normalizeMemoryScore } from './memoryScoring';

test('同分和单候选不产生 NaN，普通范围保持原行为', () => {
  expect(normalizeMemoryScore(5, [5, 5])).toBe(0);
  expect(normalizeMemoryScore(5, [0, 10])).toBe(0.5);
  expect(() => normalizeMemoryScore(Infinity, [0, 10])).toThrow();
});
