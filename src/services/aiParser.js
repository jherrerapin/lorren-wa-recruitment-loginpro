import axios from 'axios';

export async function tryOpenAIParse(text) {
  if (!process.env.OPENAI_API_KEY) {
    return { used: false, status: 'disabled', intent: null, parsedFields: {} };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const prompt = `Extrae datos de candidato desde texto libre en JSON con claves: intent, fullName, documentType, documentNumber, age, neighborhood, experienceInfo, experienceTime, medicalRestrictions, transportMode. Responde solo JSON válido.`;

  try {
    const response = await axios.post('https://api.openai.com/v1/responses', {
      model,
      temperature: 0,
      input: [
        { role: 'system', content: [{ type: 'text', text: prompt }] },
        { role: 'user', content: [{ type: 'text', text }] }
      ],
      max_output_tokens: 300
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    });

    const outputText = response.data?.output_text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      parsed = {};
    }

    return {
      used: true,
      status: 'ok',
      intent: parsed.intent || null,
      parsedFields: parsed
    };
  } catch (error) {
    return {
      used: true,
      status: 'error',
      intent: null,
      parsedFields: {},
      error
    };
  }
}
