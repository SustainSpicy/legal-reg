// FinCEN Civil Money Penalties (CMP) enforcement actions — public data
// Source: https://www.fincen.gov/news/enforcement-actions
// The enforcement actions page lists every civil penalty FinCEN has issued.
// We scrape the HTML table nightly; entries are organisations/individuals
// subject to BSA/AML civil penalties. This is distinct from the 314(a) list
// (which requires an institutional subscription and is never public).

interface SanctionsEntry {
  id: string;
  name: string;
  aliases: string[];
  program: string | null;
  listed_on: string | null;
}

const ENFORCEMENT_URL = 'https://www.fincen.gov/news/enforcement-actions';

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
}

function parseEnforcementPage(html: string): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];

  // FinCEN enforcement page: <table class="usa-table ...">
  // Columns: 0=Enforcement Action (entity name in <a>), 1=Date (<time datetime="ISO">), 2=Matter No, 3=Institution Type
  const tableMatch = /<table[^>]*usa-table[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) {
    console.warn('[ingest:fincen] Could not find usa-table in FinCEN enforcement page');
    return entries;
  }

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  let isHeader = true;

  while ((rowMatch = rowRegex.exec(tableMatch[0])) !== null) {
    if (isHeader) { isHeader = false; continue; }

    const cellsRaw = [...rowMatch[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((c) => c[1]!);

    if (cellsRaw.length < 2) continue;

    // Col 0: entity name — may be wrapped in <a href="...">Name</a>
    const respondent = stripTags(cellsRaw[0]!);
    if (!respondent || respondent.length < 2) continue;

    // Col 1: date — prefer datetime attribute on <time>, fall back to text
    const datetimeAttr = /datetime="([^"]+)"/.exec(cellsRaw[1]!);
    let listedOn: string | null = null;
    if (datetimeAttr) {
      // ISO datetime like "2026-03-06T12:00:00Z" → truncate to date
      listedOn = datetimeAttr[1]!.slice(0, 10);
    } else {
      const dateText = stripTags(cellsRaw[1]!);
      const parts = dateText.split('/');
      if (parts.length === 3) {
        listedOn = `${parts[2]}-${parts[0]!.padStart(2, '0')}-${parts[1]!.padStart(2, '0')}`;
      }
    }

    entries.push({
      id: `FinCEN_CMP_${listedOn ?? ''}_${entries.length}`,
      name: respondent,
      aliases: [],
      program: 'BSA_CMP',
      listed_on: listedOn,
    });
  }

  return entries;
}

export async function fetchFinCEN(): Promise<SanctionsEntry[]> {
  const res = await fetch(ENFORCEMENT_URL, {
    headers: {
      'User-Agent': 'CorpSignal-MCP/1.0',
      Accept: 'text/html',
    },
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest:fincen] Fetch failed: ${msg}`);
    return null;
  });

  if (!res?.ok) {
    console.error(`[ingest:fincen] HTTP ${res?.status ?? 'unknown'} — returning empty list`);
    return [];
  }

  const html = await res.text();
  const entries = parseEnforcementPage(html);
  console.log(`[ingest:fincen] Parsed ${entries.length} CMP enforcement actions`);
  return entries;
}
