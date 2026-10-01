import { prisma } from '../lib/prisma.js';
import {
  ensureAttendanceBillingInvoice,
  loadAttendanceBillingCounter
} from '../modules/dispatch-attendance/application/attendanceBillingCounter.js';
import {
  deliverCybionixAccountCharge,
  deliverCybionixAttendanceApproval,
  ensureCybionixAccountCharge,
  loadCybionixAccountForInvoice,
  loadCybionixApprovalState
} from '../services/cybionixBillingWorkflow.js';

const DEFAULT_POLL_MS = 60 * 1000;

function pollMs(env = process.env) {
  const raw = Number(env.ATTENDANCE_BILLING_WORKER_POLL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : DEFAULT_POLL_MS;
}

export async function runAttendanceBillingInvoiceSweep(options = {}) {
  const prismaClient = options.prismaClient || prisma;
  const now = options.now || new Date();

  // Mantiene congelada la elegibilidad del ciclo vigente aunque nadie tenga abierto el panel.
  // La hora exacta del servicio es el punto de no retorno comercial.
  await loadAttendanceBillingCounter(prismaClient, { now });

  const invoiceResult = await ensureAttendanceBillingInvoice(prismaClient, { now });
  if (!invoiceResult.invoice) {
    return { invoice: invoiceResult, approval: null, accountDelivery: null };
  }

  const invoice = invoiceResult.invoice;
  const approvalState = await loadCybionixApprovalState(prismaClient, invoice.invoiceNumber);
  let approval = null;
  let accountDelivery = null;

  if (approvalState.status === 'APPROVED') {
    let account = await loadCybionixAccountForInvoice(prismaClient, invoice.invoiceNumber);
    if (!account && approvalState.billingSnapshot) {
      const accountResult = await ensureCybionixAccountCharge(
        prismaClient,
        invoice,
        approvalState.billingSnapshot,
        { supervisorName: approvalState.supervisorName, supervisorPhone: approvalState.supervisorPhone }
      );
      account = accountResult.account;
    }
    if (account) accountDelivery = await deliverCybionixAccountCharge(prismaClient, account, options);
  } else if (approvalState.status !== 'REJECTED') {
    approval = await deliverCybionixAttendanceApproval(prismaClient, invoice, options);
  }

  return { invoice: invoiceResult, approval, accountDelivery };
}

export function startAttendanceBillingInvoiceWorker(options = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runAttendanceBillingInvoiceSweep(options);
      const interesting = result.invoice?.created
        || result.approval?.sent
        || result.accountDelivery?.sent
        || result.accountDelivery?.failed;
      if (interesting) {
        console.log('[ATTENDANCE_BILLING_INVOICE_SWEEP]', {
          created: result.invoice?.created === true,
          invoiceNumber: result.invoice?.invoice?.invoiceNumber || null,
          approvalSent: result.approval?.sent === true,
          approvalSkippedReason: result.approval?.reason || null,
          accountSent: result.accountDelivery?.sent || 0,
          accountFailed: result.accountDelivery?.failed || 0
        });
      }
    } catch (error) {
      console.error('[ATTENDANCE_BILLING_INVOICE_SWEEP_FAILED]', { code: error?.message || 'unknown' });
    } finally {
      running = false;
    }
  };

  void run();
  const interval = pollMs(options.env || process.env);
  const timer = setInterval(run, interval);
  console.log('[ATTENDANCE_BILLING_INVOICE_WORKER_STARTED]', { pollMs: interval });
  return timer;
}

if (process.argv[1] && process.argv[1].endsWith('attendanceBillingInvoiceWorker.js')) {
  startAttendanceBillingInvoiceWorker();
}
