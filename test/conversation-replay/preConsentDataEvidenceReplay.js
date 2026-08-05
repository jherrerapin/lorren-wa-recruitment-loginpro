export const PRE_CONSENT_DATA_EVIDENCE_REPLAYS = Object.freeze([
  { id: 'conv-003-city-only', sourceConversation: 'CONV-003', body: 'Neiva', expectedFields: [] },
  { id: 'conv-004-greeting', sourceConversation: 'CONV-004', body: 'Buenas tardes', expectedFields: [] },
  { id: 'conv-007-information', sourceConversation: 'CONV-007', body: 'Hola, quiero más información.', expectedFields: [] },
  { id: 'conv-009-role', sourceConversation: 'CONV-009', body: 'Líder logístico', expectedFields: [] },
  { id: 'conv-011-information', sourceConversation: 'CONV-011', body: 'Hola, quiero más información.', expectedFields: [] },
  { id: 'conv-012-multiple-roles', sourceConversation: 'CONV-012', body: 'Líder de Operaciones. Supervisor de Operaciones.', expectedFields: [] },
  { id: 'conv-013-role', sourceConversation: 'CONV-013', body: 'Coordinador', expectedFields: [] },
  { id: 'conv-018-information', sourceConversation: 'CONV-018', body: 'Hola, quiero más información.', expectedFields: [] },
  { id: 'conv-021-information', sourceConversation: 'CONV-021', body: 'Hola, quiero más información.', expectedFields: [] },
  { id: 'conv-029-information', sourceConversation: 'CONV-029', body: 'Hola, quiero más información.', expectedFields: [] },
  { id: 'conv-042-role-city', sourceConversation: 'CONV-042', body: 'Coordinador logístico Neiva', expectedFields: [] },
  { id: 'conv-047-city-only', sourceConversation: 'CONV-047', body: 'Neiva', expectedFields: [] },
  { id: 'conv-048-information', sourceConversation: 'CONV-048', body: 'Hola, quiero más información.', expectedFields: [] },
  { id: 'conv-051-greeting', sourceConversation: 'CONV-051', body: 'Hola, buenos días', expectedFields: [] },
  { id: 'conv-052-city-vacancies', sourceConversation: 'CONV-052', body: 'En Neiva, ¿qué cargos tienen disponibles?', expectedFields: [] },
  { id: 'conv-055-information', sourceConversation: 'CONV-055', body: 'Hola, quiero más información.', expectedFields: [] },
  { id: 'conv-065-role', sourceConversation: 'CONV-065', body: 'Líder de operaciones', expectedFields: [] },
  { id: 'conv-079-confirmation', sourceConversation: 'CONV-079', body: 'Confirmo', expectedFields: [] },
  { id: 'required-vacancy-available', sourceConversation: 'SYNTHETIC', body: '¿La vacante sigue disponible?', expectedFields: [] },
  { id: 'required-city-question', sourceConversation: 'SYNTHETIC', body: '¿La vacante es en Bogotá?', expectedFields: [] },
  { id: 'required-role-interest', sourceConversation: 'SYNTHETIC', body: 'Estoy interesado en auxiliar de bodega', expectedFields: [] },
  { id: 'required-profession', sourceConversation: 'SYNTHETIC', body: 'Trabajo en logística', expectedFields: [] },
  { id: 'required-experience', sourceConversation: 'SYNTHETIC', body: 'Tengo experiencia como operario', expectedFields: [] },
  { id: 'required-city-staffing', sourceConversation: 'SYNTHETIC', body: '¿Necesitan personal en Neiva?', expectedFields: [] },
  { id: 'ambiguous-role', sourceConversation: 'SYNTHETIC', body: 'Soy auxiliar de bodega', expectedFields: [] },
  { id: 'ambiguous-city', sourceConversation: 'SYNTHETIC', body: 'Bogotá', expectedFields: [] },
  { id: 'ambiguous-work', sourceConversation: 'SYNTHETIC', body: 'Trabajo en despachos', expectedFields: [] },
  { id: 'ambiguous-moto', sourceConversation: 'SYNTHETIC', body: 'Tengo moto', expectedFields: [] },
  { id: 'explicit-name', sourceConversation: 'SYNTHETIC', body: 'Me llamo Nombre de Prueba', expectedFields: ['fullName'] },
  { id: 'explicit-document', sourceConversation: 'SYNTHETIC', body: 'Mi cédula es TEST-100000001', expectedFields: ['documentNumber'] },
  { id: 'explicit-age', sourceConversation: 'SYNTHETIC', body: 'Tengo 30 años', expectedFields: ['age'] },
  { id: 'explicit-residence', sourceConversation: 'SYNTHETIC', body: 'Vivo en Barrio de Prueba', expectedFields: ['neighborhood'] },
  { id: 'explicit-transport', sourceConversation: 'SYNTHETIC', body: 'Mi transporte es moto', expectedFields: ['transportMode'] },
  {
    id: 'explicit-multiple-fields',
    sourceConversation: 'SYNTHETIC',
    body: 'Me llamo Nombre de Prueba. Tengo 30 años. Vivo en Barrio de Prueba. Mi transporte es moto.',
    expectedFields: ['fullName', 'age', 'neighborhood', 'transportMode']
  }
]);

export const PRE_CONSENT_DATA_EVIDENCE_INCOMPLETE = Object.freeze([
  'CONV-002',
  'CONV-039',
  'CONV-050',
  'CONV-064'
]);
