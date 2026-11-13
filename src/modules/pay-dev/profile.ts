/** Candidate identity is selected by the release bundler, never runtime input. */
declare const __YOSH_RC5__: boolean | undefined;
declare const __YOSH_PLUGIN_DEV__: boolean | undefined;
declare const __YOSH_STANDALONE_DEV__: boolean | undefined;
declare const __YOSH_LOCAL_AUTH_DEV__: boolean | undefined;
export const IS_LOCAL_AUTH_DEVELOPMENT = typeof __YOSH_LOCAL_AUTH_DEV__ !== 'undefined' && __YOSH_LOCAL_AUTH_DEV__;
const rc5 = typeof __YOSH_RC5__ !== 'undefined' && __YOSH_RC5__;
const standalone = typeof __YOSH_STANDALONE_DEV__ !== 'undefined' && __YOSH_STANDALONE_DEV__;
export const IS_CODEX_PLUGIN_DEVELOPMENT = typeof __YOSH_PLUGIN_DEV__ !== 'undefined' && __YOSH_PLUGIN_DEV__;
if ((rc5 && IS_CODEX_PLUGIN_DEVELOPMENT) || (standalone && (!IS_CODEX_PLUGIN_DEVELOPMENT || rc5))) throw new Error('PAY_DEVELOPMENT_PROFILE_CONFLICT');

if (IS_LOCAL_AUTH_DEVELOPMENT && !standalone) throw new Error('PAY_DEVELOPMENT_PROFILE_CONFLICT');

export const PAY_DEVELOPMENT_PROFILE = Object.freeze({
  bundleIdentifier: IS_LOCAL_AUTH_DEVELOPMENT ? 'com.yosh.local-authorization-dev' : standalone ? 'com.yosh.standalone-plugin-dev' : IS_CODEX_PLUGIN_DEVELOPMENT ? 'com.yosh.codex-plugin-dev' : rc5 ? 'com.yosh.pay-development.v011rc5' : 'com.yosh.pay-development',
  directoryName: IS_LOCAL_AUTH_DEVELOPMENT ? 'Yosh Local Authorization Dev' : standalone ? 'Yosh Standalone Plugin Dev' : IS_CODEX_PLUGIN_DEVELOPMENT ? 'Yosh Codex Plugin Dev' : rc5 ? 'Yosh Pay Dev v0.1.1-rc.5' : 'Yosh Pay Dev',
  backendPort: IS_LOCAL_AUTH_DEVELOPMENT ? 17449 : standalone ? 15449 : IS_CODEX_PLUGIN_DEVELOPMENT ? 14449 : rc5 ? 13449 : 13049,
  merchantPort: IS_LOCAL_AUTH_DEVELOPMENT ? 17450 : standalone ? 15450 : IS_CODEX_PLUGIN_DEVELOPMENT ? 14450 : rc5 ? 13450 : 13050,
  rpcPort: IS_LOCAL_AUTH_DEVELOPMENT ? 17451 : standalone ? 15451 : IS_CODEX_PLUGIN_DEVELOPMENT ? 14451 : rc5 ? 13451 : 13051,
  keychainNamespace: IS_LOCAL_AUTH_DEVELOPMENT ? 'com.yosh.local-authorization-dev' : standalone ? 'com.yosh.standalone-plugin-dev' : IS_CODEX_PLUGIN_DEVELOPMENT ? 'com.yosh.codex-plugin-dev' : rc5 ? 'com.yosh.pay-development.v011rc5' : 'com.yosh.pay-development',
});
