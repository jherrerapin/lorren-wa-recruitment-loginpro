const COMPLETE_EXPORT_FORM_PATTERN = /<form class="export-form" method="post" action="\/admin\/estadisticas\/cv-analysis\/export">\s*<input type="hidden" name="reviewToken" value="([^"]+)">\s*<input type="hidden" name="group" value="all">\s*<button class="btn small" type="submit">Descargar Excel completo<\/button>\s*<\/form>/i;

const SECTION_EXPORT_FORM_PATTERN = /<form class="export-form" method="post" action="\/admin\/estadisticas\/cv-analysis\/export">[\s\S]*?<button class="btn secondary small" type="submit">Descargar esta sección<\/button>\s*<\/form>/gi;

const EXPORT_STYLES = `
    .export-selector { min-width:min(100%,470px); border:1px solid var(--border); border-radius:12px; padding:13px; background:#f8fafc; }
    .export-selector-title { display:block; color:var(--navy); font-size:13px; font-weight:900; margin-bottom:9px; }
    .export-choices { display:flex; flex-wrap:wrap; gap:8px; }
    .export-choice { display:inline-flex; flex-direction:row; align-items:center; gap:6px; border:1px solid #d0d5dd; border-radius:999px; padding:7px 10px; background:#fff; color:#344054; font-size:12px; font-weight:750; cursor:pointer; }
    .export-choice input { width:16px; height:16px; margin:0; accent-color:var(--green); }
    .export-selector-footer { display:flex; justify-content:flex-end; align-items:center; gap:10px; margin-top:11px; flex-wrap:wrap; }
    .export-validation { color:var(--red); font-size:12px; font-weight:700; margin-right:auto; }
    @media(max-width:760px) { .export-selector{width:100%;min-width:0}.export-selector-footer .btn{width:100%}.export-choice{width:100%;border-radius:9px} }
`;

const EXPORT_SCRIPT = `<script>
(() => {
  const form = document.querySelector('[data-cv-export-selector]');
  if (!form) return;

  const allCheckbox = form.querySelector('[data-export-all]');
  const groupCheckboxes = [...form.querySelectorAll('[data-export-group]')];
  const groupValue = form.querySelector('[data-export-group-value]');
  const submitButton = form.querySelector('button[type="submit"]');
  const validation = form.querySelector('[data-export-validation]');

  function updateSelection() {
    const selected = groupCheckboxes.filter((checkbox) => checkbox.checked);
    const allSelected = selected.length === groupCheckboxes.length;
    allCheckbox.checked = allSelected;
    allCheckbox.indeterminate = selected.length > 0 && !allSelected;
    groupValue.value = allSelected ? 'all' : selected.map((checkbox) => checkbox.value).join(',');
    submitButton.disabled = selected.length === 0;
    validation.hidden = selected.length > 0;
  }

  allCheckbox.addEventListener('change', () => {
    groupCheckboxes.forEach((checkbox) => { checkbox.checked = allCheckbox.checked; });
    updateSelection();
  });

  groupCheckboxes.forEach((checkbox) => checkbox.addEventListener('change', updateSelection));
  form.addEventListener('submit', (event) => {
    updateSelection();
    if (!groupValue.value) event.preventDefault();
  });

  updateSelection();
})();
</script>`;

function exportSelectorForm(reviewToken) {
  return `<form class="export-selector" method="post" action="/admin/estadisticas/cv-analysis/export" data-cv-export-selector>
    <input type="hidden" name="reviewToken" value="${reviewToken}">
    <input type="hidden" name="group" value="all" data-export-group-value>
    <span class="export-selector-title">Selecciona qué resultados incluir en el Excel</span>
    <div class="export-choices">
      <label class="export-choice"><input type="checkbox" data-export-all checked> Todos</label>
      <label class="export-choice"><input type="checkbox" value="strong" data-export-group checked> Coincidencia alta</label>
      <label class="export-choice"><input type="checkbox" value="possible" data-export-group checked> Pueden encajar</label>
      <label class="export-choice"><input type="checkbox" value="low" data-export-group checked> Poca evidencia</label>
      <label class="export-choice"><input type="checkbox" value="manual" data-export-group checked> Revisión manual</label>
    </div>
    <div class="export-selector-footer">
      <span class="export-validation" data-export-validation hidden>Selecciona al menos una categoría.</span>
      <button class="btn small" type="submit">Descargar Excel seleccionado</button>
    </div>
  </form>`;
}

export function enhanceCvAnalysisExportSelection(html) {
  if (typeof html !== 'string' || !html.includes('/admin/estadisticas/cv-analysis/export')) return html;
  const match = html.match(COMPLETE_EXPORT_FORM_PATTERN);
  if (!match) return html;

  let output = html.replace(COMPLETE_EXPORT_FORM_PATTERN, exportSelectorForm(match[1]));
  output = output.replace(SECTION_EXPORT_FORM_PATTERN, '');
  output = output.replace('</style>', `${EXPORT_STYLES}  </style>`);
  output = output.replace('</body>', `${EXPORT_SCRIPT}\n</body>`);
  return output;
}
