import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const ProductConfiguration = z.object({
  YOSH_PAY_MCP_MAINNET: z.enum(['0', '1']).optional(),
  YOSH_ENABLE_MAINNET_EXECUTION: z.enum(['0', '1']).optional(),
  YOSH_MAINNET_RESOURCES: z.string().optional(),
  YOSH_MAINNET_WALLET_PUBLIC_KEY: z.string().optional(),
  SOLANA_MAINNET_RPC_URL: z.string().optional(),
  X402_FACILITATOR_URL: z.string().optional(),
}).strict();

export class ProductConfigurationError extends Error {
  constructor(readonly code: 'PRODUCT_CONFIGURATION_INVALID' | 'PRODUCT_CONFIGURATION_WRITE_FAILED') {
    super(code);
  }
}

/** The native launcher and backend use the same private product file. Never replace other payment settings. */
export function readProductConfiguration(directory: string) {
  const path = join(directory, 'product-configuration.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new ProductConfigurationError('PRODUCT_CONFIGURATION_INVALID');
    }
    return ProductConfiguration.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    if (error instanceof ProductConfigurationError) throw error;
    throw new ProductConfigurationError('PRODUCT_CONFIGURATION_INVALID');
  }
}

export function writeProductionExecutionSetting(directory: string, enabled: boolean) {
  const previous = readProductConfiguration(directory);
  const path = join(directory, 'product-configuration.json');
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, JSON.stringify(ProductConfiguration.parse({ ...previous,
      YOSH_ENABLE_MAINNET_EXECUTION: enabled ? '1' : '0' })));
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
    const directoryHandle = openSync(directory, 'r');
    try { fsyncSync(directoryHandle); } finally { closeSync(directoryHandle); }
  } catch {
    if (handle !== undefined) closeSync(handle);
    rmSync(temporary, { force: true });
    throw new ProductConfigurationError('PRODUCT_CONFIGURATION_WRITE_FAILED');
  }
}
