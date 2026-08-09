export const NAME_RESIDENCE_COLLISION_REPLAYS = Object.freeze([
  {
    id: 'conv-052-name-copied-to-neighborhood-v1',
    sourceConversation: 'CONV-052',
    title: 'El nombre y la residencia propuestos con el mismo valor no se persisten en ambos campos',
    candidate: {},
    proposedFields: {
      fullName: 'Candidato de Prueba',
      neighborhood: 'Candidato de Prueba',
      age: 29,
      transportMode: 'Bicicleta'
    },
    sourceByField: {
      fullName: 'engine',
      neighborhood: 'engine',
      age: 'local',
      transportMode: 'local'
    },
    expected: {
      persistedFields: ['fullName', 'age', 'transportMode'],
      rejectedFields: ['neighborhood'],
      neighborhood: null
    }
  },
  {
    id: 'conv-052-persisted-name-copied-to-locality-v1',
    sourceConversation: 'CONV-052',
    title: 'Una localidad idéntica al nombre ya persistido se rechaza',
    candidate: {
      fullName: 'Candidato de Prueba'
    },
    proposedFields: {
      locality: 'Candidato de Prueba'
    },
    sourceByField: {
      locality: 'engine'
    },
    expected: {
      persistedFields: [],
      rejectedFields: ['locality'],
      locality: null
    }
  },
  {
    id: 'valid-residence-remains-supported-v1',
    sourceConversation: 'CONV-052',
    title: 'Una residencia distinta del nombre continúa aceptada',
    candidate: {
      fullName: 'Candidato de Prueba'
    },
    proposedFields: {
      neighborhood: 'Aquaviva'
    },
    sourceByField: {
      neighborhood: 'local'
    },
    expected: {
      persistedFields: ['neighborhood'],
      rejectedFields: [],
      neighborhood: 'Aquaviva'
    }
  }
]);
