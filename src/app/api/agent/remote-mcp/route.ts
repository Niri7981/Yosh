import { appRuntime } from '../../../../modules/app/app-runtime';
import { handleRemoteReadMcp } from '../../../../modules/remote/mcp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) { return handleRemoteReadMcp(appRuntime, request); }
