export const DATA_CONSENT_GATE_SCHEMA = {
  name: 'data_consent_gate_decision',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['ALLOW_INFO_FLOW', 'ASK_CONSENT', 'UNKNOWN']
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      reason: {
        type: 'string'
      }
    },
    required: ['action', 'confidence', 'reason']
  }
};
