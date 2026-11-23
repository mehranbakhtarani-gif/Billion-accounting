-- Billion dedicated Supabase baseline.
-- Additive only: does not modify or remove the legacy Holoo workspace tables.
create extension if not exists pgcrypto with schema extensions;

create schema if not exists billion_private;
revoke all on schema billion_private from public, anon, authenticated;
create table if not exists billion_private.bootstrap_credentials (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint bootstrap_token_hash_hex check (token_hash ~ '^[0-9a-f]{64}$')
);
revoke all on billion_private.bootstrap_credentials from public, anon, authenticated, service_role;

create table if not exists public.billion_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  singleton boolean not null default true unique check (singleton),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.billion_company_members (
  company_id uuid not null references public.billion_companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (company_id,user_id),
  unique (user_id)
);
create table if not exists public.billion_company_devices (
  company_id uuid not null references public.billion_companies(id) on delete cascade,
  device_id text not null check (length(device_id) between 8 and 128),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_label text not null default '' check (length(device_label) <= 80),
  platform text not null check (platform in ('android','ios','web')),
  status text not null default 'active' check (status in ('active','revoked')),
  last_seen_at timestamptz,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (company_id,device_id),
  unique (user_id,device_id)
);
create table if not exists public.billion_company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.billion_companies(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  role text not null check (role in ('member','viewer')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users(id),
  used_device_id text
);
create table if not exists public.billion_records (
  company_id uuid not null references public.billion_companies(id) on delete cascade,
  record_type text not null check (record_type = any (array[
    'users','accounts','currencies','exchangeRates','parties','vouchers',
    'products','cheques','invoices','employees','assets','costCenters',
    'importDossiers','salesOrders','subcontractJobs','rbacOperators',
    'auditLogs','settings'
  ]::text[])),
  legacy_record_id text not null check (length(legacy_record_id) between 1 and 256),
  legacy_owner_id text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id,record_type,legacy_record_id)
);
create table if not exists public.billion_operation_log (
  operation_id uuid primary key,
  company_id uuid not null references public.billion_companies(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id),
  device_id text not null,
  device_sequence bigint not null check (device_sequence > 0),
  operation_type text not null,
  summary text not null,
  entity_changes jsonb not null,
  client_created_at timestamptz not null,
  server_applied_at timestamptz not null default clock_timestamp(),
  unique (company_id,device_id,device_sequence),
  foreign key (company_id,device_id) references public.billion_company_devices(company_id,device_id) on delete restrict
);

create index if not exists billion_records_company_type_created_idx
  on public.billion_records(company_id,record_type,created_at);
create index if not exists billion_devices_company_status_idx
  on public.billion_company_devices(company_id,status,last_seen_at desc);
create index if not exists billion_invites_company_expiry_idx
  on public.billion_company_invites(company_id,expires_at) where used_at is null;
create index if not exists billion_operation_log_company_time_idx
  on public.billion_operation_log(company_id,server_applied_at desc);

alter table public.billion_companies enable row level security;
alter table public.billion_company_members enable row level security;
alter table public.billion_company_devices enable row level security;
alter table public.billion_company_invites enable row level security;
alter table public.billion_records enable row level security;
alter table public.billion_operation_log enable row level security;

create policy billion_company_members_read_self on public.billion_company_members
  for select to authenticated using (user_id = (select auth.uid()));
create policy billion_companies_read_member on public.billion_companies
  for select to authenticated using (exists (
    select 1 from public.billion_company_members m
    where m.company_id = billion_companies.id and m.user_id = (select auth.uid())
  ));
create policy billion_devices_read_member on public.billion_company_devices
  for select to authenticated using (exists (
    select 1 from public.billion_company_members m
    where m.company_id = billion_company_devices.company_id and m.user_id = (select auth.uid())
  ));
create policy billion_records_read_member on public.billion_records
  for select to authenticated using (exists (
    select 1 from public.billion_company_members m
    where m.company_id = billion_records.company_id and m.user_id = (select auth.uid())
  ));
create policy billion_operation_log_read_member on public.billion_operation_log
  for select to authenticated using (exists (
    select 1 from public.billion_company_members m
    where m.company_id = billion_operation_log.company_id and m.user_id = (select auth.uid())
  ));

grant select on public.billion_companies, public.billion_company_members,
  public.billion_company_devices, public.billion_records, public.billion_operation_log
  to authenticated;
revoke all on public.billion_company_invites from anon, authenticated, public;

