// R3-426 — the shared wasm fixture bytes: the canonical two-i32 `add` module
// ((module (func (export "add") (param i32 i32) (result i32) local.get 0
// local.get 1 i32.add))), hand-assembled. Every byte is ASCII-range, so it survives
// any utf8 round trip, but the harness seeds it as raw bytes anyway (the honest
// binary path). add(2, 3) === 5 is the executable proof the wasm actually ran.
export const WASM_ADD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1,
  7, 0, 32, 0, 32, 1, 106, 11,
]);

/** The exports shape of WASM_ADD. */
export interface WasmAddExports {
  add(a: number, b: number): number;
}
