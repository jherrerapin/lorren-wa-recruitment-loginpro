function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return value;
}

function compareValues(a, b, direction = 'asc') {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (left === right) return 0;
  if (direction === 'desc') return left > right ? -1 : 1;
  return left > right ? 1 : -1;
}

function getValue(row, key) {
  return row?.[key];
}

function matchesCondition(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
    if (Object.hasOwn(condition, 'in')) {
      return condition.in.includes(value);
    }
    if (Object.hasOwn(condition, 'not')) {
      return !matchesCondition(value, condition.not);
    }

    const hasDateRange = ['lt', 'lte', 'gt', 'gte'].some((operator) => Object.hasOwn(condition, operator));
    if (hasDateRange) {
      const normalizedValue = normalizeDate(value);
      const valueTime = normalizedValue instanceof Date ? normalizedValue.getTime() : Number.NaN;
      if (Number.isNaN(valueTime)) return false;
      if (Object.hasOwn(condition, 'lt') && valueTime >= normalizeDate(condition.lt).getTime()) return false;
      if (Object.hasOwn(condition, 'lte') && valueTime > normalizeDate(condition.lte).getTime()) return false;
      if (Object.hasOwn(condition, 'gt') && valueTime <= normalizeDate(condition.gt).getTime()) return false;
      if (Object.hasOwn(condition, 'gte') && valueTime < normalizeDate(condition.gte).getTime()) return false;
      return true;
    }
  }

  if (value instanceof Date || condition instanceof Date) {
    if (value == null || condition == null) return value === condition;
    return normalizeDate(value).getTime() === normalizeDate(condition).getTime();
  }

  return value === condition;
}

function matchesWhere(row, where = {}) {
  return Object.entries(where || {}).every(([key, condition]) => {
    if (key === 'AND') return condition.every((item) => matchesWhere(row, item));
    if (key === 'OR') return condition.some((item) => matchesWhere(row, item));
    return matchesCondition(getValue(row, key), condition);
  });
}

function applySelect(row, select) {
  if (!select) return clone(row);
  const result = {};
  for (const [key, value] of Object.entries(select)) {
    if (!value) continue;
    result[key] = clone(row?.[key]);
  }
  return result;
}

function sortRows(rows, orderBy) {
  if (!orderBy) return [...rows];
  const orderList = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const rule of orderList) {
      const [field, direction] = Object.entries(rule)[0];
      const diff = compareValues(getValue(a, field), getValue(b, field), direction);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

function applyUpdate(row, data = {}) {
  const updated = row;
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Uint8Array) && !(Buffer.isBuffer(value))) {
      if (Object.hasOwn(value, 'increment')) {
        updated[key] = (updated[key] || 0) + value.increment;
        continue;
      }
    }
    updated[key] = value;
  }
  return updated;
}

function findOperation(state, operationId) {
  return state.operations.find((operation) => operation.id === operationId) || null;
}

function enrichVacancy(state, vacancy) {
  const operation = vacancy.operation || findOperation(state, vacancy.operationId) || null;
  const result = clone(vacancy);
  if (operation) result.operation = clone(operation);
  return result;
}

