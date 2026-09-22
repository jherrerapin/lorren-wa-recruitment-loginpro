export const LEAD_ORIGIN_SCHEMA = {
  name: 'lead_origin',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['UNKNOWN', 'PERSON', 'OTHER'] },
      score: { type: 'number', minimum: 0, maximum: 1 },
      label: { type: ['string', 'null'] },
      evidence: { type: ['string', 'null'] }
    },
    required: ['kind', 'score', 'label', 'evidence']
  }
};
