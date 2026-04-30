import { buildFutureSlot } from '../helpers/mockScheduler.js';

const OP_IBA = {
  id: 'op-ibague',
  name: 'Operacion Ibague',
  city: { id: 'city-ibague', name: 'Ibague' }
};

const OP_BOG = {
  id: 'op-bogota',
  name: 'Operacion Bogota',
  city: { id: 'city-bogota', name: 'Bogota' }
};

export const baseVacancies = [
  {
    id: 'vac-post',
    title: 'Auxiliar de Cargue y Descargue Ibague',
    role: 'Auxiliar de cargue y descargue',
    city: 'Ibague',
    operationId: OP_IBA.id,
    operation: OP_IBA,
    operationAddress: 'Zona industrial de Ibague',
    requirements: 'Ser mayor de edad y contar con disponibilidad de tiempo',
    conditions: 'Pago por turno y proceso de seleccion',
    roleDescription: 'Cargue, descargue y apoyo operativo',
    requiredDocuments: 'Documento de identidad',
    acceptingApplications: true,
    isActive: true,
    schedulingEnabled: false,
    updatedAt: new Date('2026-04-07T12:00:00.000Z')
  },
  {
    id: 'vac-sched',
    title: 'Mensajero Bogota',
    role: 'Mensajero',
    city: 'Bogota',
    operationId: OP_BOG.id,
    operation: OP_BOG,
    operationAddress: 'Calle 80 # 10-20',
    requirements: 'Conocimiento de direcciones y disponibilidad',
    conditions: 'Contrato por obra y proceso con entrevista',
    roleDescription: 'Mensajeria y entregas urbanas',
    requiredDocuments: 'Documento y hoja de vida',
    acceptingApplications: true,
    isActive: true,
    schedulingEnabled: true,
    updatedAt: new Date('2026-04-07T11:00:00.000Z')
  }
];

export const baseOperations = [OP_IBA, OP_BOG];

const schedulingSlots = [
  buildFutureSlot({ vacancyId: 'vac-sched', id: 'slot-1', hoursFromNow: 8 }),
  buildFutureSlot({ vacancyId: 'vac-sched', id: 'slot-2', hoursFromNow: 12 }),
  buildFutureSlot({ vacancyId: 'vac-sched', id: 'slot-3', hoursFromNow: 18 })
];

function candidateDefaults(overrides = {}) {
  return {
    id: overrides.id || 'candidate-1',
    phone: overrides.phone || '573001112233',
    status: 'NUEVO',
    currentStep: 'MENU',
    vacancyId: null,
    fullName: null,
    documentType: null,
    documentNumber: null,
    age: null,
    gender: 'UNKNOWN',
    neighborhood: null,
    locality: null,
    medicalRestrictions: null,
    transportMode: null,
    experienceInfo: null,
    experienceTime: null,
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null,
    reminderState: 'PENDING',
    reminderScheduledFor: null,
    botPaused: false,
    botPausedAt: null,
    botPauseReason: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    createdAt: new Date('2026-04-07T10:00:00.000Z'),
    ...overrides
  };
}

