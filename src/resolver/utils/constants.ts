// The resolver's empty-module shim. Lives at a defined home on the root tmpfs
// (R3-48 G0-4 mount table); the Bundler writes the stub there in setupModuleMounts.
export const EMPTY_SHIM = '/empty.js';
