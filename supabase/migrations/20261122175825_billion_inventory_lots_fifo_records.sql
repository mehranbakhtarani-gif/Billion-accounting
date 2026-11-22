alter table public.billion_records
  drop constraint billion_records_record_type_check;

alter table public.billion_records
  add constraint billion_records_record_type_check
  check (record_type = any (array[
    'users','accounts','currencies','exchangeRates','parties','vouchers',
    'products','cheques','invoices','employees','assets','costCenters',
    'importDossiers','salesOrders','subcontractJobs','rbacOperators',
    'auditLogs','settings','inventoryLots','inventoryLotMovements'
  ]::text[]));

create or replace function public.billion_apply_record_batch(p_company_id uuid, p_changes jsonb)
returns integer
language plpgsql
set search_path to 'public', 'auth'
as $function$
declare
  v_change jsonb;
  v_count integer := 0;
  v_action text;
  v_type text;
  v_legacy_id text;
  v_expected_revision bigint;
begin
  if auth.uid() is null or p_company_id is null
     or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) < 1
     or jsonb_array_length(p_changes) > 500 then
    raise exception 'Invalid batch request';
  end if;

  if not exists (
    select 1 from public.billion_company_members
    where company_id = p_company_id
      and user_id = auth.uid()
      and role in ('owner', 'admin', 'member')
  ) then
    raise exception 'Company membership required';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_action := v_change->>'action';
    v_type := v_change->>'record_type';
    v_legacy_id := v_change->>'legacy_record_id';

    if v_type not in (
      'users','accounts','currencies','exchangeRates','parties','vouchers',
      'products','cheques','invoices','employees','assets','costCenters',
      'importDossiers','salesOrders','subcontractJobs','rbacOperators',
      'auditLogs','settings','inventoryLots','inventoryLotMovements'
    ) or length(coalesce(v_legacy_id,'')) < 1 or length(v_legacy_id) > 256 then
      raise exception 'Invalid record identity';
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

    else
      raise exception 'Unsupported batch action';
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

drop policy if exists billion_inventory_movements_no_update on public.billion_records;
create policy billion_inventory_movements_no_update
  on public.billion_records as restrictive
  for update to authenticated
  using (record_type <> 'inventoryLotMovements')
  with check (record_type <> 'inventoryLotMovements');

drop policy if exists billion_inventory_movements_no_delete on public.billion_records;
create policy billion_inventory_movements_no_delete
  on public.billion_records as restrictive
  for delete to authenticated
  using (record_type <> 'inventoryLotMovements');
