import { z } from 'zod';
import { PurchaseRequestInputSchema } from '../purchases/purchase-request-input';

/** No amount, destination, identity or adapter override is accepted from a remote caller. */
export const remotePurchaseLookup = z.object({ requestId: PurchaseRequestInputSchema.shape.requestId }).strict();
export const remotePurchaseInput = remotePurchaseLookup.extend({ resourceId: z.literal('market-snapshot') });
