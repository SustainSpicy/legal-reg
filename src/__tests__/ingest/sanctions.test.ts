import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

const mockSetCache = vi.hoisted(() => vi.fn());
const mockSanctionsCacheKey = vi.hoisted(() => vi.fn((list: string) => `sanctions:${list.toLowerCase()}`));

vi.mock('../../cache/helpers.js', () => ({
  setCache: mockSetCache,
  sanctionsCacheKey: mockSanctionsCacheKey,
}));

const mockFetchOFACSDN = vi.hoisted(() => vi.fn());
const mockFetchOFACConsolidated = vi.hoisted(() => vi.fn());

vi.mock('../../ingest/sources/ofac.js', () => ({
  fetchOFACSDN: mockFetchOFACSDN,
  fetchOFACConsolidated: mockFetchOFACConsolidated,
}));

const mockFetchUNList = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/un.js', () => ({ fetchUNList: mockFetchUNList }));

const mockFetchEUCFSP = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/eu-cfsp.js', () => ({ fetchEUCFSP: mockFetchEUCFSP }));

const mockFetchHMTreasury = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/hm-treasury.js', () => ({ fetchHMTreasury: mockFetchHMTreasury }));

const mockFetchFinCEN = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/fincen.js', () => ({ fetchFinCEN: mockFetchFinCEN }));

import { runSanctionsIngest, startSanctionsIngestCron } from '../../ingest/sanctions.js';
import cron from 'node-cron';

const SAMPLE_ENTRIES = [{ id: 'OFAC_1', name: 'Bad Actor', aliases: [], program: 'IRAN', listed_on: '2024-01-01' }];

beforeEach(() => {
  vi.clearAllMocks();
  mockSetCache.mockResolvedValue(undefined);
  mockFetchOFACSDN.mockResolvedValue(SAMPLE_ENTRIES);
  mockFetchOFACConsolidated.mockResolvedValue(SAMPLE_ENTRIES);
  mockFetchUNList.mockResolvedValue(SAMPLE_ENTRIES);
  mockFetchEUCFSP.mockResolvedValue(SAMPLE_ENTRIES);
  mockFetchHMTreasury.mockResolvedValue(SAMPLE_ENTRIES);
  mockFetchFinCEN.mockResolvedValue(SAMPLE_ENTRIES);
});

// ---- runSanctionsIngest -------------------------------------------------------

describe('runSanctionsIngest — parallel execution', () => {
  it('calls all 6 fetchers and writes each to cache', async () => {
    await runSanctionsIngest();

    expect(mockFetchOFACSDN).toHaveBeenCalledOnce();
    expect(mockFetchOFACConsolidated).toHaveBeenCalledOnce();
    expect(mockFetchUNList).toHaveBeenCalledOnce();
    expect(mockFetchEUCFSP).toHaveBeenCalledOnce();
    expect(mockFetchHMTreasury).toHaveBeenCalledOnce();
    expect(mockFetchFinCEN).toHaveBeenCalledOnce();
    expect(mockSetCache).toHaveBeenCalledTimes(6);
  });

  it('caches each list with a 6-hour TTL (21600 seconds)', async () => {
    await runSanctionsIngest();

    for (const call of mockSetCache.mock.calls) {
      const [, , ttl] = call as [string, unknown, number];
      expect(ttl).toBe(21600);
    }
  });

  it('writes the fetched data to cache, not an empty array', async () => {
    await runSanctionsIngest();

    const cachedData = mockSetCache.mock.calls.map(([, data]) => data);
    for (const data of cachedData) {
      expect(data).toEqual(SAMPLE_ENTRIES);
    }
  });

  it('completes even when one fetcher fails (others still cache)', async () => {
    mockFetchUNList.mockRejectedValue(new Error('UN feed down'));
    // MAX_RETRIES=4 so we need the other calls to still complete
    // with fake timers we skip the sleep delays
    vi.useFakeTimers();
    const p = runSanctionsIngest();
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();

    // 5 successful lists should have been cached (all except UN)
    expect(mockSetCache).toHaveBeenCalledTimes(5);
  });
});

// ---- ingestList retry logic (observed via runSanctionsIngest) ----------------

describe('ingestList — exponential backoff retry', () => {
  it('retries up to MAX_RETRIES (4) on failure then gives up', async () => {
    mockFetchOFACSDN.mockRejectedValue(new Error('transient'));
    // Other lists succeed immediately — only OFAC_SDN retries
    vi.useFakeTimers();
    const p = runSanctionsIngest();
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();

    // 4 total attempts (1 initial + 3 retries)
    expect(mockFetchOFACSDN).toHaveBeenCalledTimes(4);
    // No cache write for the failed list
    const sdnKey = mockSanctionsCacheKey.mock.results.find((r) => r.value?.includes('ofac_sdn'))?.value;
    const sdnWrites = mockSetCache.mock.calls.filter(([k]) => k === sdnKey);
    expect(sdnWrites).toHaveLength(0);
  });

  it('succeeds on the second attempt without exhausting retries', async () => {
    mockFetchOFACSDN
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(SAMPLE_ENTRIES);

    vi.useFakeTimers();
    const p = runSanctionsIngest();
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();

    expect(mockFetchOFACSDN).toHaveBeenCalledTimes(2);
    // Should still write to cache after the successful second attempt
    const sdnWrites = mockSetCache.mock.calls.filter(([k]) => k === mockSanctionsCacheKey('OFAC_SDN'));
    expect(sdnWrites).toHaveLength(1);
  });
});

// ---- startSanctionsIngestCron ------------------------------------------------

describe('startSanctionsIngestCron', () => {
  it('schedules a cron job every 6 hours', () => {
    startSanctionsIngestCron();

    expect(cron.schedule).toHaveBeenCalledWith('0 */6 * * *', expect.any(Function));
  });
});
