import { checkCommentRefs } from '@immediately-run/verify-checks/comment-refs';

// R3-1085 — a backticked span in a comment that names a symbol or path must
// name one that exists. The allow map carries only names a comment
// legitimately cites but this repo's code never spells (platform globals,
// docs-corpus spec names, cross-repo paths); a stale entry is itself a
// finding. Everything else unresolved is the R7 debt ledger in
// verify-baselines/comment-refs.json, which only shrinks.
await checkCommentRefs({
  patterns: ['src/**/*.{ts,tsx}', 'scripts/**/*.{mjs,mts,ts}'],
  ignore: ['**/generated/**'],
  pathRoots: ['src'],
  allow: {
    WebSocket: 'platform/library global the repo’s code never spells',
    'immediately-run-sdk/src/collectHeadings.ts': 'a path in a sibling repo or the docs corpus, cited cross-repo',
    'site-main/src/registry/channelBridge.ts': 'a path in a sibling repo or the docs corpus, cited cross-repo',
    'site-main/src/registry/protocolHandshake.ts': 'a path in a sibling repo or the docs corpus, cited cross-repo',
    PRETRANSPILED_ARTIFACTS_SPEC: 'a spec in the docs repo, cited by name',
    'plans/in-browser-test-runner/01-execution-realm.mdx':
      'a path in a sibling repo or the docs corpus, cited cross-repo',
    MessageChannel: 'platform/library global the repo’s code never spells',
    'plans/in-browser-test-runner/03-engine-and-tool.mdx':
      'a path in a sibling repo or the docs corpus, cited cross-repo',
    UI_AS_APPS_SPEC: 'a spec in the docs repo, cited by name',
    TRUST_MODES_SPEC: 'a spec in the docs repo, cited by name',
    'site-main/src/trust/m3Document.ts': 'a path in a sibling repo or the docs corpus, cited cross-repo',
    'immediately-run-sdk/scripts/check-protocol-snapshot.mjs':
      'a path in a sibling repo or the docs corpus, cited cross-repo',
    localStorage: 'platform/library global the repo’s code never spells',
    sendBeacon: 'platform/library global the repo’s code never spells',
  },
  baselinePath: 'verify-baselines/comment-refs.json',
});
