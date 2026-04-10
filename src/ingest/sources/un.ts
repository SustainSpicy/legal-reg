// UN Security Council Consolidated Sanctions List (1267 Committee)
// Source: https://scsanctions.un.org/resources/xml/en/consolidated.xml (free, official XML)
// Updated irregularly — ingested every 6 hours

interface SanctionsEntry {
  id: string;
  name: string;
  aliases: string[];
  program: string | null;
  listed_on: string | null;
}

const UN_LIST_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';

export async function fetchUNList(): Promise<SanctionsEntry[]> {
  const response = await fetch(UN_LIST_URL);
  if (!response.ok) throw new Error(`UN sanctions list fetch failed: ${response.status}`);
  const xml = await response.text();

  const entries: SanctionsEntry[] = [];
  const entityRegex = /<ENTITY>([\s\S]*?)<\/ENTITY>/g;
  let match: RegExpExecArray | null;

  while ((match = entityRegex.exec(xml)) !== null) {
    const block = match[1]!;

    const idMatch = /<REFERENCE_NUMBER>([^<]+)<\/REFERENCE_NUMBER>/.exec(block);
    const nameMatch = /<FIRST_NAME>([^<]*)<\/FIRST_NAME>|<SECOND_NAME>([^<]*)<\/SECOND_NAME>|<THIRD_NAME>([^<]*)<\/THIRD_NAME>/g;
    const listedMatch = /<LISTED_ON>([^<]+)<\/LISTED_ON>/.exec(block);

    if (!idMatch) continue;

    const nameParts: string[] = [];
    let nm: RegExpExecArray | null;
    while ((nm = nameMatch.exec(block)) !== null) {
      const part = nm[1] ?? nm[2] ?? nm[3];
      if (part?.trim()) nameParts.push(part.trim());
    }

    const primaryName = nameParts.join(' ').trim();
    if (!primaryName) continue;

    // Extract aliases
    const aliases: string[] = [];
    const aliasRegex = /<ALIAS>([\s\S]*?)<\/ALIAS>/g;
    let aliasMatch: RegExpExecArray | null;
    while ((aliasMatch = aliasRegex.exec(block)) !== null) {
      const aliasBlock = aliasMatch[1]!;
      const aliasNameMatch = /<ALIAS_NAME>([^<]+)<\/ALIAS_NAME>/.exec(aliasBlock);
      if (aliasNameMatch) aliases.push(aliasNameMatch[1]!.trim());
    }

    entries.push({
      id: `UN_${idMatch[1]!.trim()}`,
      name: primaryName,
      aliases,
      program: 'UN_1267',
      listed_on: listedMatch ? listedMatch[1]!.trim() : null,
    });
  }

  return entries;
}
