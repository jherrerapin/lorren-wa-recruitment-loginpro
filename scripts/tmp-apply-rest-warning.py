from pathlib import Path
import re

view_path = Path('src/views/operacionesAsignacionesConfirmacion.ejs')
source = view_path.read_text(encoding='utf-8')

old_card = 'data-contract-type="<%= worker.contractType %>" data-worker-cities="<%= workerCityNames %>"'
new_card = 'data-contract-type="<%= worker.contractType %>" data-same-day-assignment="<%= hasSameDayAssignment ? \'true\' : \'false\' %>" data-worker-cities="<%= workerCityNames %>"'
assert source.count(old_card) == 1, source.count(old_card)
source = source.replace(old_card, new_card)

dialog_anchor = '      <dialog class="rest-dialog" id="restAssignmentDialog">'
conflict_dialog = '''      <dialog class="rest-dialog" id="restConflictDialog">
        <form method="dialog" id="restConflictForm">
          <h3>Auxiliar ya asignado</h3>
          <p class="field-hint" id="restConflictMessage">Este auxiliar ya tiene una solicitud activa en la fecha mostrada.</p>
          <div class="dialog-actions"><button class="btn" type="button" id="cancelRestConflict">Cancelar</button><button class="btn btn-primary" type="button" id="confirmAssignedRest">Dar descanso</button></div>
        </form>
      </dialog>
'''
assert source.count(dialog_anchor) == 1, source.count(dialog_anchor)
source = source.replace(dialog_anchor, conflict_dialog + dialog_anchor)

worker_id_anchor = '          <input type="hidden" name="workerId" id="restWorkerId" />\n'
allow_input = '          <input type="hidden" name="allowAssignedRest" id="allowAssignedRestInput" value="false" />\n'
assert source.count(worker_id_anchor) == 1, source.count(worker_id_anchor)
source = source.replace(worker_id_anchor, worker_id_anchor + allow_input)

open_pattern = re.compile(r"      function openRestDialog\(workerIds\)\{.*?\}\n      function renderRestOriginBatchDialog\(\)\{", re.S)
open_replacement = '''      function openRestDialog(workerIds){
        const ids=[...new Set(Array.isArray(workerIds)?workerIds:[workerIds])].filter(Boolean);
        const cards=ids.map((workerId)=>qsa('.worker-card').find((item)=>item.dataset.workerId===workerId)).filter(Boolean);
        if(!cards.length){showToast('Selecciona al menos un auxiliar para descanso.');return;}
        const dialog=qs('#restAssignmentDialog');
        const workerInput=qs('#restWorkerId');
        const workerName=qs('#restWorkerName');
        const reasonInput=qs('#restReasonInput');
        const originInput=qs('#originSundayDateInput');
        const restDate=qs('#restDateValue');
        const allowAssignedRestInput=qs('#allowAssignedRestInput');
        restBatchWorkers=cards.map((card)=>({workerId:card.dataset.workerId,workerName:card.dataset.workerName||'Auxiliar',contractType:card.dataset.contractType||'DIRECTO',sameDayAssignment:card.dataset.sameDayAssignment==='true'}));
        restBatchHasDirect=cards.some((card)=>card.dataset.contractType==='DIRECTO');
        if(workerInput)workerInput.value=cards.map((card)=>card.dataset.workerId).join(',');
        if(workerName){const names=restBatchWorkers.map((worker)=>worker.workerName);workerName.textContent=names.length===1?names[0]:`${names.length} auxiliares: ${names.slice(0,3).join(', ')}${names.length>3?'…':''}`;}
        if(reasonInput)reasonInput.value='';
        if(originInput)originInput.value='';
        if(restDate)restDate.value=currentDateFilter()||todayDateInColombia();
        if(allowAssignedRestInput)allowAssignedRestInput.value='false';
        syncRestFields();
        const assignedWorkers=restBatchWorkers.filter((worker)=>worker.sameDayAssignment);
        if(assignedWorkers.length){
          const conflictMessage=qs('#restConflictMessage');
          const names=assignedWorkers.map((worker)=>worker.workerName).join(', ');
          if(conflictMessage)conflictMessage.textContent=`${names} ${assignedWorkers.length===1?'ya está asignado a una solicitud activa':'ya están asignados a solicitudes activas'} en la fecha mostrada. Si deseas continuar, pulsa “Dar descanso”; después podrás elegir la fecha y el motivo cuando corresponda.`;
          qs('#restConflictDialog')?.showModal();
          return;
        }
        dialog?.showModal();
      }
      function renderRestOriginBatchDialog(){'''
