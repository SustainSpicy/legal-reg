import { lookupCaliforniaEntity } from '../src/ingest/sources/sos-california.js';

console.log('PROXY_SERVER:', process.env['PROXY_SERVER'] ?? '(not set)');
console.log('Testing CA BizFile via Playwright + Decodo proxy...\n');

const entities = ['Apple Inc', 'PG&E Corp', 'Edison International'];

for (const name of entities) {
  process.stdout.write(`  ${name} → `);
  const r = await lookupCaliforniaEntity(name);
  if (r) {
    console.log(`✓ ${r.canonical_name} | ${r.status} | conf=${r.confidence} | source=${r.source}`);
  } else {
    console.log('✗ null');
  }
}
