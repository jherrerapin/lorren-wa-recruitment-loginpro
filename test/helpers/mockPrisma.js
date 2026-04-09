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
    if (Object.hasOwn(condition, 'lte')) {
      return normalizeDate(value).getTime() <= normalizeDate(condition.lte).getTime();
    }
    if (Object.hasOwn(condition, 'gte')) {
      return normalizeDate(value).getTime() >= normalizeDate(condition.gte).getTime();
    }
  }

  if (value instanceof Date || condition instanceof Date) {
    const left = normalizeDate(value);
    const right = normalizeDate(condition);
    if (left instanceof Date && right instanceof Date && !Number.isNaN(left.getTime()) && !Number.isNaN(right.getTime())) {
      return left.getTime() === right.getTime();
    }
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
    candidates: clone(initialState.candidates || []),
    messages: clone(initialState.messages || []),
    vacancies: clone(initialState.vacancies || []),
    interviewSlots: clone(initialState.interviewSlots || []),
    interviewBookings: clone(initialState.interviewBookings || []),
    operations: clone(initialState.operations || [])
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
    async updateMany({ where, data } = {}) {
      const rows = state.messages.filter((message) => matchesWhere(message, where));
      rows.forEach((message) => applyUpdate(message, data));
      return { count: rows.length };
    },
    async findUnique({ where, select } = {}) {
      const row = state.messages.find((message) => message.id === where?.id || message.waMessageId === where?.waMessageId) || null;
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

  return {
    state,
    candidate: candidateApi,
    message: messageApi,
    vacancy: vacancyApi,
    interviewBooking: bookingApi,
    interviewSlot: slotApi
  };
}