export function createMockPrisma(initialState = {}) {
  const state = {

candidates: clone(initialState.candidates || []).map((candidate) => ({
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: null,
  reminderScheduledFor: null,
  reminderState: 'NONE',
  lastOutboundAt: null,
  ...candidate
})),
    messages: clone(initialState.messages || []),
    vacancies: clone(initialState.vacancies || []),
    interviewSlots: clone(initialState.interviewSlots || []),
    interviewBookings: clone(initialState.interviewBookings || []),
    operations: clone(initialState.operations || []),
    botKnowledge: clone(initialState.botKnowledge || [])
  };

  let messageSequence = state.messages.length;

  const candidateApi = {
    async findUnique({ where, select } = {}) {
      const candidate = state.candidates.find((item) => item.id === where?.id || item.phone === where?.phone) || null;
      if (!candidate) return null;
      return applySelect(candidate, select);
    },
    async update({ where, data } = {}) {
      const candidate = state.candidates.find((item) => item.id === where?.id);
      if (!candidate) throw new Error(`Candidate ${where?.id} not found`);
      applyUpdate(candidate, data);
      return clone(candidate);
    },
    async findMany({ where, orderBy, take } = {}) {
      let rows = state.candidates.filter((candidate) => matchesWhere(candidate, where));
      rows = sortRows(rows, orderBy);
      if (take) rows = rows.slice(0, take);
      return clone(rows);
    },
    async upsert({ where, update, create } = {}) {
      const existing = state.candidates.find((item) => item.phone === where?.phone);
      if (existing) {
        applyUpdate(existing, update);
        return clone(existing);
      }
      const row = {
        id: create.id || `candidate-${state.candidates.length + 1}`,
        status: 'NUEVO',
        currentStep: 'MENU',
        reminderState: 'PENDING',
        reminderScheduledFor: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        botPaused: false,
        botPausedAt: null,
        botPauseReason: null,
        ...create
      };
      state.candidates.push(row);
      return clone(row);
    },
    async updateMany({ where, data } = {}) {
      const rows = state.candidates.filter((candidate) => matchesWhere(candidate, where));
      rows.forEach((candidate) => applyUpdate(candidate, data));
      return { count: rows.length };
    }
  };

  const messageApi = {
    async findFirst({ where, orderBy, select } = {}) {
      let rows = state.messages.filter((message) => matchesWhere(message, where));
      rows = sortRows(rows, orderBy);
      const first = rows[0] || null;
      if (!first) return null;
      return applySelect(first, select);
    },
    async findMany({ where, orderBy, take, select } = {}) {
      let rows = state.messages.filter((message) => matchesWhere(message, where));
      rows = sortRows(rows, orderBy);
      if (take) rows = rows.slice(0, take);
      return rows.map((message) => applySelect(message, select));
    },
    async create({ data } = {}) {
      const row = {
        id: data.id || `message-${++messageSequence}`,
        createdAt: data.createdAt || new Date(),
        respondedAt: data.respondedAt ?? null,
        ...data
      };
      state.messages.push(row);
      return clone(row);
    },
    async createMany({ data = [], skipDuplicates = false } = {}) {
      let count = 0;
      for (const item of data) {
        if (skipDuplicates && item.waMessageId && state.messages.some((message) => message.waMessageId === item.waMessageId)) {
          continue;
        }
        const row = {
          id: item.id || `message-${++messageSequence}`,
          createdAt: item.createdAt || new Date(),
          respondedAt: item.respondedAt ?? null,
          ...item
        };
        state.messages.push(row);
        count += 1;
      }
      return { count };
    },
    async updateMany({ where, data } = {}) {
      const rows = state.messages.filter((message) => matchesWhere(message, where));
      rows.forEach((message) => applyUpdate(message, data));
      return { count: rows.length };
    },
    async findUnique({ where, select } = {}) {
      const row = state.messages.find((message) => (
        (where?.id != null && message.id === where.id)
        || (where?.waMessageId != null && message.waMessageId === where.waMessageId)
      )) || null;
      if (!row) return null;
      return applySelect(row, select);
    },
    async update({ where, data } = {}) {
      const row = state.messages.find((message) => message.id === where?.id);
      if (!row) throw new Error(`Message ${where?.id} not found`);
      applyUpdate(row, data);
      return clone(row);
    }
  };

  const vacancyApi = {
    async findUnique({ where, include, select } = {}) {
      const vacancy = state.vacancies.find((item) => item.id === where?.id) || null;
      if (!vacancy) return null;
      const enriched = include ? enrichVacancy(state, vacancy) : vacancy;
      return select ? applySelect(enriched, select) : clone(enriched);
    },
    async findMany({ where, include, orderBy } = {}) {
      let rows = state.vacancies.filter((vacancy) => matchesWhere(vacancy, where));
      rows = sortRows(rows, orderBy);
      return rows.map((vacancy) => (include ? enrichVacancy(state, vacancy) : clone(vacancy)));
    }
  };

  const bookingApi = {
    async findFirst({ where, orderBy, select } = {}) {
      let rows = state.interviewBookings.filter((booking) => matchesWhere(booking, where));
      rows = sortRows(rows, orderBy);
      const first = rows[0] || null;
      if (!first) return null;
      return select ? applySelect(first, select) : clone(first);
    },
    async findMany({ where, orderBy, take, select } = {}) {
      let rows = state.interviewBookings.filter((booking) => matchesWhere(booking, where));
      rows = sortRows(rows, orderBy);
      if (take) rows = rows.slice(0, take);
      return rows.map((row) => (select ? applySelect(row, select) : clone(row)));
    },
    async create({ data } = {}) {
      const booking = {
        id: data.id || `booking-${state.interviewBookings.length + 1}`,
        status: 'SCHEDULED',
        createdAt: new Date(),
        ...data
      };
      state.interviewBookings.push(booking);
      return clone(booking);
    },
    async update({ where, data } = {}) {
      const row = state.interviewBookings.find((booking) => booking.id === where?.id);
      if (!row) throw new Error(`Booking ${where?.id} not found`);
      applyUpdate(row, data);
      return clone(row);
    },
    async updateMany({ where, data } = {}) {
      const rows = state.interviewBookings.filter((booking) => matchesWhere(booking, where));
      rows.forEach((booking) => applyUpdate(booking, data));
      return { count: rows.length };
    }
  };

  const slotApi = {
    async findMany({ where, include } = {}) {
      let rows = state.interviewSlots.filter((slot) => matchesWhere(slot, where));
      rows = rows.map((slot) => {
        const row = clone(slot);
        if (include?.bookings) {
          const bookingWhere = include.bookings.where || {};
          row.bookings = state.interviewBookings
            .filter((booking) => booking.slotId === slot.id)
            .filter((booking) => matchesWhere(booking, bookingWhere))
            .map((booking) => applySelect(booking, include.bookings.select));
        }
        return row;
      });
      return rows;
    }
  };


  const botKnowledgeApi = {
    async create({ data } = {}) {
      const row = {
        id: data.id || `knowledge-${state.botKnowledge.length + 1}`,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data
      };
      state.botKnowledge.push(row);
      return clone(row);
    },
    async findMany({ where, orderBy, take, select } = {}) {
      let rows = state.botKnowledge.filter((item) => matchesWhere(item, where));
      rows = sortRows(rows, orderBy);
      if (take) rows = rows.slice(0, take);
      return rows.map((row) => applySelect(row, select));
    }
  };

  const prisma = {
    state,
    candidate: candidateApi,
    message: messageApi,
    vacancy: vacancyApi,
    interviewBooking: bookingApi,
    interviewSlot: slotApi,
    botKnowledge: botKnowledgeApi
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return prisma;
}
