# Node module caching

Immutable, exact-versioned module requests (the module CDN's `/package/...`
endpoints and unpkg files) are cached at runtime in a persistent Cache API
cache — see `registerImmutableUrlPrefix` in `src/utils/fetch.ts`. The first
fetch of a given URL populates the cache; later loads are served from it
without touching the network. There is nothing to regenerate or check in.

# Sandpack Bundler

The sandpack bundler, this aims to eventually replace the current sandpack with a more streamlined and faster version.

## Getting started

1. Run `yarn` to install dependencies.
2. Run `yarn dev` to start the development server
3. Set the `bundlerURL` of sandpack-react to `http://localhost:1234/` to see it in action.

`yarn dev` serves with `--no-hmr` (R3-422). The bundler runs inside host-created
sandboxed iframes, usually behind the `sandbox.local.immediately.run` HTTPS proxy.
Parcel's injected HMR client opens a websocket to `location.hostname` on
`location.port` — the *proxy's* origin, where no parcel HMR server listens — so it
could never connect, and every iframe load logged
`[parcel] 🚨 Connection to the HMR server was lost`, burying real errors. The host
reloads the preview iframe on each boot anyway, so nothing was gained for the
noise. Iterate by reloading the host page. If you load the dev server directly at
`http://localhost:1234/` (no proxy, no host) and want hot reload, use
`yarn dev:hmr`.

(The other websocket failure seen alongside it in the console — `wss://…:3000/ws`
— is *not* parcel: `/ws` on port 3000 is webpack-dev-server's HMR client from
site-main's own `react-scripts start`. That one belongs to site-main.)

## Test the production build (performance/integration tests)

1. Run `yarn` to install dependencies.
2. Run `yarn build` to build the application
3. Run `yarn start` to start a local test server
4. Set the `bundlerURL` of sandpack-react to `http://localhost:4587/`

## Using the deployed version

The `main` branch of this repository is automatically deployed to `https://sandpack-bundler.codesandbox.io` so you can update `bundlerURL` of `sandpack-react` to that url and start using the new sandpack bundler.

## Verify (the CI/deploy gate)

`npm run verify` runs this repo's full CI gate in one command —
`lint` → `format --check` → `typecheck` → `test` → `build`. Run it before pushing;
it is the same set of checks CI enforces (the lint + build jobs), so a local green
equals a green CI. (Ways of working §4: the local verify gate must equal the deploy
gate — one `npm run verify` per repo.)

## Fonts

```
cp -r /Users/neumark/git/sandpack-test/my-app/node_modules/@fontsource/roboto/files ./dist/
```
