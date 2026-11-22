-- Additive device-aware synchronization and append-only operation journal.
-- Existing company, membership, device, and record data are preserved.

alter table public.billion_company_devices
  add column if not exists last_sequence bigint not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.billion_company_devices'::regclass
      and conname = 'billion_company_devices_last_sequence_check'
  ) then
    alter table public.billion_company_devices
      add constraint billion_company_devices_last_sequence_check check (last_sequence >= 0);
  end if;
end;
$$;

create index if not exists billion_operation_log_company_device_time_idx
  on public.billion_operation_log (company_id, device_id, server_applied_at desc);

create or replace function public.billion_touch_device(
  p_company_id uuid,
  p_device_id text
)
returns timestamptz
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_last_seen timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.billion_company_members m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
  ) then
    raise exception 'Company membership required' using errcode = '42501';
  end if;

  update public.billion_company_devices
  set last_seen_at = clock_timestamp()
  where company_id = p_company_id
    and user_id = auth.uid()
    and device_id = p_device_id
    and status = 'active'
  returning last_seen_at into v_last_seen;

  if not found then
    raise exception 'Active device enrollment required' using errcode = '42501';
  end if;

  return v_last_seen;
end;
$function$;

create or replace function public.billion_apply_record_batch(
  p_company_id uuid,
  p_changes jsonb,
  p_device_id text,
  p_operation_id uuid,
  p_client_created_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_change jsonb;
  v_count integer := 0;
  v_change_count integer;
  v_unique_count integer;
  v_action text;
  v_type text;
  v_legacy_id text;
  v_expected_revision bigint;
  v_device_sequence bigint;
  v_entity_changes jsonb;
  v_existing_log public.billion_operation_log%rowtype;
begin
  if auth.uid() is null or p_company_id is null or p_device_id is null
     or length(p_device_id) < 8 or length(p_device_id) > 128
     or p_operation_id is null or p_client_created_at is null then
    raise exception 'Invalid device-aware batch request';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'Invalid batch request';
  end if;

  v_change_count := jsonb_array_length(p_changes);
  if v_change_count < 1 or v_change_count > 500 then
    raise exception 'Invalid batch size';
  end if;

  if not exists (
    select 1 from public.billion_company_members m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin', 'member')
  ) then
    raise exception 'Company membership required' using errcode = '42501';
  end if;

  select count(distinct jsonb_build_array(
    item->>'record_type',
    item->>'legacy_record_id'
  ))
  into v_unique_count
  from jsonb_array_elements(p_changes) as changes(item);

  if v_unique_count <> v_change_count then
    raise exception 'Duplicate record identity in batch';
  end if;

  select jsonb_build_object(
    'fingerprint', md5(p_changes::text),
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'action', item->>'action',
      'record_type', item->>'record_type',
      'legacy_record_id', item->>'legacy_record_id',
      'expected_revision', item->>'expected_revision'
    ) order by ordinal), '[]'::jsonb)
  )
  into v_entity_changes
  from jsonb_array_elements(p_changes) with ordinality as changes(item, ordinal);

  select *
  into v_existing_log
  from public.billion_operation_log
  where operation_id = p_operation_id;

  if found then
    if v_existing_log.company_id = p_company_id
       and v_existing_log.actor_user_id = auth.uid()
       and v_existing_log.device_id = p_device_id
       and v_existing_log.entity_changes = v_entity_changes then
      return v_change_count;
    end if;
    raise exception 'Operation id was already used for a different batch';
  end if;

  update public.billion_company_devices
  set last_seen_at = clock_timestamp(),
      last_sequence = last_sequence + 1
  where company_id = p_company_id
    and user_id = auth.uid()
    and device_id = p_device_id
    and status = 'active'
  returning last_sequence into v_device_sequence;

  if not found then
    raise exception 'Active device enrollment required' using errcode = '42501';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_action := v_change->>'action';
    v_type := v_change->>'record_type';
    v_legacy_id := v_change->>'legacy_record_id';

    if v_type is null or v_type not in (
      'users','accounts','currencies','exchangeRates','parties','vouchers',
      'products','cheques','invoices','employees','assets','costCenters',
      'importDossiers','salesOrders','subcontractJobs','rbacOperators',
      'auditLogs','settings','inventoryLots','inventoryLotMovements'
    ) or length(coalesce(v_legacy_id,'')) < 1 or length(v_legacy_id) > 256 then
      raise exception 'Invalid record identity';
    end if;

    if v_action is null or v_action not in ('set', 'patch', 'delete') then
      raise exception 'Unsupported batch action';
    end if;

    if v_action in ('set', 'patch')
       and jsonb_typeof(coalesce(v_change->'payload', '{}'::jsonb)) <> 'object' then
      raise exception 'Record payload must be a JSON object';
    end if;

    if v_type = 'inventoryLotMovements' and v_action <> 'set' then
      raise exception 'Inventory lot movements are append-only';
    end if;

    if coalesce(v_change->>'expected_revision','') !~ '^(0|[1-9][0-9]*)$' then
      raise exception 'Expected revision is required';
    end if;
    v_expected_revision := (v_change->>'expected_revision')::bigint;

    if v_action = 'set' then
      if v_expected_revision = 0 then
        insert into public.billion_records(
          company_id, record_type, legacy_record_id, legacy_owner_id,
          payload, created_by, updated_by, revision
        )
        values (
          p_company_id, v_type, v_legacy_id, v_change->>'legacy_owner_id',
          coalesce(v_change->'payload','{}'::jsonb), auth.uid(), auth.uid(), 1
        )
        on conflict(company_id,record_type,legacy_record_id) do nothing;

        if not found then
          raise exception 'BILLION_CONCURRENCY_CONFLICT: record already exists';
        end if;
      else
        update public.billion_records
        set legacy_owner_id = v_change->>'legacy_owner_id',
            payload = coalesce(v_change->'payload','{}'::jsonb),
            updated_by = auth.uid(),
            updated_at = now(),
            revision = revision + 1
        where company_id = p_company_id
          and record_type = v_type
          and legacy_record_id = v_legacy_id
          and revision = v_expected_revision;

        if not found then
          raise exception 'BILLION_CONCURRENCY_CONFLICT: stale or missing record revision';
        end if;
      end if;

    elsif v_action = 'patch' then
      update public.billion_records
      set payload = payload || coalesce(v_change->'payload','{}'::jsonb),
          updated_by = auth.uid(),
          updated_at = now(),
          revision = revision + 1
      where company_id = p_company_id
        and record_type = v_type
        and legacy_record_id = v_legacy_id
        and revision = v_expected_revision;

      if not found then
        raise exception 'BILLION_CONCURRENCY_CONFLICT: stale or missing record revision';
      end if;

    elsif v_action = 'delete' then
      delete from public.billion_records
      where company_id = p_company_id
        and record_type = v_type
        and legacy_record_id = v_legacy_id
        and revision = v_expected_revision;

      if not found then
        raise exception 'BILLION_CONCURRENCY_CONFLICT: stale or missing record revision';
      end if;
    end if;

    v_count := v_count + 1;
  end loop;

  insert into public.billion_operation_log (
    operation_id,
    company_id,
    actor_user_id,
    device_id,
    device_sequence,
    operation_type,
    summary,
    entity_changes,
    client_created_at,
    server_applied_at
  )
  values (
    p_operation_id,
    p_company_id,
    auth.uid(),
    p_device_id,
    v_device_sequence,
    'record_batch',
    'ثبت ' || v_count::text || ' تغییر در بسته همگام‌سازی',
    v_entity_changes,
    p_client_created_at,
    clock_timestamp()
  );

  return v_count;
