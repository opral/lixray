import { expect, test } from 'vitest';
test('actual Chromium SharedWorker produces the identity error before fetching when the credential changes', async () => {
  const name = 'identity-investigation-' + crypto.randomUUID();
  const workers: SharedWorker[] = [];
  let fetchRpcCount = 0;
  async function attach(token: string) {
    const worker = new SharedWorker(new URL('./entry.shared.browser.ts', import.meta.url), {type: 'module', name});
    workers.push(worker);
    return await new Promise<any>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message));
      worker.port.onmessage = ({data}) => {
        if (data.kind === 'sync.fetch') fetchRpcCount++;
        if (data.id === 1) resolve(data);
      };
      worker.port.start();
      worker.port.postMessage({id: 1, sessionId: 0, operation: {
        kind: 'open', storage: {kind: 'memory'}, telemetryEnabled: false, progressEnabled: false,
        server: {url: 'https://example.test/lix/00000000-0000-7000-8000-000000000004', headers: [['Authorization', token]], dynamicHeaders: false, customFetch: true},
      }});
    });
  }
  try {
    expect(await attach('Bearer initial')).toMatchObject({ok: true});
    expect(await attach('Bearer initial')).toMatchObject({ok: true});
    expect(await attach('Bearer refreshed')).toMatchObject({ok: false, error: {message: 'Shared identity probe could not reach the authority'}});
    expect(fetchRpcCount).toBe(0);
  } finally {
    for (const worker of workers) {worker.port.postMessage({kind: 'shared.disconnect'}); worker.port.close();}
  }
}, 30000);
