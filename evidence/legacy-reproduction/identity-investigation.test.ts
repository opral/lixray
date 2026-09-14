import { expect, test, vi } from 'vitest';

vi.mock('#binding', () => {
  const session = () => ({
    activeAccountId: async () => '00000000-0000-7000-8000-000000000003',
    openAnotherSession: async () => session(),
    setTelemetryParent() {},
    close: async () => {},
  });
  return { openLixBinding: async () => session(), convertReplicaBinding: vi.fn(), retryReplicaMigrationCleanupBinding: vi.fn(), createHostedBinding: vi.fn(), deleteHostedBinding: vi.fn() };
});
import { startWorkerHost } from './host.js';
import { openRemoteLixBinding } from '../remote/client.js';
import type { WorkerInput, WorkerResponse } from './protocol.js';

const url = 'https://example.test/lix/00000000-0000-7000-8000-000000000004';

test('real remote WASM request lacks sync bridge metadata and fails before any fetch RPC', async () => {
  let receive!: (message: WorkerInput) => void;
  const messages: WorkerResponse[] = [];
  let original: unknown;
  let requestKeys: string[] = [];
  const done = Promise.withResolvers<void>();
  startWorkerHost({
    onMessage(listener) { receive = listener; },
    postMessage(message) { messages.push(message); if ('id' in message) done.resolve(); },
  }, async (_storage, _telemetry, _parent, server) => {
    return await openRemoteLixBinding({ url, headers: [], fetch: async (input, init) => {
      requestKeys = Object.keys(init ?? {});
      try { return await server!.fetch!(input, init); }
      catch (error) { original = error; throw error; }
    }});
  });
  receive({ id: 1, sessionId: 0, operation: { kind: 'open', storage: {kind: 'memory'}, telemetryEnabled: false, progressEnabled: false, server: {url, headers: [], customFetch: true, dynamicHeaders: false} } });
  await done.promise;
  expect(original).toBeInstanceOf(TypeError);
  expect((original as Error).message).toBe('Browser sync fetch has no valid response limit');
  expect(messages.filter(m => 'kind' in m && m.kind === 'sync.fetch')).toHaveLength(0);
  expect(requestKeys).not.toContain('lixResponseLimit');
  console.log(JSON.stringify({requestKeys, original: (original as Error).message, fetchRpcCount: 0}));
});

test('production shared entry admits first and same-token ports but rejects a refreshed token without making a fetch', async () => {
  await import('./entry.shared.browser.js');
  let fetchRpcCount = 0;
  async function attach(token: string) {
    const done = Promise.withResolvers<WorkerResponse>();
    const port = {
      onmessage: undefined as undefined | ((event: {data: WorkerInput}) => void),
      start() {}, close() {},
      postMessage(message: WorkerResponse) {
        if ('kind' in message && message.kind === 'sync.fetch') fetchRpcCount++;
        if ('id' in message) done.resolve(message);
      },
    };
    (globalThis as any).onconnect({ports: [port]});
    port.onmessage!({data: {id: 1, sessionId: 0, operation: {kind: 'open', storage: {kind: 'memory'}, telemetryEnabled: false, progressEnabled: false, server: {url, headers: [['Authorization', token]], customFetch: true, dynamicHeaders: false}}}});
    return await done.promise;
  }
  expect(await attach('Bearer initial')).toMatchObject({ok: true});
  expect(await attach('Bearer initial')).toMatchObject({ok: true});
  const refreshed = await attach('Bearer refreshed');
  expect(refreshed).toMatchObject({ok: false, error: {message: 'Shared identity probe could not reach the authority'}});
  expect(fetchRpcCount).toBe(0);
  console.log(JSON.stringify({first: 'opened', sameToken: 'opened', refreshed, fetchRpcCount}));
});

test('control: explicitly bounded remote request reaches the bridge and preserves an HTTP denial', async () => {
  let receive!: (message: WorkerInput) => void;
  let fetchRpcCount = 0;
  const done = Promise.withResolvers<any>();
  startWorkerHost({
    onMessage(listener) { receive = listener; },
    postMessage(message) {
      if ('kind' in message && message.kind === 'sync.fetch') {
        fetchRpcCount++;
        receive({kind: 'sync.fetch.result', requestId: message.requestId, result: {ok: true, response: {status: 401, statusText: 'Unauthorized', headers: [['content-type', 'application/json']], body: new TextEncoder().encode(JSON.stringify({code: 'AUTH_DENIED', message: 'Unauthorized'}))}}} as WorkerInput);
      }
      if ('id' in message) done.resolve(message);
    },
  }, async (_storage, _telemetry, _parent, server) => {
    return await openRemoteLixBinding({url, headers: [], fetch: (input, init) => server!.fetch!(input, {...init, lixResponseLimit: 1024 * 1024} as RequestInit)});
  });
  receive({id: 1, sessionId: 0, operation: {kind: 'open', storage: {kind: 'memory'}, telemetryEnabled: false, progressEnabled: false, server: {url, headers: [], customFetch: true, dynamicHeaders: false}}});
  const result = await done.promise;
  expect(fetchRpcCount).toBe(1);
  expect(result.ok).toBe(false);
  expect(result.error.message).not.toBe('Shared identity probe could not reach the authority');
});
