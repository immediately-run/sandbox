// Circular-import detection for module evaluation. The bundler evaluates a
// module by synchronously running its compiled code, which `require()`s its
// dependencies — so a require cycle (A → B → A) re-enters A's evaluation before
// it has finished, and without a guard recurses forever ("RangeError: Maximum
// call stack size exceeded" — an opaque failure with no hint at the offending
// modules). `Module.evaluate` tracks the in-progress evaluation stack and throws
// a `CircularImportError` the moment it re-enters a module already on it, naming
// the exact loop.

/** Strip the virtual `/node_modules/` prefix so package modules read naturally
 *  (`/node_modules/@immediately-run/sdk/runtime.js` → `@immediately-run/sdk/runtime.js`). */
export function prettyModuleName(filepath: string): string {
  return filepath.replace(/^\/node_modules\//, '');
}

/**
 * Build the human-facing message for a circular import. `cycle` is the evaluation
 * stack from the first re-entered module through to the dependency that closed the
 * loop back onto it (so `cycle[0]` and the closing edge are the same module).
 */
export function formatCircularImport(cycle: string[]): string {
  const names = cycle.map(prettyModuleName);
  const arrows = names.map((n, i) => (i === 0 ? `  ${n}` : `    → ${n}`)).join('\n');
  const closing = names[0];
  return (
    `Circular import detected while evaluating modules:\n\n` +
    `${arrows}\n    → ${closing}  (cycle closes here)\n\n` +
    `\`${closing}\` is require()d again before it finished initializing, so its ` +
    `exports are not ready and evaluation would recurse forever. Break the cycle: ` +
    `move the shared binding into a leaf module that imports nothing from this group, ` +
    `or defer the import until it is used.`
  );
}

export class CircularImportError extends Error {
  /** The module filepaths forming the loop, in evaluation order. */
  readonly cycle: string[];
  /** Read by the sandbox error overlay (`errors/util.ts errorMessage`) as the header. */
  readonly title = 'Circular import';
  constructor(cycle: string[]) {
    super(formatCircularImport(cycle));
    this.name = 'CircularImportError';
    this.cycle = cycle;
  }
}

/**
 * Given the current in-progress evaluation stack and the module about to be
 * (re-)evaluated, return the cycle slice if `filepath` is already on the stack,
 * else `null`. The returned slice starts at the first occurrence of `filepath`
 * and runs to the end of the stack — i.e. exactly the modules in the loop.
 */
export function detectCycle(stack: readonly string[], filepath: string): string[] | null {
  const start = stack.indexOf(filepath);
  if (start === -1) return null;
  return stack.slice(start);
}
