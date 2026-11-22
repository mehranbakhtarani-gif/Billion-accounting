const DATABASE_NAME = 'holoo-accounting-local';
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'primary-company';
const OUTBOX_STORE = 'sync_outbox';
const REVISION_STORE = 'record_revisions';
const DEVICE_IDENTITY_KEY = 'local-device-identity';
const DATABASE_VERSION = 3;

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
      if (!database.objectStoreNames.contains(REVISION_STORE)) {
        database.createObjectStore(REVISION_STORE, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        const outbox = database.createObjectStore(OUTBOX_STORE, { keyPath: 'idempotencyKey' });
        outbox.createIndex('operationId', 'operationId', { unique: true });
        outbox.createIndex('state', 'state', { unique: false });
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


export interface LocalRecordRevision {
  key: string;
  recordType: string;
  recordId: string;
  revision: number;
}

export async function cacheLocalRecordRevisions(records: LocalRecordRevision[]): Promise<void> {
  if (!records.length) return;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(REVISION_STORE, 'readwrite');
      const store = transaction.objectStore(REVISION_STORE);
      records.forEach((record) => store.put(record));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('ذخیره نسخه رکوردهای محلی ناموفق بود.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('ذخیره نسخه رکوردهای محلی لغو شد.'));
    });
  } finally {
    database.close();
  }
}

export async function getLocalRecordRevisions(keys: string[]): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(REVISION_STORE, 'readonly');
      const store = transaction.objectStore(REVISION_STORE);
      const results = new Map<string, number>();
      let remaining = keys.length;
      keys.forEach((key) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result as LocalRecordRevision | undefined;
          if (record) results.set(key, record.revision);
          remaining -= 1;
          if (remaining === 0) resolve(results);
        };
        request.onerror = () => reject(request.error ?? new Error('خواندن نسخه رکورد محلی ناموفق بود.'));
      });
    });
  } finally {
    database.close();
  }
}

export interface LocalDeviceIdentity {
  deviceId: string;
  createdAt: string;
}

export interface LocalSyncOutboxRecord<T = unknown> {
  operationId: string;
  idempotencyKey: string;
  deviceId: string;
  createdAt: string;
  state: 'queued' | 'failed' | 'acknowledged';
  attempts: number;
  payload: T;
  lastError?: string;
  acknowledgedAt?: string;
}

function createLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Creates one stable installation identity in IndexedDB. This ID is metadata,
 * not an authentication credential and must never be used to authorize writes.
 */
export async function getOrCreateLocalDeviceIdentity(): Promise<LocalDeviceIdentity> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(DEVICE_IDENTITY_KEY);
      let identity: LocalDeviceIdentity | undefined;
      request.onsuccess = () => {
        identity = request.result as LocalDeviceIdentity | undefined;
        if (!identity?.deviceId) {
          identity = { deviceId: createLocalId(), createdAt: new Date().toISOString() };
          store.put(identity, DEVICE_IDENTITY_KEY);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('شناسه دستگاه خوانده نشد.'));
      transaction.oncomplete = () => resolve(identity as LocalDeviceIdentity);
      transaction.onerror = () => reject(transaction.error ?? new Error('ذخیره شناسه دستگاه ناموفق بود.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('ساخت شناسه دستگاه لغو شد.'));
    });
  } finally {
    database.close();
  }
}

/** Adds an offline operation once. Reusing an idempotency key never overwrites its payload. */
export async function enqueueLocalSyncOperation<T>(
  record: Omit<LocalSyncOutboxRecord<T>, 'state' | 'attempts'>,
): Promise<{ inserted: boolean; record: LocalSyncOutboxRecord<T> }> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
      const store = transaction.objectStore(OUTBOX_STORE);
      const request = store.get(record.idempotencyKey);
      let result: { inserted: boolean; record: LocalSyncOutboxRecord<T> } | undefined;
      request.onsuccess = () => {
        const existing = request.result as LocalSyncOutboxRecord<T> | undefined;
        if (existing) {
          if (existing.operationId !== record.operationId) {
            transaction.abort();
            reject(new Error('کلید جلوگیری از ثبت تکراری قبلاً برای عملیات دیگری استفاده شده است.'));
            return;
          }
          result = { inserted: false, record: existing };
          return;
        }
        const next: LocalSyncOutboxRecord<T> = { ...record, state: 'queued', attempts: 0 };
        store.add(next);
        result = { inserted: true, record: next };
      };
      request.onerror = () => reject(request.error ?? new Error('صف همگام‌سازی خوانده نشد.'));
      transaction.oncomplete = () => {
        if (result) resolve(result);
        else reject(new Error('عملیات در صف همگام‌سازی ذخیره نشد.'));
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('ذخیره عملیات همگام‌سازی ناموفق بود.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('ثبت عملیات همگام‌سازی لغو شد.'));
    });
  } finally {
    database.close();
  }
}

