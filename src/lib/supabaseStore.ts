import type { User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { ensurePasswordlessSession } from './supabaseEnrollment';
import {
  acknowledgeLocalSyncOperation,
  cacheLocalRecordRevisions,
  enqueueLocalSyncOperation,
  getLocalRecordRevisions,
  getOrCreateLocalDeviceIdentity,
  listLocalSyncOutbox,
  loadLocalAccountingSnapshot,
  markLocalSyncOperationFailed,
} from './localAccountingStore';

export type CloudUser = User;
export const auth: { currentUser: CloudUser | null } = { currentUser: null };
export const db = Object.freeze({ provider: 'supabase' as const });

let activeCompanyId: string | null = null;
export function setActiveCompanyId(companyId: string | null) {
  activeCompanyId = companyId;
}

type RecordRef = { kind: 'record'; collection: string; id: string };
type CollectionRef = { kind: 'collection'; collection: string };
type QueryRef = { kind: 'query'; collection: string; filters: Array<{ field: string; value: unknown }> };
type Snapshot = { id: string; exists: () => boolean; data: () => Record<string, any> };
type QuerySnapshot = { docs: Snapshot[]; empty: boolean; size: number };
type BatchChange = Record<string, unknown>;

export function doc(_db: typeof db, collectionName: string, id: string): RecordRef {
  return { kind: 'record', collection: collectionName, id };
}
export function collection(_db: typeof db, collectionName: string): CollectionRef {
  return { kind: 'collection', collection: collectionName };
}
export function where(field: string, operator: string, value: unknown) {
  if (operator !== '==') throw new Error('Only equality filters are supported by the Supabase record adapter.');
  return { field, value };
}
export function query(ref: CollectionRef, ...filters: Array<{ field: string; value: unknown }>): QueryRef {
  return { kind: 'query', collection: ref.collection, filters };
}
export function serverTimestamp(): string {
  return new Date().toISOString();
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function requireCompany() {
  if (!activeCompanyId) throw new Error('این دستگاه هنوز به شرکت در Supabase متصل نشده است. ابتدا کد راه‌اندازی یا دعوت‌نامه را ثبت کنید.');
  return activeCompanyId;
}
function recordType(ref: { collection: string }) {
  return ref.collection;
}
function snapshot(row: { legacy_record_id: string; payload: Record<string, any> } | null): Snapshot {
  return {
    id: row?.legacy_record_id ?? '',
    exists: () => !!row,
    data: () => row?.payload ?? {},
  };
}
function toSnapshot(row: { legacy_record_id: string; payload: Record<string, unknown> }): Snapshot {
  return snapshot(row);
}

type PendingSyncPayload = {
  companyId: string;
  changes: BatchChange[];
  expectedRevisions: Record<string, number>;
};

const localChangeListeners = new Set<() => void>();
function notifyLocalChanges() {
  localChangeListeners.forEach((listener) => listener());
}
function subscribeLocalChanges(listener: () => void) {
  localChangeListeners.add(listener);
  return () => localChangeListeners.delete(listener);
}
function revisionKey(recordType: string, recordId: string) {
  return recordType + '\u0000' + recordId;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort()
      .map((key) => JSON.stringify(key) + ':' + stableJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
async function readPendingChanges(companyId: string): Promise<BatchChange[]> {
  const pending = await listLocalSyncOutbox();
  return pending
    .filter((item) => item.state === 'queued' && (item.payload as PendingSyncPayload)?.companyId === companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((item) => (item.payload as PendingSyncPayload).changes);
}
async function overlayPendingRows(
  rows: Array<{ legacy_record_id: string; payload: Record<string, any>; revision?: number }>,
  collectionName: string,
  companyId: string,
) {
  const byId = new Map(rows.map((row) => [row.legacy_record_id, row]));
  const pending = await listLocalSyncOutbox();
  const operations = pending
    .filter((item) => item.state === 'queued' && (item.payload as PendingSyncPayload)?.companyId === companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const operation of operations) {
    const payload = operation.payload as PendingSyncPayload;
    for (const change of payload.changes) {
      if (String(change.record_type) !== collectionName) continue;
      const id = String(change.legacy_record_id);
      const existing = byId.get(id);
      if (change.action === 'delete') {
        byId.delete(id);
      } else if (change.action === 'set') {
        byId.set(id, { legacy_record_id: id, payload: (change.payload ?? {}) as Record<string, any>, revision: existing?.revision });
      } else if (change.action === 'patch' && existing) {
        byId.set(id, { ...existing, payload: { ...existing.payload, ...(change.payload as Record<string, any>) } });
      }
    }
  }
  return [...byId.values()];
}
async function readLocalCollection(collectionName: string) {
  const local = await loadLocalAccountingSnapshot();
  const records = local?.[collectionName];
  if (!Array.isArray(records)) return [];
  return records.map((record: any) => ({
    legacy_record_id: String(record.id ?? ''),
    payload: record as Record<string, any>,
  })).filter((record) => record.legacy_record_id);
}

async function fetchOne(ref: RecordRef) {
  const companyId = requireCompany();
  let row: { legacy_record_id: string; payload: Record<string, any>; revision?: number } | null = null;
  try {
    const { data, error } = await supabase
      .from('billion_records')
      .select('legacy_record_id,payload,revision')
      .eq('company_id', companyId)
      .eq('record_type', recordType(ref))
      .eq('legacy_record_id', ref.id)
      .maybeSingle();
    if (error) throw error;
    row = data as typeof row;
    if (row?.revision !== undefined) {
      await cacheLocalRecordRevisions([{
        key: revisionKey(ref.collection, ref.id),
        recordType: ref.collection,
        recordId: ref.id,
        revision: Number(row.revision),
      }]);
    }
  } catch (error) {
    if (!isSupabaseOfflineError(error)) throw error;
    const localRows = await readLocalCollection(ref.collection);
    row = localRows.find((candidate) => candidate.legacy_record_id === ref.id) ?? null;
  }
  const rows = await overlayPendingRows(row ? [row] : [], ref.collection, companyId);
  return rows.find((candidate) => candidate.legacy_record_id === ref.id) ?? null;
}

async function fetchMany(ref: CollectionRef | QueryRef) {
  const companyId = requireCompany();
  let rows: Array<{ legacy_record_id: string; payload: Record<string, any>; revision?: number }>;
  try {
    const { data, error } = await supabase
      .from('billion_records')
      .select('legacy_record_id,payload,revision')
      .eq('company_id', companyId)
      .eq('record_type', recordType(ref))
      .order('created_at', { ascending: true });
    if (error) throw error;
    rows = (data ?? []) as typeof rows;
    await cacheLocalRecordRevisions(rows.filter((row) => row.revision !== undefined).map((row) => ({
      key: revisionKey(recordType(ref), row.legacy_record_id),
      recordType: recordType(ref),
      recordId: row.legacy_record_id,
      revision: Number(row.revision),
    })));
  } catch (error) {
    if (!isSupabaseOfflineError(error)) throw error;
    rows = await readLocalCollection(recordType(ref));
  }
  const overlaid = await overlayPendingRows(rows, recordType(ref), companyId);
  const filters = ref.kind === 'query' ? ref.filters : [];
  // The authenticated company membership is the security boundary. Legacy ownerId filters are ignored.
  void filters;
  return overlaid.map(toSnapshot);
}

async function queueOfflineChanges(
  companyId: string,
  changes: BatchChange[],
  expectedRevisions: Record<string, number>,
) {
  const identity = await getOrCreateLocalDeviceIdentity();
  const operationId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'offline-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  await enqueueLocalSyncOperation<PendingSyncPayload>({
    operationId,
    idempotencyKey: operationId,
    deviceId: identity.deviceId,
    createdAt: new Date().toISOString(),
    payload: { companyId, changes, expectedRevisions },
  });
  notifyLocalChanges();
}

async function changesAlreadyApplied(companyId: string, changes: BatchChange[]): Promise<boolean> {
  const recordTypes = [...new Set(changes.map((change) => String(change.record_type)))];
  const recordIds = [...new Set(changes.map((change) => String(change.legacy_record_id)))];
  const { data, error } = await supabase
    .from('billion_records')
    .select('record_type,legacy_record_id,payload,revision')
    .eq('company_id', companyId)
    .in('record_type', recordTypes)
    .in('legacy_record_id', recordIds);
  if (error) throw error;
  const rows = new Map((data ?? []).map((row: any) => [
    revisionKey(row.record_type, row.legacy_record_id), row,
  ]));
  return changes.every((change) => {
    const row = rows.get(revisionKey(String(change.record_type), String(change.legacy_record_id))) as any;
    if (change.action === 'delete') return !row;
    if (!row) return false;
    if (change.action === 'set') return stableJson(row.payload) === stableJson(change.payload);
    const patch = (change.payload ?? {}) as Record<string, unknown>;
    return Object.entries(patch).every(([key, value]) => stableJson(row.payload?.[key]) === stableJson(value));
  });
}

async function applyChanges(
  changes: BatchChange[],
  options: { allowQueue?: boolean; expectedRevisions?: Record<string, number> } = {},
) {
  const companyId = requireCompany();
  if (!changes.length) return;

  const identities = new Set<string>();
  for (const change of changes) {
    const type = String(change.record_type ?? '');
    const id = String(change.legacy_record_id ?? '');
    const key = revisionKey(type, id);
    if (!type || !id || identities.has(key)) {
      throw new Error('یک رکورد در بستهٔ ذخیره‌سازی بیش از یک بار تغییر داده شده است. عملیات را جداگانه انجام دهید.');
    }
    identities.add(key);
  }

  let expectedRevisions = options.expectedRevisions;
  if (!expectedRevisions) {
    try {
      const recordTypes = [...new Set(changes.map((change) => String(change.record_type)))];
      const recordIds = [...new Set(changes.map((change) => String(change.legacy_record_id)))];
      const { data: currentRows, error: readError } = await supabase
        .from('billion_records')
        .select('record_type,legacy_record_id,revision')
        .eq('company_id', companyId)
        .in('record_type', recordTypes)
        .in('legacy_record_id', recordIds);
      if (readError) throw readError;
      const revisions = new Map((currentRows ?? []).map((row: any) => [
        revisionKey(row.record_type, row.legacy_record_id), Number(row.revision),
      ]));
      expectedRevisions = Object.fromEntries(changes.map((change) => {
        const key = revisionKey(String(change.record_type), String(change.legacy_record_id));
        return [key, revisions.get(key) ?? 0];
      }));
      await cacheLocalRecordRevisions((currentRows ?? []).map((row: any) => ({
        key: revisionKey(row.record_type, row.legacy_record_id),
        recordType: row.record_type,
        recordId: row.legacy_record_id,
        revision: Number(row.revision),
      })));
    } catch (error) {
      if (options.allowQueue === false || !isSupabaseOfflineError(error)) throw error;
      const keys = changes.map((change) => revisionKey(String(change.record_type), String(change.legacy_record_id)));
      const cached = await getLocalRecordRevisions(keys);
      expectedRevisions = Object.fromEntries(changes.map((change) => {
        const key = revisionKey(String(change.record_type), String(change.legacy_record_id));
        const revision = cached.get(key);
        if (revision === undefined && change.action !== 'set') {
          throw new Error('برای تغییر آفلاین این رکورد، نسخهٔ قبلی از سرور در حافظه نیست. ابتدا یک‌بار با اینترنت همگام‌سازی کنید؛ هیچ تغییری ثبت نشد.');
        }
        return [key, revision ?? 0];
      }));
      await queueOfflineChanges(companyId, changes, expectedRevisions);
      return;
    }
  }

  const versionedChanges = changes.map((change) => {
    const key = revisionKey(String(change.record_type), String(change.legacy_record_id));
    const expected = expectedRevisions?.[key];
    if (expected === undefined) throw new Error('نسخهٔ مبنای رکورد برای همگام‌سازی مشخص نیست؛ عملیات متوقف شد.');
    return { ...change, expected_revision: expected };
  });

  try {
    const { error } = await supabase.rpc('billion_apply_record_batch', {
      p_company_id: companyId,
      p_changes: versionedChanges,
    });
    if (error) throw error;
    await cacheLocalRecordRevisions(changes
      .filter((change) => change.action !== 'delete')
      .map((change) => {
        const key = revisionKey(String(change.record_type), String(change.legacy_record_id));
        return {
          key,
          recordType: String(change.record_type),
          recordId: String(change.legacy_record_id),
          revision: (expectedRevisions as Record<string, number>)[key] + 1,
        };
      }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('BILLION_CONCURRENCY_CONFLICT')) {
      throw new Error('این رکورد روی دستگاه دیگری تغییر کرده است. اطلاعات تازه را دریافت و تغییر خود را دوباره اعمال کنید؛ دادهٔ دستگاه دیگر بازنویسی نشد.');
    }
    if (options.allowQueue !== false && isSupabaseOfflineError(error)) {
      await queueOfflineChanges(companyId, changes, expectedRevisions);
      return;
    }
    throw error;
  }
}

export async function flushLocalSyncOutbox(): Promise<{ synced: number; failed: number }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { synced: 0, failed: 0 };
  const companyId = requireCompany();
  const pending = await listLocalSyncOutbox();
  let synced = 0;
  let failed = 0;
  for (const operation of pending
    .filter((item) => item.state === 'queued' && (item.payload as PendingSyncPayload)?.companyId === companyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const payload = operation.payload as PendingSyncPayload;
    try {
      await applyChanges(payload.changes, { allowQueue: false, expectedRevisions: payload.expectedRevisions });
      await acknowledgeLocalSyncOperation(operation.idempotencyKey);
      synced += 1;
      notifyLocalChanges();
    } catch (error) {
      if (isSupabaseOfflineError(error)) break;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('تغییر کرده است')) {
        try {
          if (await changesAlreadyApplied(companyId, payload.changes)) {
            await acknowledgeLocalSyncOperation(operation.idempotencyKey);
            synced += 1;
            notifyLocalChanges();
            continue;
          }
        } catch (verificationError) {
          if (isSupabaseOfflineError(verificationError)) break;
        }
      }
      await markLocalSyncOperationFailed(operation.idempotencyKey, message);
      failed += 1;
      notifyLocalChanges();
    }
  }
  return { synced, failed };
}

export async function getDoc(ref: RecordRef) {
  return snapshot(await fetchOne(ref));
}
export async function getDocs(ref: QueryRef) {
  const docs = await fetchMany(ref);
  return { docs, empty: docs.length === 0, size: docs.length } satisfies QuerySnapshot;
}
export async function setDoc(ref: RecordRef, payload: any) {
  await applyChanges([{
    action: 'set',
    record_type: ref.collection,
    legacy_record_id: ref.id,
    legacy_owner_id: String(payload.ownerId ?? auth.currentUser?.id ?? ''),
    payload,
  }]);
}
export async function updateDoc(ref: RecordRef, patch: any) {
  await applyChanges([{
    action: 'patch',
    record_type: ref.collection,
    legacy_record_id: ref.id,
    payload: patch,
  }]);
}
export async function deleteDoc(ref: RecordRef) {
  await applyChanges([{
    action: 'delete',
    record_type: ref.collection,
    legacy_record_id: ref.id,
  }]);
}

export function writeBatch(_db: typeof db) {
  const changes: BatchChange[] = [];
  return {
    set(ref: RecordRef, payload: any) {
      changes.push({
        action: 'set',
        record_type: ref.collection,
        legacy_record_id: ref.id,
        legacy_owner_id: String(payload.ownerId ?? auth.currentUser?.id ?? ''),
        payload,
      });
    },
    update(ref: RecordRef, patch: any) {
      changes.push({
        action: 'patch',
        record_type: ref.collection,
        legacy_record_id: ref.id,
        payload: patch,
      });
    },
    delete(ref: RecordRef) {
      changes.push({
        action: 'delete',
        record_type: ref.collection,
        legacy_record_id: ref.id,
      });
    },
    commit() {
      return applyChanges(changes);
    },
  };
}

export function onSnapshot(
  ref: RecordRef,
  onNext: (value: Snapshot) => void,
  onError?: (error: unknown) => void,
): () => void;
export function onSnapshot(
  ref: QueryRef,
  onNext: (value: QuerySnapshot) => void,
  onError?: (error: unknown) => void,
): () => void;
export function onSnapshot(
  ref: RecordRef | QueryRef,
  onNext: (value: any) => void,
  onError?: (error: unknown) => void,
): () => void {
  let closed = false;
  const companyId = requireCompany();
  const refresh = async () => {
    if (closed) return;
    try {
      if (ref.kind === 'record') onNext(snapshot(await fetchOne(ref)));
      else {
        const docs = await fetchMany(ref);
        onNext({ docs, empty: docs.length === 0, size: docs.length });
      }
    } catch (error) { onError?.(error); }
  };
  const unsubscribeLocal = subscribeLocalChanges(() => { void refresh(); });
  const channel = supabase.channel('billion-records-' + companyId + '-' + Math.random().toString(36).slice(2))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'billion_records', filter: 'company_id=eq.' + companyId }, () => { void refresh(); })
    .subscribe((status, error) => {
      if (error && onError) onError(error);
      if (status === 'CHANNEL_ERROR' && onError) onError(new Error('Supabase Realtime connection failed.'));
    });
  void refresh();
  return () => { closed = true; unsubscribeLocal(); void supabase.removeChannel(channel); };
}

export function onAuthStateChanged(
  _auth: typeof auth,
  callback: (user: CloudUser | null) => void,
) {
  let alive = true;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    auth.currentUser = session?.user ?? null;
    if (alive) callback(auth.currentUser);
  });
  void ensurePasswordlessSession().then((session) => {
    auth.currentUser = session.user;
    if (alive) callback(session.user);
  }).catch((error) => {
    if (alive) callback(null);
    console.error('Supabase passwordless authentication is not ready:', error);
  });
  return () => {
    alive = false;
    data.subscription.unsubscribe();
  };
}

export async function signOutAccount() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  auth.currentUser = null;
}
export function isSupabaseOfflineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return typeof navigator !== 'undefined' && !navigator.onLine ||
    /fetch failed|network|timeout|offline|failed to fetch/i.test(message);
}
export function handleSupabaseError(error: unknown, operationType: OperationType, path: string | null): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Supabase accounting error:', { operationType, path, message });
  throw new Error(message);
}
export async function testSupabaseConnection(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  const { error } = await supabase.from('billion_companies').select('id').limit(1);
  return !error;
}
