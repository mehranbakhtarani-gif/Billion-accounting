import type { User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { ensurePasswordlessSession } from './supabaseEnrollment';

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
type Snapshot = { id: string; exists: () => boolean; data: () => Record<string, unknown> | undefined };
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
function snapshot(row: { legacy_record_id: string; payload: Record<string, unknown> } | null): Snapshot {
  return {
    id: row?.legacy_record_id ?? '',
    exists: () => !!row,
    data: () => row?.payload,
  };
}
function toSnapshot(row: { legacy_record_id: string; payload: Record<string, unknown> }): Snapshot {
  return snapshot(row);
}

async function fetchOne(ref: RecordRef) {
  const { data, error } = await supabase
    .from('billion_records')
    .select('legacy_record_id,payload')
    .eq('company_id', requireCompany())
    .eq('record_type', recordType(ref))
    .eq('legacy_record_id', ref.id)
    .maybeSingle();
  if (error) throw error;
  return data as { legacy_record_id: string; payload: Record<string, unknown> } | null;
}

async function fetchMany(ref: CollectionRef | QueryRef) {
  let request = supabase
    .from('billion_records')
    .select('legacy_record_id,payload')
    .eq('company_id', requireCompany())
    .eq('record_type', recordType(ref));
  const { data, error } = await request.order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ legacy_record_id: string; payload: Record<string, unknown> }>;
  const filters = ref.kind === 'query' ? ref.filters : [];
  const filtered = filters.length
    ? rows.filter((row) => filters.every((filter) => row.payload?.[filter.field] === filter.value))
    : rows;
  return filtered.map(toSnapshot);
}

async function applyChanges(changes: BatchChange[]) {
  const companyId = requireCompany();
  if (!changes.length) return;
  const { error } = await supabase.rpc('billion_apply_record_batch', {
    p_company_id: companyId,
    p_changes: changes,
  });
  if (error) throw error;
}

export async function getDoc(ref: RecordRef) {
  return snapshot(await fetchOne(ref));
}
export async function getDocs(ref: QueryRef) {
  const docs = await fetchMany(ref);
  return { docs, empty: docs.length === 0, size: docs.length } satisfies QuerySnapshot;
}
export async function setDoc(ref: RecordRef, payload: Record<string, unknown>) {
  await applyChanges([{
    action: 'set',
    record_type: ref.collection,
    legacy_record_id: ref.id,
    legacy_owner_id: String(payload.ownerId ?? auth.currentUser?.id ?? ''),
    payload,
  }]);
}
export async function updateDoc(ref: RecordRef, patch: Record<string, unknown>) {
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
    set(ref: RecordRef, payload: Record<string, unknown>) {
      changes.push({
        action: 'set',
        record_type: ref.collection,
        legacy_record_id: ref.id,
        legacy_owner_id: String(payload.ownerId ?? auth.currentUser?.id ?? ''),
        payload,
      });
    },
    update(ref: RecordRef, patch: Record<string, unknown>) {
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
  ref: RecordRef | QueryRef,
  onNext: (value: Snapshot | QuerySnapshot) => void,
  onError?: (error: unknown) => void,
) {
  let closed = false;
  const companyId = requireCompany();
  const channel = supabase
    .channel(`billion-records-${companyId}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'billion_records',
      filter: `company_id=eq.${companyId}`,
    }, () => { void refresh(); })
    .subscribe((status, error) => {
      if (error && onError) onError(error);
      if (status === 'CHANNEL_ERROR' && onError) onError(new Error('Supabase Realtime connection failed.'));
    });

  const refresh = async () => {
    if (closed) return;
    try {
      if (ref.kind === 'record') onNext(snapshot(await fetchOne(ref)));
      else {
        const docs = await fetchMany(ref);
        onNext({ docs, empty: docs.length === 0, size: docs.length });
      }
    } catch (error) {
      onError?.(error);
    }
  };
  void refresh();
  return () => {
    closed = true;
    void supabase.removeChannel(channel);
  };
}

export async function onAuthStateChanged(
  _auth: typeof auth,
  callback: (user: CloudUser | null) => void,
) {
  let alive = true;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    auth.currentUser = session?.user ?? null;
    if (alive) callback(auth.currentUser);
  });
  try {
    const session = await ensurePasswordlessSession();
    auth.currentUser = session.user;
    if (alive) callback(session.user);
  } catch (error) {
    if (alive) callback(null);
    console.error('Supabase passwordless authentication is not ready:', error);
  }
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
  return !error || !isSupabaseOfflineError(error);
}
