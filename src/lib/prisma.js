import { PrismaClient } from '@prisma/client';
import {
  DISPATCH_TEST_GEOFENCE_BYPASS_RADIUS_SENTINEL_METERS,
  isDispatchTestGeofenceBypassEnabled
} from '../services/dispatchTestGeofenceBypass.js';

const globalForPrisma = globalThis;
const MIDDLEWARE_FLAG = Symbol.for('lorren.dispatchTestGeofenceBypassMiddleware');

const prismaClient = globalForPrisma.__loginproPrisma || new PrismaClient();

if (!globalForPrisma[MIDDLEWARE_FLAG] && typeof prismaClient.$use === 'function') {
  prismaClient.$use(async (params, next) => {
    const result = await next(params);
    const isAssignmentLookup = params.model === 'DispatchAssignment'
      && (params.action === 'findFirst' || params.action === 'findUnique');
    const operationPoint = result?.serviceRequest?.operationPoint;
    if (!isAssignmentLookup || !result?.workerId || !operationPoint?.id || !operationPoint?.clientId) {
      return result;
    }

    const client = await prismaClient.dispatchClient.findUnique({
      where: { id: operationPoint.clientId },
      select: { isTestClient: true }
    });
    if (client?.isTestClient !== true) return result;

    const worker = await prismaClient.dispatchWorker.findUnique({
      where: { id: result.workerId },
      select: { isTestProfile: true }
    });
    if (worker?.isTestProfile !== true) return result;

    const enabled = await isDispatchTestGeofenceBypassEnabled(prismaClient, {
      operationPointId: operationPoint.id,
      clientIsTest: true,
      workerIsTest: true
    });
    if (!enabled) return result;

    return {
      ...result,
      serviceRequest: {
        ...result.serviceRequest,
        operationPoint: {
          ...operationPoint,
          geofenceRadiusMeters: DISPATCH_TEST_GEOFENCE_BYPASS_RADIUS_SENTINEL_METERS,
          maxLocationAccuracyMeters: 100_000,
          testGeofenceBypassEnabled: true
        }
      }
    };
  });
  globalForPrisma[MIDDLEWARE_FLAG] = true;
}

export const prisma = prismaClient;

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__loginproPrisma = prismaClient;
}