source, replaced = open_pattern.subn(open_replacement, source, count=1)
assert replaced == 1, replaced

payload_anchor = "const payload=new URLSearchParams();payload.set('workerId',worker.workerId);payload.set('restDate',qs('#restDateValue')?.value||'');const serviceRequestId=form.querySelector('input[name=\"serviceRequestId\"]')?.value;"
payload_replacement = "const payload=new URLSearchParams();payload.set('workerId',worker.workerId);payload.set('restDate',qs('#restDateValue')?.value||'');if(qs('#allowAssignedRestInput')?.value==='true')payload.set('allowAssignedRest','true');const serviceRequestId=form.querySelector('input[name=\"serviceRequestId\"]')?.value;"
assert source.count(payload_anchor) == 1, source.count(payload_anchor)
source = source.replace(payload_anchor, payload_replacement)

bind_anchor = "qs('#restSelectedWorkers')?.addEventListener('click',()=>openRestDialog(getSelectedWorkerIds()));qs('#restReasonInput')?.addEventListener('change',syncRestFields);"
bind_replacement = "qs('#restSelectedWorkers')?.addEventListener('click',()=>openRestDialog(getSelectedWorkerIds()));qs('#cancelRestConflict')?.addEventListener('click',()=>qs('#restConflictDialog')?.close());qs('#confirmAssignedRest')?.addEventListener('click',()=>{const conflictDialog=qs('#restConflictDialog');if(conflictDialog?.open)conflictDialog.close();const allowAssignedRestInput=qs('#allowAssignedRestInput');if(allowAssignedRestInput)allowAssignedRestInput.value='true';qs('#restAssignmentDialog')?.showModal();});qs('#restReasonInput')?.addEventListener('change',syncRestFields);"
assert source.count(bind_anchor) == 1, source.count(bind_anchor)
source = source.replace(bind_anchor, bind_replacement)

view_path.write_text(source, encoding='utf-8')

test_path = Path('test/dispatchWorkerRestWarningUi.test.js')
test_path.write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('un auxiliar ya asignado muestra advertencia antes del formulario de descanso', async () => {
  const view = await read('src/views/operacionesAsignacionesConfirmacion.ejs');
  assert.match(view, /data-same-day-assignment=\"<%= hasSameDayAssignment \? 'true' : 'false' %>\"/);
  assert.match(view, /id=\"restConflictDialog\"/);
  assert.match(view, /id=\"restConflictMessage\"/);
  assert.match(view, /id=\"confirmAssignedRest\">Dar descanso<\/button>/);
  assert.match(view, /name=\"allowAssignedRest\" id=\"allowAssignedRestInput\" value=\"false\"/);
  assert.match(view, /const assignedWorkers=restBatchWorkers\.filter\(\(worker\)=>worker\.sameDayAssignment\)/);
  assert.match(view, /qs\('#restConflictDialog'\)\?\.showModal\(\);\s*return;\s*}\s*dialog\?\.showModal\(\);/);
  assert.match(view, /allowAssignedRestInput\.value='true';qs\('#restAssignmentDialog'\)\?\.showModal\(\)/);
  assert.match(view, /payload\.set\('allowAssignedRest','true'\)/);
  assert.ok(view.indexOf('id=\"restConflictDialog\"') < view.indexOf('id=\"restAssignmentDialog\"'));
});

test('el motivo sigue siendo condicional al tipo de contrato', async () => {
  const view = await read('src/views/operacionesAsignacionesConfirmacion.ejs');
  assert.match(view, /if\(reasonField\)reasonField\.hidden=!direct/);
  assert.match(view, /if\(reasonInput\)\{reasonInput\.disabled=!direct;reasonInput\.required=direct/);
});
""", encoding='utf-8')
