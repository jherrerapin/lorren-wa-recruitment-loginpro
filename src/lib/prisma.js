import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;
const prismaClient = globalForPrisma.__loginproPrisma || new PrismaClient();

export const prisma = prismaClient;

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__loginproPrisma = prismaClient;
}
