import { appRuntime } from '../../../../modules/app/app-runtime';
import { handleRemoteReadPairings } from '../../../../modules/remote/management';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return handleRemoteReadPairings(appRuntime, request); }
export function POST(request: Request) { return handleRemoteReadPairings(appRuntime, request); }
