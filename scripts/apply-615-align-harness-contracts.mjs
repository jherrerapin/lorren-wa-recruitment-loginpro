import { readFileSync, writeFileSync } from 'node:fs';

const file = 'test/fixtures/conversationCases.js';
let source = readFileSync(file, 'utf8');

const replacements = [
  [
    "      lastReplyIncludes: ['Desde que ciudad', 'vacante o cargo']",
    "      lastReplyIncludes: ['Desde que ciudad', 'para que vacante']",
    'saludo inicial'
  ],
  [
    "      lastReplyIncludes: ['Ya tengo la ciudad: Ibague', 'cargo o la vacante que te interesa'],",
    "      lastReplyIncludes: ['gracias por contarme desde donde escribes', 'para que vacante o cargo'],",
    'ciudad con múltiples vacantes'
  ],
  [
    "      candidate: { transportMode: 'Bus' }",
    "      candidate: { transportMode: 'Publico' }",
    'transporte bus'
  ]
];

for (const [oldValue, newValue, label] of replacements) {
  if (source.includes(newValue)) continue;
  const count = source.split(oldValue).length - 1;
  const expectedCount = label === 'ciudad con múltiples vacantes' ? 2 : 1;
  if (count !== expectedCount) {
    throw new Error(`${label}: se esperaban ${expectedCount} anclas y se encontraron ${count}`);
  }
  source = source.split(oldValue).join(newValue);
}

writeFileSync(file, source, 'utf8');
console.log('Harness canonical expectations aligned for #615.');
