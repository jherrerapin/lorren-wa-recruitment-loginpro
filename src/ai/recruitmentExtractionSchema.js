export const RECRUITMENT_EXTRACTION_SCHEMA = {
  name: 'recruitment_turn_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      turnType: { type: 'string', enum: ['GREETING', 'PROVIDE_DATA', 'ASK_QUESTION', 'CONFIRMATION', 'MEDIA', 'OBJECTION', 'OTHER'] },
      fields: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fullName: { type: ['string', 'null'] },
          age: { type: ['integer', 'null'] },
          documentType: { type: ['string', 'null'] },
          documentNumber: { type: ['string', 'null'] },
          gender: { type: ['string', 'null'], enum: ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN', null] },
          locality: { type: ['string', 'null'] },
          neighborhood: { type: ['string', 'null'] },
          transportMode: { type: ['string', 'null'] },
          medicalRestrictions: { type: ['string', 'null'] },
          experienceInfo: { type: ['string', 'null'] },
          experienceTime: { type: ['string', 'null'] }
        },
        required: ['fullName', 'age', 'documentType', 'documentNumber', 'gender', 'locality', 'neighborhood', 'transportMode', 'medicalRestrictions', 'experienceInfo', 'experienceTime']
      },
      fieldEvidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fullName: { $ref: '#/$defs/evidence' },
          age: { $ref: '#/$defs/evidence' },
          documentType: { $ref: '#/$defs/evidence' },
          documentNumber: { $ref: '#/$defs/evidence' },
          gender: { $ref: '#/$defs/evidence' },
          locality: { $ref: '#/$defs/evidence' },
          neighborhood: { $ref: '#/$defs/evidence' },
          transportMode: { $ref: '#/$defs/evidence' },
          medicalRestrictions: { $ref: '#/$defs/evidence' },
          experienceInfo: { $ref: '#/$defs/evidence' },
          experienceTime: { $ref: '#/$defs/evidence' }
        }
      },
      conflicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string', enum: ['fullName', 'age', 'documentType', 'documentNumber', 'gender', 'locality', 'neighborhood', 'transportMode', 'medicalRestrictions', 'experienceInfo', 'experienceTime'] },
            reason: { type: 'string' },
            alternatives: { type: 'array', items: { type: 'string' } }
          },
          required: ['field', 'reason', 'alternatives']
        }
      },
      attachment: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mentioned: { type: 'boolean' },
          kindHint: { type: ['string', 'null'], enum: ['CV', 'ID_DOC', 'OTHER', null] }
        },
        required: ['mentioned', 'kindHint']
      },
      replyIntent: {
        type: 'string',
        enum: ['request_cv_pdf_word', 'request_missing_cv', 'attachment_id_doc', 'attachment_unreadable', 'answer_question_then_continue', 'confirm_correction', 'continue_flow', 'request_missing_data']
      }
    },
    required: ['turnType', 'fields', 'fieldEvidence', 'conflicts', 'attachment', 'replyIntent'],
    $defs: {
      evidence: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snippet: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          source: { type: 'string' }
        },
        required: ['snippet', 'confidence', 'source']
      }
    }
  }
};
