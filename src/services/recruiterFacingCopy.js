const CV_DATE_NOTE_PATTERN = /\s*<div class="date-note">El rango se aplica a la <strong>fecha de registro del candidato<\/strong>, antes de leer documentos o consumir OpenAI\. Si dejas ambas fechas vacías se revisarán todos los candidatos elegibles, hasta el límite operativo\.<\/div>/i;

export function removeRecruiterTechnicalCopy(html) {
  if (typeof html !== 'string') return html;
  if (!html.includes('/admin/estadisticas/cv-analysis/run')) return html;
  return html.replace(CV_DATE_NOTE_PATTERN, '');
}
