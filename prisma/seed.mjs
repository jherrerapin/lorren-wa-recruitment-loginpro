import { PrismaClient } from '@prisma/client';
import { DEFAULT_VACANCY_SEED } from '../src/services/vacancyCatalog.js';

const prisma = new PrismaClient();

try {
  for (const vacancy of DEFAULT_VACANCY_SEED) {
    await prisma.vacancy.upsert({
      where: { key: vacancy.key },
      update: {
        title: vacancy.title,
        city: vacancy.city,
        description: vacancy.description,
        profile: vacancy.profile,
        botIntroText: vacancy.botIntroText,
        requirementsSummary: vacancy.requirementsSummary,
        adTextHints: vacancy.adTextHints || null,
        aliases: vacancy.aliases,
        isActive: vacancy.isActive,
        displayOrder: vacancy.displayOrder
      },
      create: {
        key: vacancy.key,
        title: vacancy.title,
        city: vacancy.city,
        description: vacancy.description,
        profile: vacancy.profile,
        botIntroText: vacancy.botIntroText,
        requirementsSummary: vacancy.requirementsSummary,
        adTextHints: vacancy.adTextHints || null,
        aliases: vacancy.aliases,
        isActive: vacancy.isActive,
        displayOrder: vacancy.displayOrder
      }
    });
  }

  console.log(`Vacantes sembradas: ${DEFAULT_VACANCY_SEED.length}`);
} finally {
  await prisma.$disconnect();
}
