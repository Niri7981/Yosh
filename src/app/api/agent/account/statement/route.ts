import { appRuntime } from '@/modules/app/app-runtime';
import { handleAccountRead } from '@/modules/mcp/account-read-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleAccountRead(appRuntime(), 'statement', request); }
