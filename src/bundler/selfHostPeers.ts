import { rootRuntimeDependencies, type RootPackageShape } from '@immediately-run/transpiler';

/**
 * The SDK's peers, for a vendored SDK whose manifest does not declare them.
 *
 * The `package.json` `vendorModuleFrom` writes under `/node_modules/@immediately-run/sdk/`
 * is the SELF-HOST manifest, not npm's: the SDK's self-host build
 * (`immediately-run-sdk/scripts/build-selfhost.mjs`) writes only `{ name, main, module,
 * types }`, so no published self-hosted version carries `peerDependencies` (checked
 * 0.16.0 to 0.57.0, 2026-11-04). These are the peers every published SDK declares on npm
 * (`npm view @immediately-run/sdk@<v> peerDependencies` for 0.16.0, 0.46.0 and latest all
 * give exactly these). This is their one home in the sandbox; `sdkPeers.test.ts` fails
 * if the installed npm SDK's peers drift from it.
 */
export const IMPLICIT_SDK_PEERS: Readonly<Record<string, string>> = Object.freeze({
  react: '^19.0.0',
  'react-dom': '^19.0.0',
});

/**
 * The non-optional peers the vendored SDK brings into an app.
 *
 * The bundler vendors the SDK into every app whether or not the app declares it, so
 * the app's manifest is not the place its peers are answered: an app that never chose
 * the SDK has no reason to declare react. The platform made the SDK implicit, so it
 * makes the SDK's peers implicit beside it.
 *
 * When the vendored manifest has a `peerDependencies` field (a future self-host build
 * that emits it), its non-optional peers win: only the peer fields are passed to
 * `rootRuntimeDependencies`, so this is that function's peer rule (optional peers in
 * `peerDependenciesMeta` skipped) without the module's own `dependencies`, which the CDN
 * closure already resolves. When it has none, which is every self-host manifest
 * published so far, the answer is `IMPLICIT_SDK_PEERS`.
 */
export function sdkPeerDependencies(pkg: RootPackageShape | undefined | null): Record<string, string> {
  if (pkg?.peerDependencies === undefined) return { ...IMPLICIT_SDK_PEERS };
  return rootRuntimeDependencies({
    peerDependencies: pkg.peerDependencies,
    peerDependenciesMeta: pkg.peerDependenciesMeta,
  });
}
