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
