// A WIRING guard for the working-tree `fs-change` admission.
//
// `FsChangeGate` is unit-tested next door, but the frame that calls it lives on
// `SandpackInstance`, which is constructed at module scope
// (`window['sandpack'] = new SandpackInstance()`) and cannot be driven from a test.
// An adversarial review exploited exactly that: it gutted the handler's admission —
// leaving the gate correct and simply not consulted — and the ENTIRE suite stayed
// green, restoring in full the production recompile loop the gate exists to stop
// (~7 full compiles/sec in a live preview, from one keystroke).
//
// So the call site is asserted against the source text, the way this repo already
// asserts the served CSP (`security/m3Csp.test.ts`). It is a coarse instrument, but
// the alternative measured here is zero coverage of the only line that ships.
import { readFileSync } from 'fs';
import { join } from 'path';

const INDEX = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

/** The body of the `case FS_CHANGE:` arm, up to the next `case`. */
const fsChangeBranch = (): string => {
  const start = INDEX.indexOf('case FS_CHANGE:');
  expect(start).toBeGreaterThan(-1);
  const rest = INDEX.slice(start + 'case FS_CHANGE:'.length);
  const end = rest.indexOf('\n      case ');
  return end === -1 ? rest : rest.slice(0, end);
};

describe('the fs-change handler consults the admission gate', () => {
  it('gates on `fsChangeGate.admit` and returns when it refuses', () => {
    // The negation + early return, not merely a mention: a call whose result is
    // discarded is the precise shape the review injected.
    expect(fsChangeBranch()).toMatch(/if\s*\(\s*!\s*this\.fsChangeGate\.admit\([^)]*\)\s*\)\s*return\s*;/);
  });

  it('admits BEFORE it invalidates or schedules a compile', () => {
    const branch = fsChangeBranch();
    const admit = branch.indexOf('this.fsChangeGate.admit(');
    const mark = branch.indexOf('markFilesChanged');
    const compile = branch.indexOf('compileDebouncer');
    expect(admit).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(admit);
    expect(compile).toBeGreaterThan(admit);
  });

  it('keeps the gate as instance state, so its memory spans batches', () => {
    // A gate constructed per message would remember nothing and admit everything.
    expect(INDEX).toMatch(/private\s+fsChangeGate\s*=\s*new\s+FsChangeGate\(\)\s*;/);
    expect(fsChangeBranch()).not.toMatch(/new\s+FsChangeGate\(/);
  });
});
