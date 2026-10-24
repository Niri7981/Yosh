import { fileURLToPath } from 'node:url';
import { findPayEnvironmentSuites } from './pay-environment-discovery';

// Discover prepared Rust/sibling/historical dependencies transitively so a new
// suite using an existing Pay fixture cannot silently enter ordinary npm test.
export const payEnvironmentTests = findPayEnvironmentSuites(fileURLToPath(new URL('../../', import.meta.url)));
