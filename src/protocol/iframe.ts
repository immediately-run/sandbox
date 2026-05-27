import { Emitter } from '../utils/emitter';
import { IInitConfig } from './message-types';

/**
 * A message bus to handle messaging with the parent
 * used when this code is ran inside the iframe
 * */
export class IFrameParentMessageBus {
  private parentId: number | null = null;
  private messageId = 0;

  private messageEmitter = new Emitter();
  onMessage = this.messageEmitter.event;

  private fsPort: MessagePort | null = null;
  private fsPortResolvers: Array<(port: MessagePort) => void> = [];

  private initConfig: IInitConfig | null = null;
  private initConfigResolvers: Array<(config: IInitConfig) => void> = [];

  constructor() {
    this._messageListener = this._messageListener.bind(this);

    window.addEventListener('message', this._messageListener);
  }

  private _messageListener(evt: MessageEvent) {
    const data = evt.data;

    if (data && data.type === 'register-frame') {
      this.parentId = data.id;

      // Bootstrap config rides on the same handshake message that transfers the
      // fs port. `register-frame` is handled before the `data.codesandbox` guard
      // and the parent omits that flag here, so read the fields directly.
      const config: IInitConfig = {
        template: data.template,
        logLevel: data.logLevel,
      };
      this.initConfig = config;
      const configResolvers = this.initConfigResolvers;
      this.initConfigResolvers = [];
      for (const resolve of configResolvers) {
        resolve(config);
      }

      const port = evt.ports && evt.ports[0];
      if (port) {
        port.start();
        this.fsPort = port;
        const resolvers = this.fsPortResolvers;
        this.fsPortResolvers = [];
        for (const resolve of resolvers) {
          resolve(port);
        }
      }
      return;
    }

    if (!data || !data.codesandbox) {
      return;
    }

    this.messageEmitter.fire(data);
  }

  /**
   * Resolves with the `MessagePort` transferred by the parent during `register-frame`.
   * The parent side is expected to have called zenfs's `RPC.attach` / `attachFS` on this port.
   */
  getFsPort(): Promise<MessagePort> {
    if (this.fsPort) {
      return Promise.resolve(this.fsPort);
    }
    return new Promise((resolve) => {
      this.fsPortResolvers.push(resolve);
    });
  }

  /**
   * Resolves with the bootstrap config (template/logLevel/recompileDelay)
   * delivered by the parent during `register-frame`.
   */
  getInitConfig(): Promise<IInitConfig> {
    if (this.initConfig) {
      return Promise.resolve(this.initConfig);
    }
    return new Promise((resolve) => {
      this.initConfigResolvers.push(resolve);
    });
  }

  _postMessage(message: any) {
    window.parent.postMessage(message, '*');
  }

  sendMessage(type: string, data: Record<string, any> = {}) {
    this._postMessage({
      ...data,
      $id: this.parentId,
      type,
      codesandbox: true,
    });
  }

  protocolRequest(protocolName: string, method: string, params: Array<any>): Promise<any> {
    const type = `protocol-${protocolName}`;
    const messageId = this.messageId++;
    return new Promise((resolve, reject) => {
      const disposable = this.onMessage((msg: any) => {
        if (msg.msgId === messageId && msg.type === type && !msg.method) {
          disposable.dispose();

          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result);
          }
        }
      });

      this.sendMessage(type, {
        msgId: messageId,
        method: method,
        params: params,
      });
    });
  }
}
