/**
 * Method catalog mirrored from the parent window into the sandbox (UI_AS_APPS
 * §5.5). The parent advertises — via an `api-catalog` message — exactly the host
 * RPC methods THIS iframe may call, generated from the §8.4 gate table and
 * filtered to the iframe's grants (so it reveals nothing the app couldn't already
 * invoke, T24). App code reads it (and hands it to an embedded agent as its tool
 * list) through the bundler, via the SDK's getCatalog / onCatalogChange /
 * useCatalog.
 *
 * Baseline `catalog:read`: every app may discover its own surface.
 */
export interface ApiMethod {
  /** Catalog name, `protocol-` stripped — e.g. `spaces:share`, `contribute:run`. */
  name: string;
  /** The capability the method requires (already held — it's in your catalog). */
  capability: string;
  /** True when the method streams rather than single-reply. */
  stream?: boolean;
}

/** Assumed before the parent has reported: an empty surface. */
export const DEFAULT_CATALOG: ApiMethod[] = [];

/** Identity message the parent sends to push the current method catalog. */
export const CATALOG_MESSAGE = 'api-catalog';

/** Sent by the sandbox once registered, asking the parent to reply with it. */
export const REQUEST_CATALOG_MESSAGE = 'request-api-catalog';

/** A catalog push message from the parent. */
export interface CatalogMessage {
  type: typeof CATALOG_MESSAGE;
  methods: ApiMethod[];
}

/** True when two catalogs are equal (used to suppress no-op change events). */
export const catalogsEqual = (a: ApiMethod[], b: ApiMethod[]): boolean =>
  a.length === b.length && a.every((m, i) => m.name === b[i]?.name && m.stream === b[i]?.stream);
