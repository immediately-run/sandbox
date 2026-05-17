import { SandpackLogLevel } from '../utils/logger';

export interface ICompileRequest {
  version: number;
  template: string;

  clearConsoleDisabled?: boolean;
  disableDependencyPreprocessing?: boolean;
  externalResources?: Array<string>;
  isInitializationCompile?: boolean;
  reactDevTools?: 'legacy' | 'latest';
  showErrorScreen?: boolean;
  showLoadingScreen?: boolean;
  showOpenInCodeSandbox?: boolean;
  skipEval?: boolean;
  logLevel?: SandpackLogLevel;
}

export type BundlerStatus =
  | 'initializing'
  | 'installing-dependencies'
  | 'transpiling'
  | 'evaluating'
  | 'running-tests'
  | 'idle';