end;
$function$;

-- Backward-compatible adapter for older PWA builds that have exactly one active device per anonymous user.
create or replace function public.billion_apply_record_batch(
  p_company_id uuid,
  p_changes jsonb
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_device_count integer;
  v_device_id text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select count(*), min(device_id)
  into v_device_count, v_device_id
  from public.billion_company_devices
  where company_id = p_company_id
    and user_id = auth.uid()
    and status = 'active';

  if v_device_count <> 1 then
    raise exception 'This PWA version requires one active enrolled device per anonymous session; refresh Billion to continue.';
  end if;

  return public.billion_apply_record_batch(
    p_company_id,
    p_changes,
    v_device_id,
    gen_random_uuid(),
    clock_timestamp()
  );
end;
$function$;

revoke all on function public.billion_touch_device(uuid, text) from public, anon;
grant execute on function public.billion_touch_device(uuid, text) to authenticated;

revoke all on function public.billion_apply_record_batch(uuid, jsonb, text, uuid, timestamptz) from public, anon;
grant execute on function public.billion_apply_record_batch(uuid, jsonb, text, uuid, timestamptz) to authenticated;

revoke all on function public.billion_apply_record_batch(uuid, jsonb) from public, anon;
grant execute on function public.billion_apply_record_batch(uuid, jsonb) to authenticated;
