import { supabase } from './supabaseClient';

export interface SupabaseCompanyMembership {
  company_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export type BillionDevicePlatform = 'android' | 'ios' | 'web';

export async function ensurePasswordlessSession() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session) return sessionData.session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(`ورود بدون رمز عبور در Supabase فعال نیست یا انجام نشد: ${error.message}`);
  if (!data.session) throw new Error('نشست امن Supabase ایجاد نشد.');
  return data.session;
}

export async function getBillionMembership(): Promise<SupabaseCompanyMembership | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;
  const { data, error } = await supabase
    .from('billion_company_members')
    .select('company_id, role')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw error;
  return data as SupabaseCompanyMembership | null;
}

async function callEnrollment(payload: Record<string, unknown>, headers?: Record<string, string>) {
  const { data, error } = await supabase.functions.invoke('billion-enrollment', {
    body: payload,
    headers,
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data as Record<string, unknown>;
}

export async function acceptBillionInvite(input: {
  token: string;
  deviceId: string;
  deviceLabel: string;
  platform: BillionDevicePlatform;
}) {
  await ensurePasswordlessSession();
  return callEnrollment({
    action: 'accept_invite',
    invite_token: input.token.trim(),
    device_id: input.deviceId,
    device_label: input.deviceLabel,
    platform: input.platform,
  });
}

export async function bootstrapBillionCompany(input: {
  bootstrapToken: string;
  companyName: string;
  deviceId: string;
  deviceLabel: string;
  platform: BillionDevicePlatform;
}) {
  await ensurePasswordlessSession();
  return callEnrollment({
    action: 'bootstrap',
    company_name: input.companyName,
    device_id: input.deviceId,
    device_label: input.deviceLabel,
    platform: input.platform,
  }, { 'x-billion-bootstrap-token': input.bootstrapToken.trim() });
}

export async function createBillionInvite(role: 'member' | 'viewer' = 'member') {
  await ensurePasswordlessSession();
  return callEnrollment({ action: 'create_invite', role });
}
