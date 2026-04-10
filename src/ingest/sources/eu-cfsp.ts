// EU Common Foreign and Security Policy (CFSP) Sanctions List
// Source: https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions
// Free XML feed — updated irregularly, ingested every 6 hours

interface SanctionsEntry {
  id: string;
  name: string;
  aliases: string[];
  program: string | null;
  listed_on: string | null;
}

const EU_CFSP_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';

export async function fetchEUCFSP(): Promise<SanctionsEntry[]> {
  const response = await fetch(EU_CFSP_URL);
  if (!response.ok) throw new Error(`EU CFSP sanctions fetch failed: ${response.status}`);
  const xml = await response.text();

  const entries: SanctionsEntry[] = [];
  // logicalId is an attribute on <sanctionEntity>, not a child element
  const subjectRegex = /<sanctionEntity\s[^>]*logicalId="(\d+)"[^>]*>([\s\S]*?)<\/sanctionEntity>/g;
  let match: RegExpExecArray | null;

  while ((match = subjectRegex.exec(xml)) !== null) {
    const logicalId = match[1]!;
    const block = match[2]!;
    const nameMatch = /<nameAlias[^>]*firstName="([^"]*)"[^>]*lastName="([^"]*)"/.exec(block);
    const wholeNameMatch = /<nameAlias[^>]*wholeName="([^"]+)"/.exec(block);
    const regulationMatch = /<regulation[^>]*numberTitle="([^"]+)"/.exec(block);
    const dateMatch = /<regulation[^>]*entryIntoForceDate="([^"]+)"/.exec(block);
    const programMatch = /<regulation[^>]*programme="([^"]+)"/.exec(block);

    let primaryName = '';
    if (wholeNameMatch) {
      primaryName = wholeNameMatch[1]!.trim();
    } else if (nameMatch) {
      primaryName = `${nameMatch[1]!.trim()} ${nameMatch[2]!.trim()}`.trim();
    }
    if (!primaryName) continue;

    // Collect all name aliases
    const aliases: string[] = [];
    const aliasRegex = /wholeName="([^"]+)"/g;
    let aliasMatch: RegExpExecArray | null;
    while ((aliasMatch = aliasRegex.exec(block)) !== null) {
      if (aliasMatch[1] !== primaryName) aliases.push(aliasMatch[1]!.trim());
    }

    entries.push({
      id: `EU_${logicalId}`,
      name: primaryName,
      aliases,
      program: programMatch ? programMatch[1]!.trim() : (regulationMatch ? regulationMatch[1]!.trim() : 'EU_CFSP'),
      listed_on: dateMatch ? dateMatch[1]!.trim() : null,
    });
  }

  return entries;
}
