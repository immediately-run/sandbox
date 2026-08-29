import evaluate from './eval';
import { createModuleSpaceFetch } from './moduleSpaceFetch';
import type { Bundler } from '../bundler';

// R3-426 (review): the module-space `fetch` shadow is injected through the evaluator's
// globals channel, which makes every injected name a `$csb$eval` PARAMETER. A module
// that declares its own lexical `fetch` is then a duplicate binding and dies at PARSE
// time with `SyntaxError: Identifier 'fetch' has already been declared` — the whole
// module, not just the declaration. `const` is not downleveled (preset-env targets
// modern browsers) and precompiled/raw-cjs modules evaluate verbatim, so real published
// packages reach the evaluator with this exact shape.
describe('evaluator globals: a module may declare its own binding for an injected name', () => {
  const stubFetch = createModuleSpaceFetch({
    fs: { isFileAsync: async () => false, readBytesAsync: async () => new Uint8Array() },
  } as unknown as Bundler);

  const run = (code: string) => {
    const context: any = { id: '/app/src/a.js', exports: {} };
    evaluate(code, () => ({}), context, {}, { fetch: stubFetch });
    return context.exports;
  };

  it.each([
    ['const', 'const fetch = () => "mine";\nmodule.exports = fetch();'],
    ['let', 'let fetch = () => "mine";\nmodule.exports = fetch();'],
    ['class', 'class fetch {}\nmodule.exports = new fetch() instanceof fetch ? "mine" : "no";'],
    ['minified (all on one line)', 'var a=1;const fetch=()=>"mine";module.exports=fetch();'],
    ['"use strict" prologue', '"use strict";\nconst fetch = () => "mine";\nmodule.exports = fetch();'],
  ])('a top-level `%s fetch` declaration evaluates instead of throwing a SyntaxError', (_label, code) => {
    expect(() => run(code)).not.toThrow();
    expect(run(code)).toBe('mine');
  });

  it('the same hazard on `global` stays fixed (the pre-existing precedent)', () => {
    expect(run('const global = "mine";\nmodule.exports = global;')).toBe('mine');
  });

  it('a module that does NOT declare fetch still gets the injected shadow', () => {
    expect(run('module.exports = typeof fetch;')).toBe('function');
    // …and it is OUR shadow, not the ambient one.
    expect(run('module.exports = fetch;')).toBe(stubFetch);
  });

  it('`var fetch` / `function fetch` are legal redeclarations and keep working', () => {
    // These never threw (a parameter may be redeclared by var/function), so they must
    // keep evaluating — whether or not the shadow is dropped for them.
    expect(run('var fetch = () => "mine";\nmodule.exports = fetch();')).toBe('mine');
    expect(run('function fetch(){ return "mine"; }\nmodule.exports = fetch();')).toBe('mine');
  });
});
