import { describe, expect, it, vi } from "vitest";
import { DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_GENESIS, MAINNET_NETWORK,
  MAINNET_USDC_MINT, loadPaymentConfig, TOKEN_PROGRAM } from "../../src/modules/payment/payment-config";
import { classifyPaymentPreflightError, getStandardTokenAccount, runPaymentPreflight } from "../../src/modules/payment/payment-preflight";

const BUYER = "11111111111111111111111111111111";
const MERCHANT = TOKEN_PROGRAM;
const FEE_PAYER = DEVNET_USDC_MINT;
const env = { DEMO_BUYER_PUBLIC_KEY: BUYER, DEMO_MERCHANT_PUBLIC_KEY: MERCHANT };

function fixture() {
  const tokenAccount = (owner: string, amount: string) => ({
    owner: TOKEN_PROGRAM,
    data: { parsed: { type: "account", info: {
      owner, mint: DEVNET_USDC_MINT, state: "initialized", tokenAmount: { amount, decimals: 6 },
    } } },
  });
  const mint = { owner: TOKEN_PROGRAM, data: { parsed: { type: "mint", info: { decimals: 6, isInitialized: true } } } };
  const buyer = tokenAccount(BUYER, "10000");
  const merchant = tokenAccount(MERCHANT, "0");
  const state = {
    genesis: DEVNET_GENESIS,
    kinds: [{ x402Version: 2, scheme: "exact", network: DEVNET_NETWORK, extra: { feePayer: FEE_PAYER } }],
    accounts: [mint, buyer, merchant] as unknown[], feeLamports: 100_000,
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/supported")) return Response.json({ kinds: state.kinds });
    const request = JSON.parse(String(init?.body));
    const results: Record<string, unknown> = {
      getGenesisHash: state.genesis,
      getMultipleAccounts: { value: state.accounts },
      getBalance: { value: state.feeLamports },
    };
    if (!(request.method in results)) throw new Error("Unexpected RPC method");
    return Response.json({ jsonrpc: "2.0", id: 1, result: results[request.method] });
  });
  return { state, mint, buyer, merchant, fetcher };
}

describe("Payment network and wallet configuration", () => {
  it("defaults to Devnet with official USDC and a public facilitator", () => {
    expect(loadPaymentConfig(env)).toMatchObject({ cluster: "devnet", network: DEVNET_NETWORK,
      mint: DEVNET_USDC_MINT, facilitatorUrl: "https://x402.org/facilitator" });
  });

  it.each(["mainnet", "mainnet-beta", "testnet", "unknown"])("rejects cluster %s", (cluster) => {
    expect(() => loadPaymentConfig({ ...env, SOLANA_CLUSTER: cluster })).toThrow("INVALID_PAYMENT_ENVIRONMENT");
  });

  it("rejects invalid, missing, and identical wallet addresses", () => {
    expect(() => loadPaymentConfig({ ...env, DEMO_BUYER_PUBLIC_KEY: "not-a-wallet" })).toThrow("valid Solana public key");
    expect(() => loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: BUYER })).toThrow("DEMO_MERCHANT_PUBLIC_KEY is required");
    expect(() => loadPaymentConfig({ ...env, DEMO_MERCHANT_PUBLIC_KEY: BUYER })).toThrow("different wallets");
  });

  it.each(["http://localhost.evil.example:8899", "http://127.0.0.1.evil.example", "http://localhost@evil.example"])(
    "rejects a hostname that merely starts with loopback: %s", (url) => {
      expect(() => loadPaymentConfig({ ...env, SOLANA_CLUSTER: "localnet", SOLANA_LOCALNET_RPC_URL: url,
        LOCAL_USDC_MINT: DEVNET_USDC_MINT, X402_FACILITATOR_URL: "http://localhost:4022" })).toThrow("exact loopback");
    },
  );

  it("requires a local facilitator explicitly and accepts IPv6 loopback", () => {
    const localEnv = { ...env, SOLANA_CLUSTER: "localnet", SOLANA_LOCALNET_RPC_URL: "http://[::1]:8899", LOCAL_USDC_MINT: DEVNET_USDC_MINT };
    expect(() => loadPaymentConfig(localEnv)).toThrow("X402_FACILITATOR_URL is required");
    expect(loadPaymentConfig({ ...localEnv, X402_FACILITATOR_URL: "http://127.0.0.1:4022" }).rpcUrl).toBe("http://[::1]:8899");
  });

  it("permits an HTTPS Devnet provider without devnet in its URL, leaving chain verification to RPC", () => {
    expect(loadPaymentConfig({ ...env, SOLANA_DEVNET_RPC_URL: "https://rpc.example/secret" }).rpcUrl).toBe("https://rpc.example/secret");
    expect(() => loadPaymentConfig({ ...env, SOLANA_DEVNET_RPC_URL: "http://rpc.example" })).toThrow("HTTPS");
  });
});

