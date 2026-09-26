import type { CrawlError, CrawledImage, CrawledPage, CrawlJob } from './shared';

type Store = 'jobs' | 'pages' | 'images' | 'errors';
type RecordType = CrawlJob | CrawledPage | CrawledImage | CrawlError;

let databasePromise: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('vju-image-crawler', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('jobs', { keyPath: 'id' });
      for (const name of ['pages', 'images', 'errors']) {
        const store = db.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('jobId', 'jobId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

export async function put(store: Store, value: RecordType): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function get<T extends RecordType>(store: Store, id: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function list<T extends RecordType>(store: Store, jobId?: string): Promise<T[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const objectStore = db.transaction(store).objectStore(store);
    const request = jobId ? objectStore.index('jobId').getAll(jobId) : objectStore.getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

export async function count(store: Store, jobId?: string): Promise<number> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const objectStore = db.transaction(store).objectStore(store);
    const request = jobId ? objectStore.index('jobId').count(IDBKeyRange.only(jobId)) : objectStore.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function removeJob(id: string): Promise<void> {
  const db = await database();
  for (const name of ['pages', 'images', 'errors'] as Store[]) {
    const records = await list<RecordType>(name, id);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      for (const record of records) tx.objectStore(name).delete(record.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('jobs', 'readwrite');
    tx.objectStore('jobs').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
