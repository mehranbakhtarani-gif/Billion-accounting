const DATABASE_NAME = 'holoo-accounting-local';
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'primary-company';
const DATABASE_VERSION = 1;

export type LocalAccountingSnapshot = Record<string, unknown>;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this runtime.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local database.'));
  });
}

export async function loadLocalAccountingSnapshot(): Promise<LocalAccountingSnapshot | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
      request.onsuccess = () => resolve((request.result as LocalAccountingSnapshot | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Could not read local accounting data.'));
    });
  } finally {
    database.close();
  }
}

export async function saveLocalAccountingSnapshot(snapshot: LocalAccountingSnapshot): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(snapshot, SNAPSHOT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save local accounting data.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local accounting save was aborted.'));
    });
  } finally {
    database.close();
  }
}
