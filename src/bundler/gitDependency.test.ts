import { parseGitDependency } from './gitDependency';

// LIBRARY_MOUNTS_SPEC §4 — the bundler must recognize the standard npm
// git-dependency `dependencies` value forms (and ONLY those) so they route to
// the mount path ahead of the semver/CDN parser.
describe('parseGitDependency', () => {
  describe('accepts the npm git-dependency forms', () => {
    it('parses `github:owner/repo#ref`', () => {
      expect(parseGitDependency('github:owner/repo#abc123')).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'abc123',
      });
    });

    it('parses the bare `owner/repo#ref` shorthand', () => {
      expect(parseGitDependency('immediately-run/file-explorer#main')).toEqual({
        owner: 'immediately-run',
        repo: 'file-explorer',
        ref: 'main',
      });
    });

    it('parses `git+https://github.com/owner/repo.git#ref`', () => {
      expect(parseGitDependency('git+https://github.com/owner/repo.git#v1.2.0')).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'v1.2.0',
      });
    });

    it('parses `https://github.com/owner/repo#ref` (no .git, no git+ prefix)', () => {
      expect(parseGitDependency('https://github.com/owner/repo#deadbeef')).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'deadbeef',
      });
    });

    it('parses `git+ssh://git@github.com/owner/repo.git#ref`', () => {
      expect(parseGitDependency('git+ssh://git@github.com/owner/repo.git#tag1')).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'tag1',
      });
    });

    it('defaults the ref to `main` when no `#ref` is given (URL/prefixed forms)', () => {
      expect(parseGitDependency('github:owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
      });
      expect(parseGitDependency('https://github.com/owner/repo.git')).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
      });
    });
  });

  describe('returns null for non-github-git specifiers', () => {
    it.each([
      ['^1.2.3'],
      ['1.2.3'],
      ['~0.0.1'],
      ['>=1.0.0 <2.0.0'],
      ['latest'],
      ['*'],
      ['workspace:*'],
      ['file:../local'],
      ['npm:@scope/other@1.0.0'],
      ['link:../pkg'],
      // a bare `owner/repo` WITHOUT a #ref is ambiguous — must NOT divert off CDN
      ['owner/repo'],
      // non-github git hosts are out of scope for L2
      ['gitlab:owner/repo#main'],
      ['bitbucket:owner/repo#main'],
      ['git+https://gitlab.com/owner/repo.git#main'],
      [''],
      ['   '],
    ])('returns null for %p', (value) => {
      expect(parseGitDependency(value)).toBeNull();
    });
  });

  describe('rejects path traversal / unsafe components', () => {
    it('rejects `..` in the ref', () => {
      expect(parseGitDependency('github:owner/repo#..')).toBeNull();
      expect(parseGitDependency('github:owner/repo#../etc')).toBeNull();
    });

    it('rejects `..` in owner/repo', () => {
      expect(parseGitDependency('github:../repo#main')).toBeNull();
      expect(parseGitDependency('github:owner/..#main')).toBeNull();
    });

    it('rejects an extra path segment (not exactly owner/repo)', () => {
      expect(parseGitDependency('github:owner/repo/extra#main')).toBeNull();
    });
  });
});