export async function listLocalSyncOutbox(
  includeAcknowledged = false,
): Promise<LocalSyncOutboxRecord[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, 'readonly');
      const request = transaction.objectStore(OUTBOX_STORE).getAll();
      request.onsuccess = () => {
        const rows = request.result as LocalSyncOutboxRecord[];
        resolve(includeAcknowledged ? rows : rows.filter((row) => row.state !== 'acknowledged'));
      };
      request.onerror = () => reject(request.error ?? new Error('صف همگام‌سازی خوانده نشد.'));
    });
  } finally {
    database.close();
  }
}

/** Advances later queued operations after an earlier local operation is confirmed committed. */
export async function rebaseQueuedLocalSyncOperations(
  companyId: string,
  revisionUpdates: Record<string, number>,
): Promise<void> {
  const keys = Object.keys(revisionUpdates);
  if (!keys.length) return;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
      const store = transaction.objectStore(OUTBOX_STORE);
      const request = store.getAll();
      request.onsuccess = () => {
        const rows = request.result as LocalSyncOutboxRecord<any>[];
        rows.forEach((record) => {
          if (record.state !== 'queued' || record.payload?.companyId !== companyId) return;
          let changed = false;
          const expectedRevisions = { ...(record.payload.expectedRevisions ?? {}) };
          for (const key of keys) {
            const belongsToOperation = (record.payload.changes ?? []).some((change: any) =>
              String(change.record_type) + '\u0000' + String(change.legacy_record_id) === key);
            if (belongsToOperation) {
              expectedRevisions[key] = revisionUpdates[key];
              changed = true;
            }
          }
          if (changed) store.put({ ...record, payload: { ...record.payload, expectedRevisions } });
        });
      };
      request.onerror = () => reject(request.error ?? new Error('خواندن صف برای تنظیم نسخه عملیات‌های بعدی ناموفق بود.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('تنظیم نسخه عملیات‌های بعدی ناموفق بود.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('تنظیم نسخه عملیات‌های بعدی لغو شد.'));
    });
  } finally {
    database.close();
  }
}

export async function markLocalSyncOperationFailed(
  idempotencyKey: string,
  errorMessage: string,
): Promise<void> {
  await updateOutboxRecord(idempotencyKey, (record) => ({
    ...record,
    state: 'failed',
    attempts: record.attempts + 1,
    lastError: errorMessage.slice(0, 1000),
  }));
}

export async function acknowledgeLocalSyncOperation(idempotencyKey: string): Promise<void> {
  await updateOutboxRecord(idempotencyKey, (record) => ({
    ...record,
    state: 'acknowledged',
    acknowledgedAt: new Date().toISOString(),
    lastError: undefined,
  }));
}

async function updateOutboxRecord(
  idempotencyKey: string,
  update: (record: LocalSyncOutboxRecord) => LocalSyncOutboxRecord,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
      const store = transaction.objectStore(OUTBOX_STORE);
      const request = store.get(idempotencyKey);
      request.onsuccess = () => {
        const record = request.result as LocalSyncOutboxRecord | undefined;
        if (!record) {
          transaction.abort();
          reject(new Error('عملیات موردنظر در صف همگام‌سازی وجود ندارد.'));
          return;
        }
        store.put(update(record));
      };
      request.onerror = () => reject(request.error ?? new Error('عملیات صف همگام‌سازی خوانده نشد.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('به‌روزرسانی صف همگام‌سازی ناموفق بود.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('به‌روزرسانی صف همگام‌سازی لغو شد.'));
    });
  } finally {
    database.close();
  }
}
