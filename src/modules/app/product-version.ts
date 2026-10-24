import packageMetadata from '../../../package.json';

/** Product metadata only; Pay and pay-kit retain their independent versions. */
export const YOSH_VERSION = packageMetadata.version;
export const YOSH_RELEASE_CANDIDATE = packageMetadata.yoshRelease.candidate;
export const YOSH_BUILD_NUMBER = packageMetadata.yoshRelease.buildNumber;
export const YOSH_PRODUCT_RELEASE = Object.freeze({ name: 'Yosh', version: YOSH_VERSION,
  releaseCandidate: YOSH_RELEASE_CANDIDATE, buildNumber: YOSH_BUILD_NUMBER });
