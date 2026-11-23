-- Keep bootstrap and invite RPCs callable only by the trusted Edge Function.
create or replace function public.billion_bootstrap_company(
  p_bootstrap_token text,p_user_id uuid,p_company_name text,p_device_id text,p_device_label text,p_platform text
) returns uuid language plpgsql security definer
set search_path = pg_catalog,public,auth,extensions,billion_private,pg_temp
as $$
declare v_hash text; v_company_id uuid;
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then
    raise exception 'Service role required' using errcode='42501';
  end if;
  if p_user_id is null or p_device_id is null or length(p_device_id) not between 8 and 128
    or p_platform not in ('android','ios','web') or length(coalesce(p_device_label,''))>80
    or length(trim(coalesce(p_company_name,''))) not between 1 and 160 or length(coalesce(p_bootstrap_token,''))<32 then
    raise exception 'Invalid bootstrap request';
  end if;
  v_hash:=encode(extensions.digest(convert_to(p_bootstrap_token,'UTF8'),'sha256'),'hex');
  update billion_private.bootstrap_credentials set used_at=clock_timestamp()
    where token_hash=v_hash and used_at is null and expires_at>now();
  if not found then raise exception 'Invalid, expired, or already used bootstrap token' using errcode='42501'; end if;
  if exists(select 1 from public.billion_companies) then raise exception 'Billion company has already been bootstrapped'; end if;
  insert into public.billion_companies(name,created_by) values(trim(p_company_name),p_user_id) returning id into v_company_id;
  insert into public.billion_company_members(company_id,user_id,role) values(v_company_id,p_user_id,'owner');
  insert into public.billion_company_devices(company_id,device_id,user_id,device_label,platform,last_seen_at)
    values(v_company_id,p_device_id,p_user_id,trim(p_device_label),p_platform,clock_timestamp());
  return v_company_id;
end; $$;

create or replace function public.billion_accept_company_invite(
  p_invite_token text,p_user_id uuid,p_device_id text,p_device_label text,p_platform text
) returns uuid language plpgsql security definer
set search_path = pg_catalog,public,auth,extensions,pg_temp
as $$
declare v_hash text; v_invite public.billion_company_invites%rowtype; v_company_id uuid; v_active_count integer;
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' then
    raise exception 'Service role required' using errcode='42501';
  end if;
  if p_user_id is null or p_device_id is null or length(p_device_id) not between 8 and 128
    or p_platform not in ('android','ios','web') or length(coalesce(p_device_label,''))>80
    or length(coalesce(p_invite_token,''))<32 then raise exception 'Invalid invite request'; end if;
  v_hash:=encode(extensions.digest(convert_to(p_invite_token,'UTF8'),'sha256'),'hex');
  select * into v_invite from public.billion_company_invites where token_hash=v_hash for update;
  if not found or v_invite.used_at is not null or v_invite.expires_at<=now() then
    raise exception 'Invalid, expired, or already used invitation' using errcode='42501';
  end if;
  select id into v_company_id from public.billion_companies where id=v_invite.company_id for update;
  if not found then raise exception 'Company no longer exists'; end if;
  if exists(select 1 from public.billion_company_members where user_id=p_user_id and company_id<>v_company_id) then
    raise exception 'This user already belongs to another company' using errcode='42501';
  end if;
  select count(*) into v_active_count from public.billion_company_devices where company_id=v_company_id and status='active';
  if not exists(select 1 from public.billion_company_devices where company_id=v_company_id
    and device_id=p_device_id and user_id=p_user_id and status='active') and v_active_count>=3 then
    raise exception 'Maximum of three active devices has been reached';
  end if;
  insert into public.billion_company_members(company_id,user_id,role) values(v_company_id,p_user_id,v_invite.role)
    on conflict(company_id,user_id) do nothing;
  insert into public.billion_company_devices(company_id,device_id,user_id,device_label,platform,status,last_seen_at)
    values(v_company_id,p_device_id,p_user_id,trim(p_device_label),p_platform,'active',clock_timestamp())
    on conflict(company_id,device_id) do update set device_label=excluded.device_label,
      platform=excluded.platform,last_seen_at=clock_timestamp()
      where public.billion_company_devices.user_id=excluded.user_id and public.billion_company_devices.status='active';
  if not found then raise exception 'Device is already enrolled by another user or revoked'; end if;
  update public.billion_company_invites set used_at=clock_timestamp(),used_by=p_user_id,used_device_id=p_device_id
    where id=v_invite.id and used_at is null;
  if not found then raise exception 'Invitation was consumed concurrently'; end if;
  return v_company_id;
end; $$;
