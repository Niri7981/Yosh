import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import packageMetadata from '../../package.json';
import packageLock from '../../package-lock.json';
import { YOSH_PRODUCT_RELEASE } from '../../src/modules/app/product-version';
import { signedManagementRequest } from '../helpers/management-request';

const state = vi.hoisted(() => ({ overview: vi.fn() }));
vi.mock('@/modules/app/app-runtime', () => ({ appRuntime: () => state }));
import { GET } from '../../src/app/api/app/overview/route';

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('keeps package, native build settings and resolved bundle fields on the same product release', () => {
  const project = readFileSync(new URL('../../apps/macos/Yosh/Yosh.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  const plist = readFileSync(new URL('../../apps/macos/Yosh/YoshApp/Info.plist', import.meta.url), 'utf8');
  expect(packageLock.version).toBe(packageMetadata.version);
  expect(packageLock.packages[''].version).toBe(packageMetadata.version);
  const settings = (key: string) => [...project.matchAll(new RegExp(`\\b${key} = "?([^";]+)"?;`, 'g'))].map(match => match[1]);
  expect(settings('MARKETING_VERSION')).toEqual([packageMetadata.version, packageMetadata.version]);
  expect(settings('CURRENT_PROJECT_VERSION')).toEqual([packageMetadata.yoshRelease.buildNumber, packageMetadata.yoshRelease.buildNumber]);
  expect(settings('YOSH_RELEASE_CANDIDATE')).toEqual([packageMetadata.yoshRelease.candidate, packageMetadata.yoshRelease.candidate]);
  expect(packageMetadata.yoshRelease.candidate).toMatch(new RegExp(`^${packageMetadata.version.replaceAll('.', '\\.')}-rc\\.[1-9]\\d*$`));
  expect(packageMetadata.yoshRelease.buildNumber).toMatch(/^[1-9]\d*$/);
  expect(plist).toContain('<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>');
  expect(plist).toContain('<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>');
  expect(plist).toContain('<key>YoshReleaseCandidate</key><string>$(YOSH_RELEASE_CANDIDATE)</string>');
});

it('includes the release identity in the authenticated management overview without changing business facts', async () => {
  const token = 'product-release-management-fixture';
  vi.stubEnv('YOSH_MANAGEMENT_TOKEN', token);
  const facts = { service: { status: 'running' }, purchases: [], budget: { paused: true } };
  state.overview.mockResolvedValue(facts);
  const response = await GET(signedManagementRequest('http://127.0.0.1:3049/api/app/overview', token));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ ...facts, product: YOSH_PRODUCT_RELEASE });
});
