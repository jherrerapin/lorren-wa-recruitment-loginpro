import { readFileSync, writeFileSync } from 'node:fs';

const file = 'test/fixtures/conversationCases.js';
let source = readFileSync(file, 'utf8');

function replaceInsideCase(id, oldValue, newValue) {
  const marker = `id: '${id}'`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`No existe el escenario ${id}`);

  const blockStart = source.lastIndexOf('\n  {', markerIndex);
  const nextBlock = source.indexOf('\n  {', markerIndex + marker.length);
  const blockEnd = nextBlock >= 0 ? nextBlock : source.length;
  const block = source.slice(blockStart >= 0 ? blockStart : 0, blockEnd);

  if (block.includes(newValue)) return;
  const count = block.split(oldValue).length - 1;
  if (count !== 1) {
    throw new Error(`${id}: se esperaba una ancla y se encontraron ${count}`);
  }

  const updatedBlock = block.replace(oldValue, newValue);
  source = `${source.slice(0, blockStart >= 0 ? blockStart : 0)}${updatedBlock}${source.slice(blockEnd)}`;
}

replaceInsideCase(
  'greeting-not-name',
  "lastReplyIncludes: ['Desde que ciudad', 'vacante o cargo']",
  "lastReplyIncludes: ['Desde que ciudad', 'para que vacante']"
);

for (const id of [
  'city-with-multiple-vacancies-asks-which-one',
  'city-only-does-not-auto-assign-even-with-single-active-city-vacancy'
]) {
  replaceInsideCase(
    id,
    "lastReplyIncludes: ['Ya tengo la ciudad: Ibague', 'cargo o la vacante que te interesa']",
    "lastReplyIncludes: ['gracias por contarme desde donde escribes', 'para que vacante o cargo']"
  );
}

replaceInsideCase(
  'bus-and-independent-recognized',
  "candidate: { transportMode: 'Bus' }",
  "candidate: { transportMode: 'Publico' }"
);

writeFileSync(file, source, 'utf8');
console.log('Harness canonical expectations aligned for #615 by scenario id.');