describe("Payment read-only preflight", () => {
  it("uses the bound Devnet quote sponsor without inventing a facilitator URL", async () => {
    const test = fixture();
    const config = { ...loadPaymentConfig(env), facilitatorUrl: null };
    await expect(runPaymentPreflight(config, { fetch: test.fetcher, amount: '5000', feePayer: FEE_PAYER }))
      .resolves.toMatchObject({ network: DEVNET_NETWORK, paymentAmount: '5000', facilitator: { feePayer: FEE_PAYER } });
    expect(test.fetcher.mock.calls.every(([url]) => String(url) === config.rpcUrl)).toBe(true);
    await expect(runPaymentPreflight(config, { fetch: test.fetcher, amount: '5000' }))
      .rejects.toThrow('bound');
  });

  it("uses the bound Mainnet quote sponsor without a merchant facilitator URL", async () => {
    const resource = { resourceId: 'registered', providerId: 'provider', request: {
      url: 'https://provider.example/data', method: 'GET', access: 'https', headers: {} },
      network: MAINNET_NETWORK, mint: MAINNET_USDC_MINT, decimals: 6, recipient: MERCHANT, amount: '5000' };
    const config = loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_mainnet', YOSH_ENABLE_MAINNET_EXECUTION: '1',
      YOSH_MAINNET_RESOURCES: JSON.stringify([resource]) }, 'live_devnet', BUYER);
    expect(config.facilitatorUrl).toBeNull();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(config.rpcUrl);
      const request = JSON.parse(String(init?.body));
      const token = (owner: string, amount: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account',
        info: { owner, mint: MAINNET_USDC_MINT, state: 'initialized', tokenAmount: { amount, decimals: 6 } } } } });
      const results: Record<string, unknown> = {
        getGenesisHash: MAINNET_GENESIS,
        getMultipleAccounts: { value: [{ owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
          token(BUYER, '10000'), token(MERCHANT, '0')] },
        getBalance: { value: 100_000 },
      };
      return Response.json({ result: results[request.method] });
    });
    await expect(runPaymentPreflight(config, { fetch: fetcher, amount: '5000', feePayer: FEE_PAYER }))
      .resolves.toMatchObject({ readyForSettlement: true, facilitator: { feePayer: FEE_PAYER } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([config.rpcUrl, config.rpcUrl, config.rpcUrl]);
    await expect(runPaymentPreflight(config, { fetch: fetcher, amount: '5000' }))
      .rejects.toThrow('bound Mainnet quote fee payer is required');
  });

  it('classifies a missing recipient ATA before signing or transaction simulation', async () => {
    const test = fixture();
    test.state.accounts[2] = null;
    const error = await runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher }).catch(value => value);
    expect(classifyPaymentPreflightError(error)).toBe('RECIPIENT_TOKEN_ACCOUNT_UNAVAILABLE');
    expect(test.fetcher.mock.calls.some(([, init]) => String(init?.body).includes('simulateTransaction'))).toBe(false);
  });

  it("accepts exactly 0.01 USDC with a sponsored fee payer and checks only standard ATAs", async () => {
    const test = fixture();
    const config = loadPaymentConfig({ ...env, SOLANA_DEVNET_RPC_URL: "https://rpc.example/private-key?token=secret" });
    const result = await runPaymentPreflight(config, { fetch: test.fetcher });
    expect(result.readyForSettlement).toBe(true);
    expect(result.buyer.balanceBaseUnits).toBe("10000");
    expect(JSON.stringify(result)).not.toContain("secret");
    const requests = test.fetcher.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.filter((request) => request.method === "getBalance").map((request) => request.params[0])).toEqual([FEE_PAYER]);
    expect(requests.find((request) => request.method === "getMultipleAccounts").params[0]).toEqual([
      DEVNET_USDC_MINT, await getStandardTokenAccount(BUYER, DEVNET_USDC_MINT), await getStandardTokenAccount(MERCHANT, DEVNET_USDC_MINT),
    ]);
    expect(test.fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("rejects a different chain even when the RPC URL says devnet", async () => {
    const test = fixture();
    test.state.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("does not match Solana Devnet");
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it("verifies a local network identifier against the running validator's genesis", async () => {
    const test = fixture();
    test.state.genesis = "11111111111111111111111111111111";
    const config = loadPaymentConfig({ ...env, SOLANA_CLUSTER: "localnet", LOCAL_USDC_MINT: DEVNET_USDC_MINT,
      SOLANA_LOCALNET_NETWORK: "solana:22222222222222222222222222222222", X402_FACILITATOR_URL: "http://127.0.0.1:4022" });
    await expect(runPaymentPreflight(config, { fetch: test.fetcher })).rejects.toThrow("configured local test chain");
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["version", "scheme", "network"])("rejects a facilitator with the wrong %s", async (field) => {
    const test = fixture();
    if (field === "version") test.state.kinds[0].x402Version = 1;
    if (field === "scheme") test.state.kinds[0].scheme = "upto";
    if (field === "network") test.state.kinds[0].network = "solana:mainnet";
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("does not support x402 v2 exact");
  });

  it("requires the facilitator to advertise a valid sponsor", async () => {
    const test = fixture();
    test.state.kinds[0].extra.feePayer = "secret-invalid-address";
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("valid feePayer");
  });

  it("fails when the facilitator is unavailable even if the RPC is healthy", async () => {
    const test = fixture();
    const healthyRpc = test.fetcher.getMockImplementation()!;
    test.fetcher.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/supported")) return new Response("private provider failure", { status: 503 });
      return healthyRpc(url, init);
    });
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("Facilitator supported request failed or timed out");
  });

  it.each(["program", "decimals", "uninitialized"])("rejects invalid mint %s", async (field) => {
    const test = fixture();
    if (field === "program") test.mint.owner = BUYER;
    if (field === "decimals") test.mint.data.parsed.info.decimals = 9;
    if (field === "uninitialized") test.mint.data.parsed.info.isInitialized = false;
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("classic SPL token with 6 decimals");
  });

  it("rejects a buyer with 9,999 base units in the standard ATA", async () => {
    const test = fixture();
    test.buyer.data.parsed.info.tokenAmount.amount = "9999";
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("less than 0.01 USDC");
  });

  it("uses the persisted 200,000-unit quote as the exact balance boundary", async () => {
    const test = fixture();
    const config = loadPaymentConfig(env);
    test.buyer.data.parsed.info.tokenAmount.amount = "200000";
    await expect(runPaymentPreflight(config, { fetch: test.fetcher, amount: "200000" }))
      .resolves.toMatchObject({ paymentAmount: "200000" });
    test.buyer.data.parsed.info.tokenAmount.amount = "199999";
    await expect(runPaymentPreflight(config, { fetch: test.fetcher, amount: "200000" }))
      .rejects.toThrow("less than the quoted amount");
  });

  it.each(["missing", "frozen", "wrong owner", "wrong mint"])("rejects a merchant ATA that is %s", async (condition) => {
    const test = fixture();
    if (condition === "missing") test.state.accounts[2] = null;
    if (condition === "frozen") test.merchant.data.parsed.info.state = "frozen";
    if (condition === "wrong owner") test.merchant.data.parsed.info.owner = BUYER;
    if (condition === "wrong mint") test.merchant.data.parsed.info.mint = BUYER;
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("Merchant standard associated token account");
  });

  it.each([0, 1, 10_000])("rejects an insufficiently funded fee payer (%i lamports)", async balance => {
    const test = fixture();
    test.state.feeLamports = balance;
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: test.fetcher })).rejects.toThrow("fee payer must have SOL");
  });

  it("does not expose secrets from network failures or provider errors", async () => {
    const rejectingFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("https://rpc.example/private-key?token=secret"));
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: rejectingFetch })).rejects.toThrow("RPC getGenesisHash request failed or timed out");
    const errorFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "provider-secret" } }));
    await expect(runPaymentPreflight(loadPaymentConfig(env), { fetch: errorFetch })).rejects.toThrow("RPC getGenesisHash returned an error");
  });
});
