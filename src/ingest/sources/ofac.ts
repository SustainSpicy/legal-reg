// OFAC SDN and Consolidated Lists
// Source: https://ofac.treas.gov/ofac-consolidated-non-sdn-lists (free, official XML)
// Updated daily by OFAC

interface SanctionsEntry {
  id: string;
  name: string;
  aliases: string[];
  program: string | null;
  listed_on: string | null;
}

// OFAC moved downloads to sanctionslistservice.ofac.treas.gov in 2024.
// Old treasury.gov URLs 302 redirect but Node fetch fails on the redirect chain.
const OFAC_SDN_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml';
const OFAC_CONS_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/consolidated.xml';

function parseOFACXml(xmlText: string): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];
  // Parse <sdnEntry> blocks
  const entryRegex = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xmlText)) !== null) {
    const block = match[1]!;

    const idMatch = /<uid>(\d+)<\/uid>/.exec(block);
    const lastNameMatch = /<lastName>([^<]+)<\/lastName>/.exec(block);
    const firstNameMatch = /<firstName>([^<]+)<\/firstName>/.exec(block);
    const programMatch = /<program>([^<]+)<\/program>/.exec(block);
    const listedDateMatch = /<publishInformation>[\s\S]*?<publishDate>([^<]+)<\/publishDate>/i.exec(block);

    if (!idMatch || !lastNameMatch) continue;

    const lastName = lastNameMatch[1]!.trim();
    const firstName = firstNameMatch ? firstNameMatch[1]!.trim() : '';
    const primaryName = firstName ? `${firstName} ${lastName}` : lastName;

    // Extract aliases
    const aliases: string[] = [];
    const akaRegex = /<aka>([\s\S]*?)<\/aka>/g;
    let akaMatch: RegExpExecArray | null;
    while ((akaMatch = akaRegex.exec(block)) !== null) {
      const akaBlock = akaMatch[1]!;
      const akaLast = /<lastName>([^<]+)<\/lastName>/.exec(akaBlock);
      const akaFirst = /<firstName>([^<]+)<\/firstName>/.exec(akaBlock);
      if (akaLast) {
        aliases.push(
          akaFirst ? `${akaFirst[1]!.trim()} ${akaLast[1]!.trim()}` : akaLast[1]!.trim(),
        );
      }
    }

    entries.push({
      id: `OFAC_${idMatch[1]!}`,
      name: primaryName,
      aliases,
      program: programMatch ? programMatch[1]!.trim() : null,
      listed_on: listedDateMatch ? listedDateMatch[1]!.trim() : null,
    });
  }

  return entries;
}

export async function fetchOFACSDN(): Promise<SanctionsEntry[]> {
  const response = await fetch(OFAC_SDN_URL);
  if (!response.ok) throw new Error(`OFAC SDN fetch failed: ${response.status}`);
  const xml = await response.text();
  return parseOFACXml(xml);
}

export async function fetchOFACConsolidated(): Promise<SanctionsEntry[]> {
  const response = await fetch(OFAC_CONS_URL);
  if (!response.ok) throw new Error(`OFAC Consolidated fetch failed: ${response.status}`);
  const xml = await response.text();
  return parseOFACXml(xml);
}
