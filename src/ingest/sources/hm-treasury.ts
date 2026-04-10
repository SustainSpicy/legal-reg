// HM Treasury UK Financial Sanctions List
// Source: https://assets.publishing.service.gov.uk/media/sanctions/ConList.csv (free CSV)
// Updated on working days — ingested every 6 hours

interface SanctionsEntry {
  id: string;
  name: string;
  aliases: string[];
  program: string | null;
  listed_on: string | null;
}

// URL moved to OFSI Azure Blob Storage in 2024
const HMT_URL =
  'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv';

function parseCSVRow(row: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i]!;
    if (char === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

export async function fetchHMTreasury(): Promise<SanctionsEntry[]> {
  const response = await fetch(HMT_URL);
  if (!response.ok) throw new Error(`HM Treasury sanctions fetch failed: ${response.status}`);
  const csv = await response.text();

  const lines = csv.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return [];

  // Row 0 is a metadata line ("Last Updated,DD/MM/YYYY"); row 1 is the real header
  const headers = parseCSVRow(lines[1]!).map((h) => h.toLowerCase().trim());

  const nameIdx = headers.indexOf('name 1');
  const name6Idx = headers.indexOf('name 6'); // entity name field
  const groupIdIdx = headers.indexOf('group id');
  const regimeIdx = headers.indexOf('regime');
  // Column is "listed on" in the 2022 format
  const dateIdx = headers.findIndex((h) => h.startsWith('listed'));

  const entries: SanctionsEntry[] = [];
  const seenIds = new Set<string>();

  for (let i = 2; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]!);
    const groupId = groupIdIdx >= 0 ? cols[groupIdIdx]?.trim() : undefined;
    if (!groupId) continue;
    if (seenIds.has(groupId)) continue;
    seenIds.add(groupId);

    // Use Name 6 (entity name) if present, otherwise Name 1
    const entityName = (name6Idx >= 0 ? cols[name6Idx]?.trim() : '') ||
      (nameIdx >= 0 ? cols[nameIdx]?.trim() : '');
    if (!entityName) continue;

    entries.push({
      id: `HMT_${groupId}`,
      name: entityName,
      aliases: [],
      program: regimeIdx >= 0 ? cols[regimeIdx]?.trim() ?? null : null,
      listed_on: dateIdx >= 0 ? cols[dateIdx]?.trim() ?? null : null,
    });
  }

  return entries;
}
