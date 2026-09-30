export type StoreDevToolsAction = {
  type: string;
  payload?: Record<string, unknown>;
  storeName?: string;
};

export type DevToolsEvent = StoreDevToolsAction;

export interface ProxyMetrics {
  signals: number;
  proxies: number;
  branchSubs: number;
}

export interface DevStream<T = DevToolsEvent> {
  subscribe(cb: (value: T) => void): { unsubscribe(): void };
  get(): T | null;
}

export interface SolidDevtoolsAdapter {
  readonly action$: DevStream;
  readonly readAction$: DevStream;
  emitAction(event: DevToolsEvent): void;
  emitRead(event: DevToolsEvent): void;
  emitProxyMetrics(storeName: string, metrics: ProxyMetrics): void;
  destroy(): void;
}

export const EMPTY_DEV_STREAM: DevStream = Object.freeze({
  subscribe: () => ({ unsubscribe() {} }),
  get: () => null,
});
