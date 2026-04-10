// FATF Jurisdiction Risk Classifications
// Source: Financial Action Task Force (FATF) public statements
// Last updated: October 2024 plenary
// Refreshed via URL at runtime if FATF_REFRESH_ENABLED=true (default: static)

// FATF "Call for Action" — highest risk, subject to counter-measures (blacklist)
export const FATF_HIGH_RISK_JURISDICTIONS = new Set([
  'KP', // North Korea
  'IR', // Iran
  'MM', // Myanmar
]);

// FATF "Increased Monitoring" — under scrutiny, working with FATF (grey list)
export const FATF_GREY_LIST_JURISDICTIONS = new Set([
  'AL', // Albania
  'BB', // Barbados
  'BF', // Burkina Faso
  'CM', // Cameroon
  'CF', // Central African Republic
  'CD', // Congo, Democratic Republic
  'HT', // Haiti
  'JM', // Jamaica
  'JO', // Jordan
  'KE', // Kenya
  'ML', // Mali
  'MZ', // Mozambique
  'NA', // Namibia
  'NI', // Nicaragua
  'NG', // Nigeria
  'PK', // Pakistan
  'PA', // Panama
  'PH', // Philippines
  'SN', // Senegal
  'SS', // South Sudan
  'SY', // Syria
  'TZ', // Tanzania
  'TT', // Trinidad and Tobago
  'TR', // Turkey
  'UG', // Uganda
  'AE', // United Arab Emirates
  'VN', // Vietnam
  'YE', // Yemen
  'ZM', // Zambia
]);

// OFAC-sanctioned jurisdictions (US Treasury — subject to comprehensive sanctions)
// These are in addition to FATF classifications
export const OFAC_COMPREHENSIVELY_SANCTIONED = new Set([
  'BY', // Belarus
  'CU', // Cuba
  'RU', // Russia
  'VE', // Venezuela
]);

// All jurisdictions warranting elevated risk score contribution
// Union of FATF blacklist + grey list + OFAC comprehensive
export const ALL_ELEVATED_RISK_JURISDICTIONS = new Set([
  ...FATF_HIGH_RISK_JURISDICTIONS,
  ...FATF_GREY_LIST_JURISDICTIONS,
  ...OFAC_COMPREHENSIVELY_SANCTIONED,
]);

export type JurisdictionRiskLevel = 'blacklist' | 'greylist' | 'ofac_sanctioned' | 'standard';

export function getJurisdictionRiskLevel(isoCode: string): JurisdictionRiskLevel {
  if (FATF_HIGH_RISK_JURISDICTIONS.has(isoCode)) return 'blacklist';
  if (OFAC_COMPREHENSIVELY_SANCTIONED.has(isoCode)) return 'ofac_sanctioned';
  if (FATF_GREY_LIST_JURISDICTIONS.has(isoCode)) return 'greylist';
  return 'standard';
}

// Risk score contribution by level (used in compliance_risk_score signal weighting)
export const JURISDICTION_RISK_SCORE: Record<JurisdictionRiskLevel, number> = {
  blacklist: 1.0,
  ofac_sanctioned: 0.9,
  greylist: 0.5,
  standard: 0.0,
};
