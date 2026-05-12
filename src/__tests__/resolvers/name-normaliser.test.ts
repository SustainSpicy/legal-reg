import { describe, it, expect } from 'vitest';
import { normaliseName, similarityScore, soundex } from '../../resolvers/name-normaliser.js';

describe('normaliseName', () => {
  it('strips single legal suffix', () => {
    expect(normaliseName('Apple Inc')).toBe('apple');
    expect(normaliseName('Google LLC')).toBe('google');
    expect(normaliseName('Barclays Bank PLC')).toBe('barclays bank');
    expect(normaliseName('Tesla Corp')).toBe('tesla');
    expect(normaliseName('Acme Ltd')).toBe('acme');
  });

  it('strips multiple suffixes iteratively', () => {
    expect(normaliseName('Acme Holdings LLC')).toBe('acme');
    expect(normaliseName('Global Group Inc')).toBe('global');
    expect(normaliseName('Smith International Holdings Ltd')).toBe('smith');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normaliseName('  APPLE INC  ')).toBe('apple');
    expect(normaliseName('GOOGLE LLC')).toBe('google');
  });

  it('removes punctuation', () => {
    expect(normaliseName('Amazon.com Inc')).toBe('amazon com');
    expect(normaliseName('Johnson & Johnson')).toBe('johnson johnson');
    expect(normaliseName("McDonald's Corp")).toBe('mcdonald s');
  });

  it('collapses internal whitespace', () => {
    expect(normaliseName('Acme   Corp')).toBe('acme');
  });

  it('returns empty string for empty input', () => {
    expect(normaliseName('')).toBe('');
  });

  it('returns empty string for suffix-only input', () => {
    expect(normaliseName('LLC')).toBe('');
    expect(normaliseName('Inc.')).toBe('');
  });

  it('does not over-strip mid-word occurrences', () => {
    // 'inc' in 'lincoln' should not be stripped
    const result = normaliseName('Lincoln National Corp');
    expect(result).toContain('lincoln');
  });
});

describe('similarityScore', () => {
  it('returns 1.0 for identical strings', () => {
    expect(similarityScore('Apple Inc', 'Apple Inc')).toBe(1.0);
  });

  it('returns 1.0 when names match after normalisation', () => {
    // Both normalise to 'apple'
    expect(similarityScore('Apple Inc', 'Apple LLC')).toBe(1.0);
    expect(similarityScore('Apple Corp', 'Apple PLC')).toBe(1.0);
  });

  it('returns a high score for near-identical names', () => {
    const score = similarityScore('Apple Inc', 'Aple Inc');
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('returns a low score for unrelated names', () => {
    const score = similarityScore('Apple', 'Zymurgy');
    expect(score).toBeLessThan(0.5);
  });

  it('is symmetric', () => {
    const ab = similarityScore('Apple Inc', 'Microsoft Corp');
    const ba = similarityScore('Microsoft Corp', 'Apple Inc');
    expect(ab).toBeCloseTo(ba, 10);
  });

  it('returns 1.0 for two empty strings', () => {
    expect(similarityScore('', '')).toBe(1.0);
  });
});

describe('soundex', () => {
  it('produces a 4-character code', () => {
    expect(soundex('Apple Inc')).toHaveLength(4);
    expect(soundex('Microsoft')).toHaveLength(4);
    expect(soundex('A')).toHaveLength(4);
  });

  it('produces the same code for names that differ only in legal suffix', () => {
    expect(soundex('Apple Inc')).toBe(soundex('Apple LLC'));
    expect(soundex('Google Corp')).toBe(soundex('Google Ltd'));
  });

  it('starts with the first letter (uppercased)', () => {
    expect(soundex('Apple Inc')[0]).toBe('A');
    expect(soundex('Barclays Bank PLC')[0]).toBe('B');
  });

  it('returns empty string for empty input', () => {
    expect(soundex('')).toBe('');
  });
});
