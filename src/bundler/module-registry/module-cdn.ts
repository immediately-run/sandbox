import { decode as decodeMsgPack } from '@msgpack/msgpack';
import urlJoin from 'url-join';

import { retryFetch, registerImmutableUrlPrefix } from '../../utils/fetch';
import { DepMap } from '.';

// NOTE(2026-06): this is the live, load-bearing dependency-resolution CDN
// (PRETRANSPILED_ARTIFACTS_SPEC §0/§5.4 reference its `/dep_tree/` endpoint), NOT
// dead code — used on every compile via fetchManifest/fetchModule. It is a
// CodeSandbox-lineage host (`blazingly.io`) and currently points at a `-staging`
// subdomain; verify it is the intended prod CDN + on the HOST_ORIGIN_HARDENING
// connect-src allowlist. See CODE_SPEC_REFERENCES.md (kept, not a deprecation).
const CDN_ROOT = 'https://sandpack-cdn-staging.blazingly.io/';

// /package/<name@exact-version> responses never change for a given URL, so
// retryFetch serves them cache-first from the persistent immutable cache.
// /dep_tree/ is deliberately NOT registered: it resolves semver ranges, and its
// result changes as new versions are published.
registerImmutableUrlPrefix(urlJoin(CDN_ROOT, '/package/'));

export interface IResolvedDependency {
  // name
  n: string;
  // version
  v: string;
  // depth
  d: number;
}

// Exported so the lockset check (lockset.ts) can reject locksets resolved
// against a different CDN protocol version.
export const CDN_VERSION = 5;

function encodePayload(payload: string): string {
  return btoa(`${CDN_VERSION}(${payload})`);
}

export async function fetchManifest(deps: DepMap): Promise<IResolvedDependency[]> {
  const encoded_manifest = encodePayload(JSON.stringify(deps));
  const result = await retryFetch(urlJoin(CDN_ROOT, `/dep_tree/${encoded_manifest}`), {
    maxRetries: 5,
    retryDelay: 1000,
  });
  const buffer = await result.arrayBuffer();
  return decodeMsgPack(buffer) as IResolvedDependency[];
}

export type CDNModuleFileType = ICDNModuleFile | number;

export interface ICDNModuleFile {
  // content
  c: string;
  // dependencies
  d: string[];
  // is transpiled
  t: boolean;
}

export interface ICDNModule {
  // files
  f: Record<string, CDNModuleFileType>;
  // transient dependencies
  m: string[];
}

export async function fetchModule(name: string, version: string): Promise<ICDNModule> {
  const specifier = `${name}@${version}`;
  const encoded_specifier = encodePayload(specifier);
  const result = await retryFetch(urlJoin(CDN_ROOT, `/package/${encoded_specifier}`), { maxRetries: 5 });
  const buffer = await result.arrayBuffer();
  return decodeMsgPack(buffer) as ICDNModule;
}
