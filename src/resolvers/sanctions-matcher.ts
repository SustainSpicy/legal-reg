import { normaliseName, similarityScore } from './name-normaliser.js';
import { getCached } from '../cache/helpers.js';
import type { SANCTIONS_LISTS } from '../schemas/sanctions.js';

type SanctionsList = (typeof SANCTIONS_LISTS)[number];

interface SanctionsEntry {
  id: string;
  name: string;
  aliases: string[];
  program: string | null;
  listed_on: string | null;
}

interface MatchResult {
  list: SanctionsList;
  entry_id: string;
  matched_name: string;
  score: number;
  match_type: 'exact' | 'normalised' | 'fuzzy';
  listed_on: string | null;
  program: string | null;
}

interface FuzzyCandidate {
  list: SanctionsList;
  candidate_name: string;
  score: number;
  disposition: 'no_match';
}

export interface ScreenResult {
  hits: MatchResult[];
  fuzzy_candidates: FuzzyCandidate[];
}

async function loadList(list: SanctionsList): Promise<SanctionsEntry[]> {
  const cacheKey = `sanctions:list:${list}`;
  const data = await getCached<SanctionsEntry[]>(cacheKey);
  return data ?? [];
}

export async function screenEntity(
  entityName: string,
  lists: SanctionsList[],
  fuzzyThreshold: number,
): Promise<ScreenResult> {
  const hits: MatchResult[] = [];
  const fuzzyCandidates: FuzzyCandidate[] = [];
  const normalisedQuery = normaliseName(entityName);

  for (const list of lists) {
    const entries = await loadList(list);

    for (const entry of entries) {
      const namesToCheck = [entry.name, ...entry.aliases];

      for (const name of namesToCheck) {
        // Tier 1: exact match
        if (name.toLowerCase() === entityName.toLowerCase()) {
          hits.push({
            list,
            entry_id: entry.id,
            matched_name: name,
            score: 1.0,
            match_type: 'exact',
            listed_on: entry.listed_on,
            program: entry.program,
          });
          break;
        }

        // Tier 2: normalised match
        if (normaliseName(name) === normalisedQuery) {
          hits.push({
            list,
            entry_id: entry.id,
            matched_name: name,
            score: 0.99,
            match_type: 'normalised',
            listed_on: entry.listed_on,
            program: entry.program,
          });
          break;
        }

        // Tier 3: fuzzy match
        const score = similarityScore(name, entityName);
        if (score >= fuzzyThreshold) {
          fuzzyCandidates.push({
            list,
            candidate_name: name,
            score,
            disposition: 'no_match',
          });
        }
      }
    }
  }

  // Deduplicate fuzzy candidates (keep highest score per list+name pair)
  const dedupedCandidates = fuzzyCandidates
    .sort((a, b) => b.score - a.score)
    .filter(
      (c, i, arr) =>
        arr.findIndex((x) => x.list === c.list && x.candidate_name === c.candidate_name) === i,
    );

  return { hits, fuzzy_candidates: dedupedCandidates };
}