create or replace function public.billion_bootstrap_company(
  p_bootstrap_token text, p_user_id uuid, p_company_name text,
  p_device_id text, p_device_label text, p_platform text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, auth, extensions, billion_private, pg_temp
as $$
declare v_hash text; v_company_id uuid;
begin
  if current_setting('request.jwt.claim.role', true) <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_device_id is null or length(p_device_id) not between 8 and 128
     or p_platform not in ('android','ios','web') or length(coalesce(p_device_label,'')) > 80
     or length(trim(coalesce(p_company_name,''))) not between 1 and 160
     or length(coalesce(p_bootstrap_token,'')) < 32 then
    raise exception 'Invalid bootstrap request';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_bootstrap_token,'UTF8'),'sha256'),'hex');
  update billion_private.bootstrap_credentials set used_at = clock_timestamp()
    where token_hash = v_hash and used_at is null and expires_at > now();
  if not found then raise exception 'Invalid, expired, or already used bootstrap token' using errcode = '42501'; end if;
  if exists (select 1 from public.billion_companies) then raise exception 'Billion company has already been bootstrapped'; end if;
  insert into public.billion_companies(name,created_by) values (trim(p_company_name),p_user_id) returning id into v_company_id;
  insert into public.billion_company_members(company_id,user_id,role) values (v_company_id,p_user_id,'owner');
  insert into public.billion_company_devices(company_id,device_id,user_id,device_label,platform,last_seen_at)
    values (v_company_id,p_device_id,p_user_id,trim(p_device_label),p_platform,clock_timestamp());
  return v_company_id;
end;
$$;

create or replace function public.billion_accept_company_invite(
  p_invite_token text, p_user_id uuid, p_device_id text,
  p_device_label text, p_platform text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, auth, extensions, pg_temp
as $$
declare v_hash text; v_invite public.billion_company_invites%rowtype;
  v_company_id uuid; v_active_count integer;
begin
  if current_setting('request.jwt.claim.role', true) <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_device_id is null or length(p_device_id) not between 8 and 128
     or p_platform not in ('android','ios','web') or length(coalesce(p_device_label,'')) > 80
     or length(coalesce(p_invite_token,'')) < 32 then raise exception 'Invalid invite request'; end if;
  v_hash := encode(extensions.digest(convert_to(p_invite_token,'UTF8'),'sha256'),'hex');
  select * into v_invite from public.billion_company_invites where token_hash = v_hash for update;
  if not found or v_invite.used_at is not null or v_invite.expires_at <= now() then
    raise exception 'Invalid, expired, or already used invitation' using errcode = '42501';
  end if;
  select id into v_company_id from public.billion_companies where id = v_invite.company_id for update;
  if not found then raise exception 'Company no longer exists'; end if;
  if exists (select 1 from public.billion_company_members where user_id = p_user_id and company_id <> v_company_id) then
    raise exception 'This user already belongs to another company' using errcode = '42501';
  end if;
  select count(*) into v_active_count from public.billion_company_devices where company_id = v_company_id and status = 'active';
  if not exists (select 1 from public.billion_company_devices where company_id = v_company_id
    and device_id = p_device_id and user_id = p_user_id and status = 'active') and v_active_count >= 3 then
    raise exception 'Maximum of three active devices has been reached';
  end if;
  insert into public.billion_company_members(company_id,user_id,role)
    values (v_company_id,p_user_id,v_invite.role) on conflict (company_id,user_id) do nothing;
  insert into public.billion_company_devices(company_id,device_id,user_id,device_label,platform,status,last_seen_at)
    values (v_company_id,p_device_id,p_user_id,trim(p_device_label),p_platform,'active',clock_timestamp())
    on conflict (company_id,device_id) do update
      set device_label=excluded.device_label,platform=excluded.platform,last_seen_at=clock_timestamp()
      where public.billion_company_devices.user_id=excluded.user_id and public.billion_company_devices.status='active';
  if not found then raise exception 'Device is already enrolled by another user or revoked'; end if;
  update public.billion_company_invites set used_at=clock_timestamp(),used_by=p_user_id,used_device_id=p_device_id
    where id=v_invite.id and used_at is null;
  if not found then raise exception 'Invitation was consumed concurrently'; end if;
  return v_company_id;
end;
$$;

revoke all on function public.billion_bootstrap_company(text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.billion_bootstrap_company(text,uuid,text,text,text,text) to service_role;
revoke all on function public.billion_accept_company_invite(text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.billion_accept_company_invite(text,uuid,text,text,text) to service_role;
revoke all on function public.rls_auto_enable() from public,anon,authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='billion_records') then
    alter publication supabase_realtime add table public.billion_records;
  end if;
end $$;
