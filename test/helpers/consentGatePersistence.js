import { matches } from './consentGateHarness.js';

// Upgrade legacy scenario spies to the durable inbox/outbox contract. Preserve
// their writes/fault injection while emulating reads, JSON CAS and transactions.
const adapted = new WeakSet();
export function withConsentGatePersistence(prisma) {
  if (adapted.has(prisma)) return prisma;
  adapted.add(prisma);
  const original = { ...prisma.message };
  const rows = new Map();
  let sequence = 0;
  const copy = (v) => structuredClone(v);
  const remember = (row) => {
    if (row?.id && !rows.has(row.id)) rows.set(row.id, copy(row));
    return row;
  };
  prisma.message = {
    ...original,
    async createMany(args) {
      const result = await original.createMany(args);
      if (result.count) {
        for (const data of args.data) {
          const existing = original.findFirst ? await original.findFirst({ where: {
            candidateId: data.candidateId, waMessageId: data.waMessageId, direction: 'INBOUND'
          } }) : null;
          remember({ id: existing?.id || `TEST-LEGACY-INBOUND-${++sequence}`, createdAt: new Date(), ...copy(data) });
        }
      }
      return result;
    },
    async create(args) {
      const result = await original.create(args);
      const row = { createdAt: new Date(), ...copy(args.data), ...copy(result) };
      if (rows.has(row.id)) row.id = `${row.id}-${++sequence}`;
      remember(row); return copy(row);
    },
    async findFirst(args) {
      const local = [...rows.values()].find((r) => matches(r, args.where));
      if (local) return copy(local);
      return remember(await original.findFirst?.(args)) || null;
    },
    async findUnique(args) {
      const row = rows.get(args.where.id);
      return copy(row || remember(await original.findUnique?.(args)) || null);
    },
    async findMany(args = {}) {
      const legacy = await original.findMany?.(args) || [];
      legacy.forEach(remember);
      let found = [...rows.values()].filter((r) => matches(r, args.where));
      if (args.orderBy?.createdAt === 'desc') found = found.reverse();
      return copy(found.slice(0, args.take || found.length));
    },
    async updateMany(args) {
      const found = [...rows.values()].filter((r) => matches(r, args.where));
      if (!found.length) return { count: 0 };
      if (original.updateMany) await original.updateMany(args);
      found.forEach((r) => Object.assign(r, copy(args.data)));
      return { count: found.length };
    },
    async update(args) {
      const row = rows.get(args.where.id);
      if (!row) throw new Error('TEST-legacy-message-not-found');
      if (original.update) await original.update(args);
      Object.assign(row, copy(args.data)); return copy(row);
    }
  };
  if (!prisma.$transaction) {
    let tail = Promise.resolve();
    prisma.$transaction = (fn) => {
      const run = () => { const { $transaction, ...tx } = prisma; return fn(tx); };
      const current = tail.then(run, run); tail = current.catch(() => {}); return current;
    };
  }
  return prisma;
}
