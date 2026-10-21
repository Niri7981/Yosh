import { smallJson } from '@/modules/http/local-request';
import { AddWalletSchema } from '@/modules/app-wallet/wallet-library';
import { appRuntime } from '@/modules/app/app-runtime';
import { managementRoute } from '@/modules/app/management-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return managementRoute(request, false, async () => Response.json({ wallets: await appRuntime().existingWallets(), library: appRuntime().walletLibrary(), executionMode: appRuntime().execution().mode }));
}

export async function POST(request: Request) {
  return managementRoute(request, true, async request => {
    const input = AddWalletSchema.parse(await smallJson(request));
    return Response.json(await appRuntime().addLibraryWallet(input), { status: 201 });
  });
}
