// Legal suffix tokens stripped before matching
const LEGAL_SUFFIXES = [
  'llc', 'l.l.c', 'limited liability company',
  'inc', 'incorporated', 'corp', 'corporation',
  'ltd', 'limited', 'plc', 'p.l.c',
  'gmbh', 'ag', 'sa', 's.a', 'bv', 'b.v', 'nv', 'n.v',
  'lp', 'l.p', 'llp', 'l.l.p',
  'co', 'company', 'companies',
  'holdings', 'holding', 'group',
  'international', 'intl',
];

export function normaliseName(raw: string): string {
  let name = raw.toLowerCase().trim();
  // Remove punctuation except spaces
  name = name.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'"]/g, ' ');
  // Collapse whitespace
  name = name.replace(/\s+/g, ' ').trim();
  // Strip legal suffixes (last token only, iteratively)
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const pattern = new RegExp(`\\b${suffix}\\s*$`);
      if (pattern.test(name)) {
        name = name.replace(pattern, '').trim();
        changed = true;
        break;
      }
    }
  }
  return name.trim();
}

// Levenshtein distance
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
      }
    }
  }
  return dp[m]![n]!;
}

export function similarityScore(a: string, b: string): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (na === nb) return 1.0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(na, nb);
  return 1 - dist / maxLen;
}

// Soundex for phonetic matching
export function soundex(name: string): string {
  const normalised = normaliseName(name).replace(/\s/g, '');
  if (!normalised) return '';
  const codes: Record<string, string> = {
    b: '1', f: '1', p: '1', v: '1',
    c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
    d: '3', t: '3',
    l: '4',
    m: '5', n: '5',
    r: '6',
  };
  const first = normalised[0]!.toUpperCase();
  let code = first;
  let prev = codes[normalised[0]!.toLowerCase()] ?? '0';
  for (let i = 1; i < normalised.length && code.length < 4; i++) {
    const ch = normalised[i]!.toLowerCase();
    const curr = codes[ch] ?? '0';
    if (curr !== '0' && curr !== prev) {
      code += curr;
    }
    prev = curr;
  }
  return code.padEnd(4, '0');
}
