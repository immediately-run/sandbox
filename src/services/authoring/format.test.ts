// Prettier service: correctness + CS-1 input-trust (CLIENT_SERVICES_SPEC §6).
import { runFormat, ServiceInputError } from './format';

describe('runFormat', () => {
  it('formats ugly TypeScript to canonical output', () => {
    const { formatted } = runFormat({ source: 'const   x=1', parser: 'typescript' });
    expect(formatted).toBe('const x = 1;\n');
  });

  it('honors a whitelisted scalar option (singleQuote)', () => {
    const { formatted } = runFormat({ source: 'const s = "hi"', parser: 'typescript', options: { singleQuote: true } });
    expect(formatted).toBe("const s = 'hi';\n");
  });

  it('formats css and json via the kernel parser menu', () => {
    expect(runFormat({ source: 'a{color:red}', parser: 'css' }).formatted).toContain('color: red;');
    expect(runFormat({ source: '{"a":1}', parser: 'json' }).formatted.trim()).toBe('{ "a": 1 }');
  });

  // --- CS-1: no caller-supplied plugin / config / module path reaches prettier ---

  it('rejects an unknown parser (callers name a parser, never a module path)', () => {
    expect(() => runFormat({ source: 'x', parser: './evil-plugin.js' })).toThrow(ServiceInputError);
    expect(() => runFormat({ source: 'x', parser: 'typescript-but-evil' })).toThrow(/unknown parser/);
  });

  it('rejects a caller-supplied plugins/config option', () => {
    expect(() => runFormat({ source: 'x', parser: 'babel', options: { plugins: ['./evil.js'] } })).toThrow(
      /unsupported option/,
    );
    expect(() => runFormat({ source: 'x', parser: 'babel', options: { parser: 'x' } })).toThrow(/unsupported option/);
  });

  it('rejects a non-scalar / function / __proto__ option value', () => {
    expect(() => runFormat({ source: 'x', parser: 'babel', options: { printWidth: (() => 0) as unknown } })).toThrow(
      ServiceInputError,
    );
    // a literal __proto__ key must not resolve to a validator via the prototype chain
    expect(() => runFormat({ source: 'x', parser: 'babel', options: JSON.parse('{"__proto__":{"x":1}}') })).toThrow(
      /unsupported option/,
    );
    expect(() => runFormat({ source: 'x', parser: 'babel', options: { trailingComma: 'evil' } })).toThrow(
      /invalid value/,
    );
  });

  it('rejects a non-string or oversize source', () => {
    expect(() => runFormat({ source: 123 as unknown, parser: 'babel' })).toThrow(/source must be a string/);
    expect(() => runFormat({ source: 'x'.repeat(600 * 1024), parser: 'babel' })).toThrow(/size budget/);
  });
});
