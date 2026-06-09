import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import {
  EditorContext,
  DEFAULT_EDITOR_CONTEXT,
  EDITOR_CONTEXT_MESSAGE,
  editorContextsEqual,
} from './editorContextState';

/**
 * Caches the editor context (the dirty set, §5.3) the parent relays over
 * postMessage and exposes it to app code through the bundler, via the SDK's
 * getEditorContext / onEditorContextChange / useEditorContext. Mirrors
 * `ThemeService` / `AuthService`.
 *
 *  - `getContext()` — a pollable snapshot of the latest known context.
 *  - `onChange(listener)` — fires on every change and, BehaviorSubject-style,
 *    immediately replays the current value to a new listener.
 *
 * Instantiated as early as possible so an `editor-context` message that arrives
 * before the bundler exists is still captured. The parent only sends this message
 * to iframes holding `editor:read` (the channel ACL), so an app that never
 * receives one simply sees the default empty dirty set.
 */
export class EditorContextService {
  private context: EditorContext = DEFAULT_EDITOR_CONTEXT;
  private changeEmitter = new Emitter<EditorContext>();

  constructor(messageBus: IFrameParentMessageBus) {
    messageBus.onMessage((msg: any) => {
      if (msg && msg.type === EDITOR_CONTEXT_MESSAGE && Array.isArray(msg.dirtyPaths)) {
        const dirtyPaths = msg.dirtyPaths.filter((p: unknown): p is string => typeof p === 'string');
        // `activeFile` is newer than `dirtyPaths`; a non-string (or an older parent
        // that omits it) reads as `null` rather than rejecting the whole message.
        const activeFile = typeof msg.activeFile === 'string' ? msg.activeFile : null;
        this.setContext({ dirtyPaths, activeFile });
      }
    });
  }

  private setContext(next: EditorContext): void {
    if (editorContextsEqual(this.context, next)) {
      return;
    }
    this.context = next;
    this.changeEmitter.fire(next);
  }

  /** Pollable snapshot of the current editor context. */
  getContext(): EditorContext {
    return this.context;
  }

  /**
   * Subscribe to editor-context changes. The listener is invoked immediately with
   * the current context, then again on every change. Returns a disposable.
   */
  onChange(listener: (context: EditorContext) => void): IDisposable {
    const disposable = this.changeEmitter.event(listener);
    listener(this.context);
    return disposable;
  }
}
