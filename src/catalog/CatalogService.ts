import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import {
  ApiMethod,
  DEFAULT_CATALOG,
  CATALOG_MESSAGE,
  catalogsEqual,
} from './catalogState';

/**
 * Caches the grant-filtered method catalog (§5.5) the parent relays over
 * postMessage and exposes it to app code through the bundler, via the SDK's
 * getCatalog / onCatalogChange / useCatalog. Mirrors ThemeService / AuthService /
 * EditorContextService.
 *
 *  - `getCatalog()` — a pollable snapshot of the latest known catalog.
 *  - `onChange(listener)` — fires on every change and, BehaviorSubject-style,
 *    immediately replays the current value to a new listener.
 *
 * Instantiated as early as possible so an `api-catalog` message that arrives
 * before the bundler exists is still captured.
 */
export class CatalogService {
  private catalog: ApiMethod[] = DEFAULT_CATALOG;
  private changeEmitter = new Emitter<ApiMethod[]>();

  constructor(messageBus: IFrameParentMessageBus) {
    messageBus.onMessage((msg: any) => {
      if (msg && msg.type === CATALOG_MESSAGE && Array.isArray(msg.methods)) {
        const methods = msg.methods.filter(
          (m: unknown): m is ApiMethod =>
            !!m && typeof (m as ApiMethod).name === 'string' && typeof (m as ApiMethod).capability === 'string',
        );
        this.setCatalog(methods);
      }
    });
  }

  private setCatalog(next: ApiMethod[]): void {
    if (catalogsEqual(this.catalog, next)) {
      return;
    }
    this.catalog = next;
    this.changeEmitter.fire(next);
  }

  /** Pollable snapshot of the current method catalog. */
  getCatalog(): ApiMethod[] {
    return this.catalog;
  }

  /**
   * Subscribe to catalog changes. The listener is invoked immediately with the
   * current catalog, then again on every change. Returns a disposable.
   */
  onChange(listener: (catalog: ApiMethod[]) => void): IDisposable {
    const disposable = this.changeEmitter.event(listener);
    listener(this.catalog);
    return disposable;
  }
}
