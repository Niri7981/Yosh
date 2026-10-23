/** Candidate identity is selected by the release bundler, never runtime input. */
declare const __YOSH_RC5__: boolean | undefined;
const rc3 = typeof __YOSH_RC5__ !== 'undefined' && __YOSH_RC5__;

export const PAY_DEVELOPMENT_PROFILE = Object.freeze({
  bundleIdentifier: rc3 ? 'com.yosh.pay-development.v011rc5' : 'com.yosh.pay-development',
  directoryName: rc3 ? 'Yosh Pay Dev v0.1.1-rc.5' : 'Yosh Pay Dev',
  backendPort: rc3 ? 13449 : 13049,
  merchantPort: rc3 ? 13450 : 13050,
  rpcPort: rc3 ? 13451 : 13051,
  keychainNamespace: rc3 ? 'com.yosh.pay-development.v011rc5' : 'com.yosh.pay-development',
});
