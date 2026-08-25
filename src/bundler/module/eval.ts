// @ts-ignore
import * as swcHelpers from '@swc/helpers';

/* eslint-disable no-eval */
// import buildProcess from "./utils/process";
import * as logger from '../../utils/logger';

const g = typeof window === 'undefined' ? self : window;

const uppercaseFirst = (s: string) => {
  if (s.length == 0) {
    return s;
  }
  return s.substring(0, 1).toUpperCase() + s.substring(1);
};

const extendedSWCHelpers = { ...swcHelpers, interopRequireDefault: swcHelpers._interop_require_default };
for (let [snake_case, v] of Object.entries(swcHelpers)) {
  const parts = snake_case.split('_').filter((p) => p.length > 0);
  if (parts.length > 0) {
    const camelCase = [parts[0], ...parts.slice(1).map((part) => uppercaseFirst(part))].join('');
    extendedSWCHelpers[camelCase] = v;
  }
}

const hasGlobalDeclaration = /^const global/m;

/* eslint-disable no-unused-vars */
export default function (
  code: string,
  require: Function,
  context: { id: string; exports: any; hot?: any },
  env: Object = {},
  globals: Object = {},
) {
  const global = g;
  const process = {
    env: {
      NODE_ENV: 'development',
    },
  }; // buildProcess(env);
  // @ts-ignore
  g.global = global;

  const allGlobals: { [key: string]: any } = {
    require,
    module: context,
    exports: context.exports,
    process,
    global,
    swcHelpers: extendedSWCHelpers,
    ...globals,
  };

  if (hasGlobalDeclaration.test(code)) {
    delete allGlobals.global;
  }

  const allGlobalKeys = Object.keys(allGlobals);
  const globalsCode = allGlobalKeys.length ? allGlobalKeys.join(', ') : '';
  const globalsValues = allGlobalKeys.map((k) => allGlobals[k]);
  try {
    const newCode = `(function $csb$eval(` + globalsCode + `) {` + code + `\n})`;
    // @ts-ignore
    (0, eval)(newCode).apply(allGlobals.global, globalsValues);

    return context.exports;
  } catch (err) {
    logger.error(err);
    logger.error(code);

    let error = err;
    if (typeof err === 'string') {
      error = new Error(err);
    }
    // @ts-ignore
    error.isEvalError = true;

    throw error;
  }
}
