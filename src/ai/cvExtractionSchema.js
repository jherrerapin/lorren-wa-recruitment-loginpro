export const CV_EXTRACTION_SCHEMA = {
  name: 'loren_v2_cv_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fullName: { type: ['string', 'null'] },
      documentNumber: { type: ['string', 'null'] },
      phone: { type: ['string', 'null'] },
      email: { type: ['string', 'null'] },
      city: { type: ['string', 'null'] },
      locality: { type: ['string', 'null'] },
      experienceSummary: { type: ['string', 'null'] },
      lastRole: { type: ['string', 'null'] },
      educationSummary: { type: ['string', 'null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['fullName', 'documentNumber', 'phone', 'email', 'city', 'locality', 'experienceSummary', 'lastRole', 'educationSummary', 'confidence', 'warnings']
  }
};
