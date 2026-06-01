import { Bundler } from '../../bundler';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';
import { compile } from '@mdx-js/mdx'
import { VFile } from 'vfile'

import { BundlerError } from '../../../errors/BundlerError';
import {VFileMessage} from 'vfile-message'
import remarkGfm from 'remark-gfm'
import { PluggableList } from 'unified';
import { parseFrontmatter } from '../../frontmatter';

export class MDXTransformer extends Transformer {

  private recmaPlugins:PluggableList = [];
  private rehypePlugins:PluggableList = [];
  private remarkPlugins:PluggableList = [
    [remarkGfm]
  ];

  constructor() {
    super('mdx-transformer');
  }

  async init(bundler: Bundler): Promise<void> {

  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    const {content} = parseFrontmatter(ctx.code);
    const file = new VFile({
      path: ctx.module.filepath,
      value: content
    })
    try {
      const compilerOutput = await compile(file, {
        development: true,
        jsx: true,
        providerImportSource: '@immediately-run/sdk/MDXProvider',
        outputFormat: 'program',
        recmaPlugins: this.recmaPlugins,
        rehypePlugins: this.rehypePlugins,
        remarkPlugins: this.remarkPlugins
      })

      return {
        code: String(compilerOutput.value),
        // TODO: get required modeuls
        dependencies: new Set([]),
      };
    } catch (e) {
      const err = new BundlerError(String(e), ctx.module.filepath)
      if (e instanceof VFileMessage) {
        err.line = e.line;
        err.column = e.column;
        err.message = e.message;
      }
      return err
    }
  }
}
