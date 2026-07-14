/**
 * Contrato transitorio de etiquetas usadas por los fallbacks de naturalReply.
 *
 * Este módulo ya no decide el avance de una conversación. La interpretación y
 * la política del turno deben resolverse antes de redactar la respuesta; el
 * redactor únicamente recibe una acción previamente validada.
 *
 * El archivo se eliminará cuando naturalReply deje de depender de estas
 * etiquetas heredadas.
 */
export const FlowDeciderAction = Object.freeze({
  IDENTIFY_VACANCY: 'IDENTIFY_VACANCY',
  PRESENT_VACANCY: 'PRESENT_VACANCY',
  COLLECT_DATA: 'COLLECT_DATA',
  REQUEST_CV: 'REQUEST_CV',
  SCHEDULE_INTERVIEW: 'SCHEDULE_INTERVIEW',
  CONFIRM_RECEIPT: 'CONFIRM_RECEIPT',
  SAVE_PROFILE: 'SAVE_PROFILE',
  ANSWER_FROM_VACANCY: 'ANSWER_FROM_VACANCY',
  ESCALATE_TO_ADMIN: 'ESCALATE_TO_ADMIN'
});
