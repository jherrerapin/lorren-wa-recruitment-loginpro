const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';

function readModelEnv(name) {
  const value = String(process.env[name] || '').trim();
  return value || null;
}

function resolveModel(envNames = []) {
  for (const envName of envNames) {
    const value = readModelEnv(envName);
    if (value) return { model: value, source: envName };
  }
  return { model: DEFAULT_OPENAI_MODEL, source: 'default' };
}

function buildSelections() {
  return {
    conversation: resolveModel(['OPENAI_MODEL']),
    extraction: resolveModel(['OPENAI_EXTRACTION_MODEL', 'OPENAI_MODEL']),
    cvAnalysis: resolveModel(['OPENAI_CV_MODEL', 'OPENAI_EXTRACTION_MODEL', 'OPENAI_MODEL']),
    attachment: resolveModel(['OPENAI_ATTACHMENT_MODEL', 'OPENAI_EXTRACTION_MODEL', 'OPENAI_MODEL']),
    contextualReply: resolveModel(['OPENAI_CONTEXTUAL_REPLY_MODEL', 'OPENAI_MODEL']),
    supervisorReply: resolveModel(['OPENAI_SUPERVISOR_REPLY_MODEL', 'OPENAI_MODEL'])
  };
}

const selections = buildSelections();

export const OPENAI_CONVERSATION_MODEL = selections.conversation.model;
export const OPENAI_EXTRACTION_MODEL = selections.extraction.model;
export const OPENAI_CV_MODEL = selections.cvAnalysis.model;
export const OPENAI_ATTACHMENT_MODEL = selections.attachment.model;
export const OPENAI_CONTEXTUAL_REPLY_MODEL = selections.contextualReply.model;
export const OPENAI_SUPERVISOR_REPLY_MODEL = selections.supervisorReply.model;

export function getOpenAiModelConfig() {
  const currentSelections = buildSelections();
  return {
    defaultModel: DEFAULT_OPENAI_MODEL,
    conversation: currentSelections.conversation,
    extraction: currentSelections.extraction,
    cvAnalysis: currentSelections.cvAnalysis,
    attachment: currentSelections.attachment,
    contextualReply: currentSelections.contextualReply,
    supervisorReply: currentSelections.supervisorReply
  };
}

export { DEFAULT_OPENAI_MODEL };
