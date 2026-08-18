// The sandbox↔SDK wire vocabulary — re-exported from the published contract.
//
// Until R3-274b1 this file was GENERATED here, from a descriptor set that also lived
// here, and the SDK's half of the same generation was hand-copied into that repo. It
// now comes from `@immediately-run/sandbox-protocol`, which owns the descriptors and
// publishes a module per side (PLATFORM_LAYERING_SPEC §2 / S1 target 1).
//
// The file stays at this path so no import site in this repo moves, and because
// `src/generated/` is where a reader expects to find "not authored here".
//
// To change the wire: edit the descriptors in that package, publish, bump the pin.
// `npm run protocol:check` fails until this repo's source and the pinned contract
// agree — which is the whole point of the contract being published rather than
// copied.
export * from '@immediately-run/sandbox-protocol/sandbox';
