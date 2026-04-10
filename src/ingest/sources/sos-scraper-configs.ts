// Per-state scraper configurations for the 8 no-API SOS portals
// Each config describes how to navigate, search, and extract entity data
// from the state's website. Used by sos-scraper.ts at 2am UTC nightly.

export interface ScraperConfig {
  jurisdiction: string;
  searchUrl: string;
  searchInputSelector: string;
  searchButtonSelector: string;
  resultRowSelector: string;
  fields: {
    name: string;
    status?: string;
    incorporatedAt?: string;
    registeredAgent?: string;
    registeredAgentAddress?: string;
    entityId?: string;
  };
  pagination?: {
    nextButtonSelector: string;
    maxPages: number;
  };
}

export const SCRAPER_CONFIGS: ScraperConfig[] = [
  {
    jurisdiction: 'US-AL',
    searchUrl: 'https://arc-sos.state.al.us/CGI/SOSORG.MBR/input',
    searchInputSelector: 'input[name="ORGNAME"]',
    searchButtonSelector: 'input[type="submit"]',
    resultRowSelector: 'table tr:not(:first-child)',
    fields: {
      name: 'td:nth-child(1)',
      status: 'td:nth-child(3)',
      incorporatedAt: 'td:nth-child(4)',
      entityId: 'td:nth-child(2)',
    },
  },
  {
    jurisdiction: 'US-AK',
    searchUrl: 'https://www.commerce.alaska.gov/cbp/main/search/entities',
    searchInputSelector: 'input[name="EntityName"]',
    searchButtonSelector: 'button[type="submit"]',
    resultRowSelector: '.search-result-row',
    fields: {
      name: '.entity-name',
      status: '.entity-status',
      incorporatedAt: '.formed-date',
      entityId: '.entity-number',
    },
  },
  {
    jurisdiction: 'US-AR',
    searchUrl: 'https://www.sos.arkansas.gov/corps/search_all.php',
    searchInputSelector: 'input[name="corp_name"]',
    searchButtonSelector: 'input[type="submit"]',
    resultRowSelector: 'table.corps tr:not(:first-child)',
    fields: {
      name: 'td:nth-child(1) a',
      status: 'td:nth-child(3)',
      incorporatedAt: 'td:nth-child(4)',
      entityId: 'td:nth-child(2)',
    },
  },
  {
    jurisdiction: 'US-HI',
    searchUrl: 'https://hbe.ehawaii.gov/documents/search.html',
    searchInputSelector: 'input#entityName',
    searchButtonSelector: 'button#searchButton',
    resultRowSelector: 'table#searchResults tbody tr',
    fields: {
      name: 'td:nth-child(1)',
      status: 'td:nth-child(4)',
      incorporatedAt: 'td:nth-child(3)',
      entityId: 'td:nth-child(2)',
    },
  },
  {
    jurisdiction: 'US-MS',
    searchUrl: 'https://corp.sos.ms.gov/corp/portal/c/page/corpBusinessIdSearch/portal.aspx',
    searchInputSelector: 'input[id*="EntityName"]',
    searchButtonSelector: 'input[id*="btnSearch"]',
    resultRowSelector: 'table[id*="GridView"] tr:not(:first-child)',
    fields: {
      name: 'td:nth-child(2)',
      status: 'td:nth-child(4)',
      incorporatedAt: 'td:nth-child(5)',
      entityId: 'td:nth-child(1)',
    },
  },
  {
    jurisdiction: 'US-MT',
    searchUrl: 'https://biz.sosmt.gov/search/business',
    searchInputSelector: 'input[name="businessName"]',
    searchButtonSelector: 'button[type="submit"]',
    resultRowSelector: '.search-results .result-item',
    fields: {
      name: '.business-name',
      status: '.status',
      incorporatedAt: '.formed-date',
      entityId: '.id-number',
    },
  },
  {
    jurisdiction: 'US-ND',
    searchUrl: 'https://firststop.sos.nd.gov/search/business',
    searchInputSelector: 'input[placeholder*="business name"], input[name*="name"]',
    searchButtonSelector: 'button[type="submit"]',
    resultRowSelector: '.search-results tbody tr',
    fields: {
      name: 'td:nth-child(1)',
      status: 'td:nth-child(3)',
      incorporatedAt: 'td:nth-child(4)',
      entityId: 'td:nth-child(2)',
    },
  },
  {
    jurisdiction: 'US-WV',
    searchUrl: 'https://apps.wv.gov/SOS/BusinessEntitySearch/',
    searchInputSelector: 'input#EntityName',
    searchButtonSelector: 'input#btnSearch',
    resultRowSelector: '#grdResults tr:not(:first-child)',
    fields: {
      name: 'td:nth-child(1)',
      status: 'td:nth-child(3)',
      incorporatedAt: 'td:nth-child(4)',
      entityId: 'td:nth-child(2)',
    },
  },
];
