import { rootRuntimeDependencies, type RootPackageShape } from '@immediately-run/transpiler';

/**
 * The non-optional `peerDependencies` of a self-hosted module's own package.json.
 *
 * The bundler vendors the SDK into every app whether or not the app declares it, so
 * the app's manifest is not the place its peers are answered: an app that never chose
 * the SDK has no reason to declare react. The platform made the SDK implicit, so it
 * makes the SDK's peers implicit beside it, read from the vendored manifest so a pinned
 * SDK and the default one each bring their own ranges.
 *
 * Only the peer fields are passed to `rootRuntimeDependencies`, so this is that
 * function's peer rule (optional peers in `peerDependenciesMeta` skipped) without the
 * module's own `dependencies`, which the CDN closure already resolves.
 */
export function sdkPeerDependencies(pkg: RootPackageShape | undefined | null): Record<string, string> {
  return rootRuntimeDependencies({
    peerDependencies: pkg?.peerDependencies,
    peerDependenciesMeta: pkg?.peerDependenciesMeta,
  });
}
