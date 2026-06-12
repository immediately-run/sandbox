module.exports = {
  resolver: "<rootDir>/jest.resolver.cjs",
  setupFiles: ["<rootDir>/jest.setup.cjs"],
  transform: {
    // Force CommonJS output: the project tsconfig uses `module: es2020`, which
    // @swc-node/jest would otherwise emit as ESM `import`s that Jest's CommonJS
    // runtime can't execute ("Cannot use import statement outside a module").
    "^.+\\.(t|j)sx?$": ["@swc-node/jest", { module: "commonjs" }],
  },
  testMatch: ["**/*.test.ts"],
  transformIgnorePatterns: [],
};
