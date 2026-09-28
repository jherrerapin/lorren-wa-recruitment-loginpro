/**
 * Compatibility boundary for tests being migrated from the old consent
 * middleware. Persistence simulation no longer belongs in functional replays.
 */
export function withConsentGatePersistence(prisma) {
  return prisma;
}

export default withConsentGatePersistence;
