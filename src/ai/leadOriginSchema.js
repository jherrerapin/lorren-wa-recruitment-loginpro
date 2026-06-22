export const LEAD_ORIGIN_SCHEMA = {
  name: 'lead_origin',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['UNKNOWN', 'PERSON', 'OTHER'] },
      score: { type: 'number' },
      label: { type: ['string', 'null'] }
    },
    required: ['kind', 'score', 'label']
  }
};