export const conversationCases = [
  {
    id: 'greeting-not-name',
    steps: ['hola, buenas tardes'],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    expect: {
      absentFields: ['fullName'],
      candidate: { currentStep: 'GREETING_SENT' },
      lastReplyIncludes: ['Desde que ciudad', 'vacante o cargo']
    }
  },
  {
    id: 'age-not-experience',
    steps: ['tengo 35 años'],
    candidate: candidateDefaults({ currentStep: 'GREETING_SENT', vacancyId: 'vac-post' }),
    expect: {
      candidate: { age: 35, currentStep: 'COLLECTING_DATA' },
      absentFields: ['experienceTime']
    }
  },
  {
    id: 'experience-headcount-number-does-not-trigger-age-rejection',
    steps: ['En operaciones logisticas mas de 12 años, y manejo de personal grupos mayores a 56 trabajadores por turno'],
    candidate: candidateDefaults({ currentStep: 'COLLECTING_DATA', vacancyId: 'vac-post', age: 42 }),
    expect: {
      candidate: {
        age: 42,
        experienceInfo: 'Sí',
        experienceTime: '12 años'
      },
      notStatus: 'RECHAZADO',
      lastReplyNotIncludes: ['no es posible continuar con tu postulacion', 'edad fuera del rango']
    }
  },
  {
    id: 'fragmented-data-consolidation',
    steps: ['juan perez', 'cc 1234567890', '28 años', 'barrio jordan', 'sin restricciones medicas', 'cicla'],
    candidate: candidateDefaults({ currentStep: 'GREETING_SENT', vacancyId: 'vac-post' }),
    expect: {
      candidate: {
        fullName: 'Juan Perez',
        documentType: 'CC',
        documentNumber: '1234567890',
        age: 28,
        neighborhood: 'Jordan',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Bicicleta',
        currentStep: 'ASK_CV'
      },
      lastReplyIncludes: ['hoja de vida']
    }
  },
  {
    id: 'greeting-not-name-or-neighborhood',
    steps: ['buenas tardes'],
    candidate: candidateDefaults({ currentStep: 'COLLECTING_DATA', vacancyId: 'vac-post' }),
    expect: {
      absentFields: ['fullName', 'neighborhood']
    }
  },
  {
    id: 'bike-variants-recognized',
    steps: ['mi medio de transporte es bivivleta'],
    candidate: candidateDefaults({ currentStep: 'COLLECTING_DATA', vacancyId: 'vac-post' }),
    expect: {
      candidate: { transportMode: 'Bicicleta' }
    }
  },
  {
    id: 'car-recognized',
    steps: ['tengo carro'],
    candidate: candidateDefaults({ currentStep: 'COLLECTING_DATA', vacancyId: 'vac-post' }),
    expect: {
      candidate: { transportMode: 'Carro' }
    }
  },
  {
    id: 'city-with-multiple-vacancies-asks-which-one',
    steps: ['Estoy en Ibague'],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    vacancies: [
      ...baseVacancies,
      {
        id: 'vac-iba-coord',
        title: 'Coordinador de Operaciones Ibague',
        role: 'Coordinador de operaciones',
        city: 'Ibague',
        operationId: OP_IBA.id,
        operation: OP_IBA,
        operationAddress: 'Zona aeropuerto',
        requirements: 'Experiencia liderando equipos',
        conditions: 'Salario a convenir',
        roleDescription: 'Liderazgo operativo',
        requiredDocuments: 'Documento de identidad',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: false,
        updatedAt: new Date('2026-04-07T12:30:00.000Z')
      }
    ],
    operations: [OP_IBA, OP_BOG],
    expect: {
      lastReplyIncludes: ['vacantes activas', 'Auxiliar de Cargue y Descargue Ibague', 'Coordinador de Operaciones Ibague'],
      lastReplyNotIncludes: ['enviame por favor estos datos', 'cuentame desde que ciudad']
    }
  },
  {
    id: 'city-only-does-not-auto-assign-even-with-single-active-city-vacancy',
    steps: ['Buenas noches te estoy escribiendo desde ibague me dieron este numero para vacante de trabajo'],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    expect: {
      candidate: {
        currentStep: 'GREETING_SENT',
        vacancyId: null
      },
      lastReplyIncludes: ['En Ibague tengo estas vacantes activas', 'Auxiliar de Cargue y Descargue Ibague'],
      lastReplyNotIncludes: ['Coordinador de Operaciones', 'enviame tus datos', 'te solicitare tus datos']
    }
  },
  {
    id: 'inactive-vacancy-offers-registration-for-future-openings',
    steps: ['Estoy en Ibague y me interesa coordinador de operaciones'],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    vacancies: [
      ...baseVacancies,
      {
        id: 'vac-iba-inactive',
        title: 'Coordinador de Operaciones Ibague',
        role: 'Coordinador de operaciones',
        city: 'Ibague',
        operationId: OP_IBA.id,
        operation: OP_IBA,
        operationAddress: 'Zona aeropuerto',
        requirements: 'Experiencia liderando equipos',
        conditions: 'Salario a convenir',
        roleDescription: 'Liderazgo operativo',
        requiredDocuments: 'Documento de identidad',
        acceptingApplications: false,
        isActive: true,
        schedulingEnabled: false,
        updatedAt: new Date('2026-04-07T12:45:00.000Z')
      }
    ],
    operations: [OP_IBA, OP_BOG],
    expect: {
      candidate: { vacancyId: 'vac-iba-inactive', currentStep: 'GREETING_SENT' },
      lastReplyIncludes: ['no esta activa', 'dejar tu perfil registrado'],
      lastReplyNotIncludes: ['cuentame desde que ciudad', 'enviame por favor estos datos']
    }
  },
  {
    id: 'bus-and-independent-recognized',
    steps: ['independiente - bus'],
    candidate: candidateDefaults({ currentStep: 'COLLECTING_DATA', vacancyId: 'vac-post' }),
    expect: {
      candidate: { transportMode: 'Bus' }
    }
  },
  {
    id: 'answer-question-before-data',
    steps: ['me interesa la vacante de mensajero en bogota, que horario tienen?'],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    expect: {
      candidate: { vacancyId: 'vac-sched', currentStep: 'COLLECTING_DATA' },
      lastReplyIncludes: ['condiciones registradas', 'comparteme'],
      lastReplyNotIncludes: ['Perfecto, por favor confirma']
    }
  },
  {
    id: 'no-interest-closes',
    steps: ['no me interesa'],
    candidate: candidateDefaults({ currentStep: 'COLLECTING_DATA', vacancyId: 'vac-post' }),
    expect: {
      candidate: { currentStep: 'DONE' },
      lastReplyIncludes: ['mas adelante deseas continuar'],
      lastReplyNotIncludes: ['datos', 'hoja de vida']
    }
  },
  {
    id: 'natural-correction-in-confirmation',
    steps: ['mi medio de transporte es bicicleta'],
    candidate: candidateDefaults({
      currentStep: 'CONFIRMING_DATA',
      vacancyId: 'vac-post',
      fullName: 'Juan Perez',
      documentType: 'CC',
      documentNumber: '1234567890',
      age: 28,
      neighborhood: 'Jordan',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto'
    }),
    expect: {
      candidate: { transportMode: 'Bicicleta', currentStep: 'ASK_CV' },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['confirma', 'si todo esta']
    }
  },
  {
    id: 'ibague-flow-name-correction-and-transport-list',
    steps: [
      'Hola buen dia para preguntar por la vacante de auxiliar operativo',
      'Ibague Tolima',
      'Si claro',
      'Cedula de ciudadania\n1007788013\n24 anos\nModelia\nNinguna restriccion medica\nMoto',
      'Nombre completo Jhon Edison Zuniga Parra',
      'Medio de transporte moto'
    ],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    expect: {
      candidate: {
        vacancyId: 'vac-post',
        documentType: 'CC',
        documentNumber: '1007788013',
        age: 24,
        neighborhood: 'Modelia',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Moto',
        currentStep: 'ASK_CV'
      },
      candidateNot: {
        fullName: 'Si Claro'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['todavía necesito: medio de transporte', 'medio de transporte: pendiente']
    }
  },
  {
    id: 'madrid-city-role-fragments-do-not-become-name',
    steps: [
      'Buenas noches Estoy interesado en el anuncio',
      'Madrid cundinamarca\nAuxiliar cargue y descargue'
    ],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    vacancies: [
      {
        id: 'vac-siberia',
        title: 'Auxiliar Cargue y Descargue Siberia',
        role: 'Auxiliar de cargue y descargue',
        city: 'Bogota',
        operationId: OP_BOG.id,
        operation: OP_BOG,
        operationAddress: 'Siberia',
        requirements: 'Disponibilidad de tiempo',
        conditions: 'Pagos quincenales y turnos rotativos',
        roleDescription: 'Apoyo operativo en cargue y descargue',
        requiredDocuments: 'Documento de identidad',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: true,
        updatedAt: new Date('2026-04-07T13:00:00.000Z')
      }
    ],
    operations: [OP_BOG],
    expect: {
      candidate: {
        vacancyId: 'vac-siberia'
      },
      absentFields: ['fullName', 'neighborhood'],
      lastReplyIncludes: ['Auxiliar Cargue y Descargue Siberia'],
      lastReplyNotIncludes: ['Para asociar bien tu proceso', 'Si quieres continuar, cuentame tus datos en el orden que prefieras']
    }
  },
  {
    id: 'funza-bodega-city-does-not-become-name-and-resolves-vacancy',
    steps: [
      'Buenas noches mucho gusto mi nombre es Humberto Rojas deseo informacion acerca de la vacante como auxiliar de bodega muchas gracias',
      'Te escribo desde el municipio de funza Cundinamarca y la vacante es para auxiliar de bodega me encuentro interesado'
    ],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    vacancies: [
      {
        id: 'vac-bodega-siberia',
        title: 'Auxiliar de Bodega Siberia',
        role: 'Auxiliar de bodega',
        city: 'Bogota',
        operationId: OP_BOG.id,
        operation: OP_BOG,
        operationAddress: 'Siberia',
        interviewAddress: 'Villas de Granada',
        requirements: 'Disponibilidad de tiempo y documento de identidad',
        conditions: 'Pagos quincenales y turnos rotativos',
        roleDescription: 'Apoyo de bodega y cargue en operacion Siberia',
        requiredDocuments: 'Documento de identidad',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: true,
        updatedAt: new Date('2026-04-07T13:10:00.000Z')
      }
    ],
    operations: [OP_BOG],
    expect: {
      candidate: {
        vacancyId: 'vac-bodega-siberia'
      },
      candidateNot: {
        fullName: 'Funza Cundinamarca'
      },
      lastReplyIncludes: ['Auxiliar de Bodega Siberia', 'Siberia'],
      lastReplyNotIncludes: ['Desde que ciudad nos escribes y para que vacante o cargo']
    }
  },
  {
    id: 'bodega-data-block-keeps-name-doc-and-transport',
    steps: [
      'Nombre: Humberto Rojas Moreno\nC. C. 1018427065 de Bogota\nBicicleta\nNo cuento con restriccion medica'
    ],
    candidate: candidateDefaults({
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-bodega-siberia'
    }),
    vacancies: [
      {
        id: 'vac-bodega-siberia',
        title: 'Auxiliar de Bodega Siberia',
        role: 'Auxiliar de bodega',
        city: 'Bogota',
        operationId: OP_BOG.id,
        operation: OP_BOG,
        operationAddress: 'Siberia',
        requirements: 'Disponibilidad de tiempo y documento de identidad',
        conditions: 'Pagos quincenales y turnos rotativos',
        roleDescription: 'Apoyo de bodega y cargue en operacion Siberia',
        requiredDocuments: 'Documento de identidad',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: true,
        updatedAt: new Date('2026-04-07T13:10:00.000Z')
      }
    ],
    operations: [OP_BOG],
    expect: {
      candidate: {
        fullName: 'Humberto Rojas Moreno',
        documentType: 'CC',
        documentNumber: '1018427065',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Bicicleta',
        currentStep: 'COLLECTING_DATA'
      },
      lastReplyIncludes: ['edad', 'barrio'],
      lastReplyNotIncludes: ['Nombre completo: Pendiente', 'Medio de transporte: Pendiente', 'restricciones médicas: pendiente']
    }
  },
  {
    id: 'single-missing-medical-restrictions-accepts-natural-no',
    steps: ['No tengo ninguna'],
    candidate: candidateDefaults({
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post',
      fullName: 'Johan Andrade',
      documentType: 'CC',
      documentNumber: '1234567890',
      age: 28,
      neighborhood: 'Las Americas',
      transportMode: 'Bicicleta'
    }),
    expect: {
      candidate: {
        medicalRestrictions: 'Sin restricciones médicas',
        currentStep: 'ASK_CV'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['Para continuar necesito: restricciones medicas', 'mas adelante deseas continuar']
    }
  },
  {
    id: 'medical-restrictions-confusion-gets-clear-explanation',
    steps: ['No entiendo que tendria que poner en restricciones medicas'],
    candidate: candidateDefaults({
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post',
      fullName: 'Sergio Guzman',
      documentType: 'CC',
      documentNumber: '1030281023',
      age: 18,
      neighborhood: 'Santa Rita',
      transportMode: 'Moto'
    }),
    expect: {
      candidate: { currentStep: 'COLLECTING_DATA' },
      lastReplyIncludes: ['Si no tienes ninguna restriccion medica', 'no tengo restricciones'],
      lastReplyNotIncludes: ['Para continuar necesito: restricciones medicas']
    }
  },
  {
    id: 'future-birthday-keeps-current-age-and-does-not-repeat-transport',
    steps: [
      'Johan Sebastian Carrillo Aldana, 18 años el otro mes cumplo 19, restricciones medicas ninguna,medio de transporte cicla'
    ],
    candidate: candidateDefaults({
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-siberia',
      fullName: 'Johan Sebastian Carrillo Aldana',
      documentType: 'CC',
      documentNumber: '1073506772',
      neighborhood: 'Mosquera',
      transportMode: 'Bicicleta',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'hv.pdf',
      cvMimeType: 'application/pdf'
    }),
    vacancies: [
      {
        id: 'vac-siberia',
        title: 'Auxiliar Cargue y Descargue Siberia',
        role: 'Auxiliar de cargue y descargue',
        city: 'Bogota',
        operationId: OP_BOG.id,
        operation: OP_BOG,
        operationAddress: 'Siberia',
        requirements: 'Disponibilidad de tiempo',
        conditions: 'Pagos quincenales y turnos rotativos',
        roleDescription: 'Apoyo operativo en cargue y descargue',
        requiredDocuments: 'Documento de identidad',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: true,
        updatedAt: new Date('2026-04-07T13:00:00.000Z')
      }
    ],
    operations: [OP_BOG],
    interviewSlots: [
      buildFutureSlot({ vacancyId: 'vac-siberia', id: 'slot-bodega-1', hoursFromNow: 8 })
    ],
    expect: {
      candidate: {
        age: 18,
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Bicicleta',
        currentStep: 'SCHEDULING'
      },
      lastReplyIncludes: ['te puedo ofrecer'],
      lastReplyNotIncludes: ['Restricciones médicas: Pendiente', 'Medio de transporte: Pendiente']
    }
  },
  {
    id: 'ibague-greeting-interest-does-not-become-name-and-name-correction-advances',
    steps: [
      'Buenas noches\n\nEstoy interesado en la vacante de carge y descarge en la ciudad de ibague vivo en el salado',
      'Tengo transporte propio moto',
      'Cc 1110177550\nEdad 32\nNinguna restriccion medica',
      'Yilber antonio gonzalez ospina'
    ],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    expect: {
      candidate: {
        vacancyId: 'vac-post',
        fullName: 'Yilber Antonio Gonzalez Ospina',
        documentType: 'CC',
        documentNumber: '1110177550',
        age: 32,
        neighborhood: 'Salado',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Moto',
        currentStep: 'ASK_CV'
      },
      candidateNot: {
        fullName: 'Buenas Noches'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['Nombre completo: Buenas Noches', 'Medio de transporte: Pendiente']
    }
  },
  {
    id: 'ibague-pdf-phrase-does-not-become-name-or-reopen-confirmation',
    steps: [
      'Buenas noches\n\nEstoy interesado en la vacante de carge y descarge en la ciudad de ibague vivo en el salado',
      'Tengo transporte propio moto',
      'Si desea le envio la hoja de vida',
      'Por pdf',
      'Cc 1110177550\nEdad 32\nNinguna restriccion medica',
      'Yilber antonio gonzalez ospina',
      'Si'
    ],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    expect: {
      candidate: {
        vacancyId: 'vac-post',
        fullName: 'Yilber Antonio Gonzalez Ospina',
        documentType: 'CC',
        documentNumber: '1110177550',
        age: 32,
        neighborhood: 'Salado',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Moto',
        currentStep: 'ASK_CV'
      },
      candidateNot: {
        fullName: 'Por Pdf'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['Nombre completo: Por Pdf', 'Perfecto, por favor confirma estos datos']
    }
  },
  {
    id: 'ibague-role-phrase-does-not-become-name-and-name-correction-sticks',
    steps: [
      'Buenas noches',
      'Para informacion de la vacante',
      'Buenas noches',
      'De Ibague',
      'Para el cargo de auxiliar de cargue y descargue',
      'Cedula\n1082129284\n30 anos\nMoto\nSin restriccion medica',
      'Nombre Luis Eduardo Rodriguez Villalba',
      'Barrio picalena'
    ],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    expect: {
      candidate: {
        vacancyId: 'vac-post',
        fullName: 'Luis Eduardo Rodriguez Villalba',
        documentType: 'CC',
        documentNumber: '1082129284',
        age: 30,
        neighborhood: 'Picalena',
        medicalRestrictions: 'Sin restricciones médicas',
        transportMode: 'Moto',
        currentStep: 'ASK_CV'
      },
      candidateNot: {
        fullName: 'Para El'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['Nombre completo: Para El', 'Restricciones médicas: Pendiente', 'Medio de transporte: Pendiente']
    }
  },
  {
    id: 'bogota-calle-80-does-not-become-age-or-trigger-rejection',
    steps: [
      'Auxiliar de cargue y descargue',
      'Desde Bogota calle 80'
    ],
    candidate: candidateDefaults({ currentStep: 'MENU' }),
    vacancies: [
      {
        id: 'vac-bog-cargue',
        title: 'Auxiliar Cargue y Descargue Siberia',
        role: 'Auxiliar de cargue y descargue',
        city: 'Bogota',
        operationId: OP_BOG.id,
        operation: OP_BOG,
        operationAddress: 'Siberia',
        requirements: 'Disponibilidad de tiempo',
        conditions: 'Pagos quincenales y turnos rotativos',
        roleDescription: 'Apoyo operativo en cargue y descargue',
        requiredDocuments: 'Documento de identidad',
        acceptingApplications: true,
        isActive: true,
        schedulingEnabled: true,
        updatedAt: new Date('2026-04-07T13:20:00.000Z')
      }
    ],
    operations: [OP_BOG],
    expect: {
      candidate: {
        vacancyId: 'vac-bog-cargue'
      },
      absentFields: ['age'],
      notStatus: 'RECHAZADO',
      lastReplyNotIncludes: ['no es posible continuar con tu postulacion', 'edad fuera del rango']
    }
  },
  {
    id: 'human-intervention-pauses-bot',
    steps: ['si me interesa'],
    preMessages: [
      { direction: 'OUTBOUND', body: 'Hola, te escribe un humano del equipo.', rawPayload: {}, createdAt: new Date('2026-04-07T09:59:00.000Z') }
    ],
    candidate: candidateDefaults({ currentStep: 'GREETING_SENT', vacancyId: 'vac-post' }),
    expect: {
      candidate: { botPaused: true },
      exactOutboundCount: 0
    }
  },
  {
    id: 'cv-first-then-city-vacancy',
    steps: ['soy de ibague y me interesa auxiliar de cargue y descargue'],
    candidate: candidateDefaults({
      currentStep: 'GREETING_SENT',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'hv.pdf',
      cvMimeType: 'application/pdf'
    }),
    expect: {
      candidate: { vacancyId: 'vac-post' },
      lastReplyIncludes: ['Auxiliar de Cargue', 'Ibague']
    }
  },
  {
    id: 'foreigner-with-ppt-not-rejected',
    steps: ['soy venezolano y tengo permiso ppt, tengo bus'],
    candidate: candidateDefaults({ currentStep: 'COLLECTING_DATA', vacancyId: 'vac-post' }),
    expect: {
      candidate: { transportMode: 'Bus' },
      notStatus: 'RECHAZADO'
    }
  },
  {
    id: 'yes-please-not-name',
    steps: ['si por favor'],
    candidate: candidateDefaults({ currentStep: 'GREETING_SENT', vacancyId: 'vac-post' }),
    expect: {
      absentFields: ['fullName']
    }
  },
  {
    id: 'no-multiple-templates-mixed',
    steps: ['que requisitos tiene la vacante? si me interesa'],
    candidate: candidateDefaults({ currentStep: 'GREETING_SENT', vacancyId: 'vac-post' }),
    expect: {
      lastReplyIncludes: ['requisitos registrados'],
      lastReplyNotIncludes: ['Perfecto, por favor confirma', '\n\n']
    }
  },
  {
    id: 'no-infinite-confirmation',
    steps: ['si', 'si'],
    candidate: candidateDefaults({
      currentStep: 'CONFIRMING_DATA',
      vacancyId: 'vac-post',
      fullName: 'Juan Perez',
      documentType: 'CC',
      documentNumber: '1234567890',
      age: 28,
      neighborhood: 'Jordan',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto'
    }),
    expect: {
      candidate: { currentStep: 'ASK_CV' },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['confirma tus datos', 'si todo esta correcto']
    }
  },
  {
    id: 'female-pipeline-after-cv',
    steps: ['si'],
    candidate: candidateDefaults({
      currentStep: 'CONFIRMING_DATA',
      vacancyId: 'vac-post',
      fullName: 'Maria Perez',
      gender: 'FEMALE',
      documentType: 'CC',
      documentNumber: '1234567890',
      age: 27,
      neighborhood: 'Jordan',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Bicicleta',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'hv.pdf',
      cvMimeType: 'application/pdf'
    }),
    expect: {
      candidate: { currentStep: 'DONE', botPaused: true, status: 'REGISTRADO' },
      lastReplyIncludes: ['hoja de vida registradas', 'equipo revisara']
    }
  },
  {
    id: 'scheduling-offer-reschedule-confirm',
    steps: ['listo', 'no puedo, otro horario', 'ese horario me sirve'],
    candidate: candidateDefaults({
      currentStep: 'ASK_CV',
      vacancyId: 'vac-sched',
      fullName: 'Carlos Perez',
      gender: 'MALE',
      documentType: 'CC',
      documentNumber: '555444333',
      age: 29,
      neighborhood: 'Suba',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'hv.pdf',
      cvMimeType: 'application/pdf',
      lastInboundAt: new Date()
    }),
    interviewSlots: schedulingSlots,
    expect: {
      candidate: { currentStep: 'SCHEDULED' },
      bookingCount: 1,
      lastReplyIncludes: ['entrevista', 'recordarte']
    }
  },
  {
    id: 'document-exception-pauses-for-manual-review',
    steps: ['Perdi la cedula original y solo tengo la cedula digital'],
    candidate: candidateDefaults({
      currentStep: 'SCHEDULED',
      vacancyId: 'vac-sched',
      fullName: 'Humberto Rojas',
      gender: 'MALE',
      documentType: 'CC',
      documentNumber: '1018427065',
      age: 36,
      locality: 'Funza',
      medicalRestrictions: 'Sin restricciones medicas',
      transportMode: 'Bicicleta',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'hv.pdf',
      cvMimeType: 'application/pdf',
      lastInboundAt: new Date()
    }),
    interviewSlots: schedulingSlots,
    expect: {
      candidate: {
        currentStep: 'SCHEDULED',
        botPaused: true,
        botPauseReason: 'Consulta documental pendiente de validacion manual'
      },
      lastReplyIncludes: ['validar ese caso documental', 'respuesta segura']
    }
  },
  {
    id: 'done-step-followup-about-previous-application-gets-status-ack',
    steps: ['Yo me había postulado para un empleo con ustedes quisiera saber que ha pasado'],
    candidate: candidateDefaults({
      currentStep: 'DONE',
      vacancyId: 'vac-post',
      status: 'REGISTRADO',
      fullName: 'Sergio Andres Cortes Osorio',
      documentType: 'CC',
      documentNumber: '1075662931',
      age: 35,
      neighborhood: 'Nueva Castilla',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Bus',
      experienceInfo: 'Sí',
      experienceTime: '5 años',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'sergio-hv.pdf',
      cvMimeType: 'application/pdf',
      lastInboundAt: new Date()
    }),
    expect: {
      candidate: { currentStep: 'DONE', status: 'REGISTRADO' },
      lastReplyIncludes: ['postulación ya está registrada', 'te contactaremos por este medio'],
      lastReplyNotIncludes: ['dejo tu perfil registrado', 'puedo tomar tus datos y tu hoja de vida']
    }
  },
  {
    id: 'done-step-answers-vacancy-question-naturally',
    steps: ['cual es el salario para esa vacante?'],
    candidate: candidateDefaults({
      currentStep: 'DONE',
      vacancyId: 'vac-post',
      fullName: 'Kevin Zapata',
      documentType: 'CC',
      documentNumber: '1110461482',
      age: 20,
      neighborhood: 'Palermo',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'hv.pdf',
      cvMimeType: 'application/pdf',
      lastInboundAt: new Date()
    }),
    expect: {
      candidate: { currentStep: 'DONE', botPaused: false },
      lastReplyIncludes: ['condiciones registradas', 'Pago por turno'],
      lastReplyNotIncludes: ['ya quedo tu registro completo']
    }
  },
  {
    id: 'ask-cv-out-of-scope-question-pauses-for-dev-review',
    steps: ['mi esposa tambien puede entrar conmigo a la operacion?'],
    candidate: candidateDefaults({
      currentStep: 'ASK_CV',
      vacancyId: 'vac-post',
      fullName: 'Jose Barrero',
      documentType: 'CC',
      documentNumber: '1007659598',
      age: 25,
      neighborhood: 'Jordan',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto',
      lastInboundAt: new Date()
    }),
    expect: {
      candidate: {
        currentStep: 'ASK_CV',
        botPaused: true,
        botPauseReason: 'Duda posterior requiere intervencion manual'
      },
      lastReplyIncludes: ['seguimiento humano', 'respuesta segura'],
      lastReplyNotIncludes: ['hoja de vida', 'enviame por favor estos datos']
    }
  },
  {
    id: 'scheduled-question-uses-context-instead-of-repeating-flow',
    steps: ['cual es la direccion exacta de la entrevista?'],
    candidate: candidateDefaults({
      currentStep: 'SCHEDULED',
      vacancyId: 'vac-sched',
      fullName: 'Carlos Perez',
      gender: 'MALE',
      documentType: 'CC',
      documentNumber: '555444333',
      age: 29,
      locality: 'Funza',
      medicalRestrictions: 'Sin restricciones medicas',
      transportMode: 'Bicicleta',
      cvData: Buffer.from('pdf'),
      cvOriginalName: 'hv.pdf',
      cvMimeType: 'application/pdf',
      lastInboundAt: new Date()
    }),
    interviewSlots: schedulingSlots,
    expect: {
      candidate: { botPaused: false },
      lastReplyIncludes: ['direccion de entrevista', 'Calle 80 # 10-20'],
      lastReplyNotIncludes: ['enviame tus datos', 'hoja de vida']
    }
  }
];
