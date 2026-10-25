create extension if not exists pgcrypto;


create table if not exists instance_id (
  singleton boolean primary key default true check (singleton),
  instance_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- =========================================================

create table if not exists instance_keys (
  singleton boolean primary key default true check (singleton),
  private_key text not null,
  public_key text not null,
  created_at timestamptz not null default now()
);

insert into instance_id (singleton)
values (true)
on conflict (singleton) do nothing;


-- =========================================================

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

alter table users
  add column if not exists avatar_url text;

alter table users
  add column if not exists is_bot boolean not null default false;

alter table users
  add column if not exists app_owner_id uuid;

alter table users
  add column if not exists display_name text;

alter table users
  add column if not exists bio text;

alter table users
  add column if not exists global_roles text[] not null default '{}';

alter table users
  add column if not exists email text;

alter table users
  add column if not exists email_verified_at timestamptz;

create unique index if not exists users_email_lower_unique
  on users (lower(email))
  where email is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_app_owner_id_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_app_owner_id_fkey
      foreign key (app_owner_id)
      references public.users(id)
      on delete cascade;
  end if;
end
$$;


-- =========================================================

create table if not exists app_tokens (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references users(id)
    on delete cascade,
  token_hash text not null unique,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_tokens_lookup
  on app_tokens (token_hash);


-- =========================================================

create table if not exists passkeys (
  credential_id text primary key,
  user_id uuid not null
    references users(id)
    on delete cascade,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  created_at timestamptz not null default now()
);


-- =========================================================

create table if not exists passkey_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references users(id)
    on delete cascade,
  purpose text not null check (
    purpose in ('registration', 'authentication')
  ),
  challenge text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists passkey_challenges_lookup
  on passkey_challenges (user_id, purpose, expires_at);


-- =========================================================

create table if not exists spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table spaces
  add column if not exists owner_id uuid;

alter table spaces
  add column if not exists visibility text not null default 'private';

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'spaces_owner_id_fkey'
      and conrelid = 'public.spaces'::regclass
      and confdeltype <> 'n'
  ) then
    alter table public.spaces
      drop constraint spaces_owner_id_fkey;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'spaces_owner_id_fkey'
      and conrelid = 'public.spaces'::regclass
  ) then
    alter table public.spaces
      add constraint spaces_owner_id_fkey
      foreign key (owner_id)
      references public.users(id)
      on delete set null;
  end if;
end
$$;


-- =========================================================

create table if not exists space_roles (
  space_id uuid not null
    references spaces(id)
    on delete cascade,

  name text not null,
  rank integer not null,
  color text,

  can_manage_roles boolean not null default false,
  can_manage_members boolean not null default false,
  can_manage_invites boolean not null default false,
  can_manage_chats boolean not null default false,
  can_kick_members boolean not null default false,
  can_ban_members boolean not null default false,
  can_delete_any_message boolean not null default false,

  is_owner_role boolean not null default false,

  created_at timestamptz not null default now(),

  primary key (space_id, name)
);

create index if not exists space_roles_rank_lookup
  on space_roles (space_id, rank desc);


-- =========================================================

insert into space_roles (
  space_id,
  name,
  rank,
  can_manage_roles,
  can_manage_members,
  can_manage_invites,
  can_manage_chats,
  can_kick_members,
  can_ban_members,
  can_delete_any_message,
  is_owner_role
)
select
  id,
  'owner',
  100,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true
from spaces
on conflict (space_id, name) do nothing;


insert into space_roles (
  space_id,
  name,
  rank,
  can_manage_roles,
  can_manage_members,
  can_manage_invites,
  can_manage_chats,
  can_kick_members,
  can_ban_members,
  can_delete_any_message,
  is_owner_role
)
select
  id,
  'admin',
  50,
  false,
  true,
  true,
  true,
  true,
  false,
  true,
  false
from spaces
on conflict (space_id, name) do nothing;


insert into space_roles (
  space_id,
  name,
  rank,
  can_manage_roles,
  can_manage_members,
  can_manage_invites,
  can_manage_chats,
  can_kick_members,
  can_ban_members,
  can_delete_any_message,
  is_owner_role
)
select
  id,
  'member',
  0,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false
from spaces
on conflict (space_id, name) do nothing;


-- =========================================================

create or replace function public.handle_new_space_roles()
returns trigger
language plpgsql
as $$
begin

  insert into public.space_roles (
    space_id,
    name,
    rank,
    can_manage_roles,
    can_manage_members,
    can_manage_invites,
    can_manage_chats,
    can_kick_members,
    can_ban_members,
    can_delete_any_message,
    is_owner_role
  )
  values (
    new.id,
    'owner',
    100,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true
  )
  on conflict (space_id, name) do nothing;


  insert into public.space_roles (
    space_id,
    name,
    rank,
    can_manage_roles,
    can_manage_members,
    can_manage_invites,
    can_manage_chats,
    can_kick_members,
    can_ban_members,
    can_delete_any_message,
    is_owner_role
  )
  values (
    new.id,
    'admin',
    50,
    false,
    true,
    true,
    true,
    true,
    false,
    true,
    false
  )
  on conflict (space_id, name) do nothing;


  insert into public.space_roles (
    space_id,
    name,
    rank,
    can_manage_roles,
    can_manage_members,
    can_manage_invites,
    can_manage_chats,
    can_kick_members,
    can_ban_members,
    can_delete_any_message,
    is_owner_role
  )
  values (
    new.id,
    'member',
    0,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false
  )
  on conflict (space_id, name) do nothing;


  return new;
end;
$$;


drop trigger if exists on_space_created on public.spaces;

create trigger on_space_created
after insert on public.spaces
for each row
execute function public.handle_new_space_roles();


-- =========================================================

create table if not exists space_members (
  space_id uuid not null
    references spaces(id)
    on delete cascade,

  user_id uuid not null
    references users(id)
    on delete cascade,

  role text not null default 'member',

  joined_at timestamptz not null default now(),

  primary key (space_id, user_id)
);


-- =========================================================

update space_members sm
set role = 'member'
where not exists (
  select 1
  from space_roles sr
  where sr.space_id = sm.space_id
    and sr.name = sm.role
);

-- =========================================================

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'space_members_role_fkey'
      and conrelid = 'public.space_members'::regclass
  ) then

    alter table public.space_members
      add constraint space_members_role_fkey
      foreign key (space_id, role)
      references public.space_roles(space_id, name)
      on delete restrict;

  end if;
end
$$;

-- =========================================================


create table if not exists app_invites (
  id uuid primary key default gen_random_uuid(),

  app_user_id uuid not null
    references users(id)
    on delete cascade,

  code text not null unique,

  created_by uuid
    references users(id)
    on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists app_invites_app_idx
  on app_invites (app_user_id);

-- =========================================================

create table if not exists chats (
  id uuid primary key default gen_random_uuid(),

  space_id uuid
    references spaces(id)
    on delete cascade,

  name text not null,

  type text not null check (
    type in ('text', 'voice', 'dm')
  ),

  created_at timestamptz not null default now()
);

alter table chats
  alter column space_id drop not null;

alter table chats
  drop constraint if exists chats_type_check;

alter table chats
  add constraint chats_type_check
  check (type in ('text', 'voice', 'dm'));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chats_space_or_dm_check'
      and conrelid = 'public.chats'::regclass
  ) then
    alter table public.chats
      add constraint chats_space_or_dm_check
      check (type = 'dm' or space_id is not null)
      not valid;
  end if;
end
$$;

-- =========================================================

create table if not exists dm_members (
  chat_id uuid not null
    references chats(id)
    on delete cascade,

  user_id uuid not null
    references users(id)
    on delete cascade,

  created_at timestamptz not null default now(),

  primary key (chat_id, user_id)
);

create index if not exists dm_members_user_idx
  on dm_members (user_id);

-- =========================================================

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),

  sender_id uuid not null
    references users(id)
    on delete cascade,

  sender_is_bot boolean not null default false,

  chat_id uuid not null
    references chats(id)
    on delete cascade,

  content text not null,

  created_at timestamptz not null default now()
);


alter table messages
  add column if not exists sender_is_bot boolean
  not null default false;


alter table messages
  add column if not exists reply_to_id uuid;


alter table messages
  add column if not exists edited_at timestamptz;


alter table messages
  add column if not exists deleted_at timestamptz;

-- =========================================================


do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'messages_reply_to_id_fkey'
      and conrelid = 'public.messages'::regclass
  ) then

    alter table public.messages
      add constraint messages_reply_to_id_fkey
      foreign key (reply_to_id)
      references public.messages(id)
      on delete set null;

  end if;
end
$$;


create index if not exists messages_chat_created_lookup
  on messages (chat_id, created_at desc);

-- =========================================================

create table if not exists message_reactions (
  message_id uuid not null
    references messages(id)
    on delete cascade,

  user_id uuid not null
    references users(id)
    on delete cascade,

  emoji text not null,

  created_at timestamptz not null default now(),

  primary key (message_id, user_id, emoji)
);

create index if not exists message_reactions_lookup
  on message_reactions (message_id);

-- =========================================================


create table if not exists space_invites (
  id uuid primary key default gen_random_uuid(),

  space_id uuid not null
    references spaces(id)
    on delete cascade,

  code text not null unique,

  role text not null default 'member',

  created_by uuid not null
    references users(id)
    on delete cascade,

  max_uses integer,

  uses_count integer not null default 0,

  expires_at timestamptz,

  created_at timestamptz not null default now()
);

-- =========================================================


do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'space_invites_role_fkey'
      and conrelid = 'public.space_invites'::regclass
  ) then

    update public.space_invites si
    set role = 'member'
    where not exists (
      select 1
      from public.space_roles sr
      where sr.space_id = si.space_id
        and sr.name = si.role
    );

    alter table public.space_invites
      add constraint space_invites_role_fkey
      foreign key (space_id, role)
      references public.space_roles(space_id, name)
      on delete restrict;

  end if;
end
$$;


create index if not exists space_invites_space_idx
  on space_invites (space_id);

create index if not exists space_invites_code_idx
  on space_invites (code);


-- =========================================================

create table if not exists webhooks (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null
    references users(id)
    on delete cascade,
  chat_id uuid not null
    references chats(id)
    on delete cascade,
  name text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists webhooks_app_lookup
  on webhooks (app_user_id);

create index if not exists webhooks_chat_lookup
  on webhooks (chat_id);

alter table messages
  add column if not exists webhook_id uuid;

alter table messages
  add column if not exists sender_name_override text;

alter table messages
  add column if not exists sender_avatar_url_override text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'messages_webhook_id_fkey'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_webhook_id_fkey
      foreign key (webhook_id)
      references public.webhooks(id)
      on delete set null;
  end if;
end
$$;

create index if not exists messages_webhook_lookup
  on messages (webhook_id);

create table if not exists webhook_deliveries (
  webhook_id uuid not null
    references webhooks(id)
    on delete cascade,
  delivery_id text not null,
  processed_at timestamptz not null default now(),
  primary key (webhook_id, delivery_id)
);

create index if not exists webhook_deliveries_processed_idx
  on webhook_deliveries (processed_at);

-- =========================================================

create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null
    references messages(id)
    on delete cascade,
  uploader_id uuid not null
    references users(id)
    on delete cascade,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  storage_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists attachments_message_lookup
  on attachments (message_id, created_at);

-- =========================================================

create table if not exists email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references users(id)
    on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists email_verification_tokens_user_idx
  on email_verification_tokens (user_id, created_at desc);

create index if not exists email_verification_tokens_expiry_idx
  on email_verification_tokens (expires_at);

-- =========================================================


create index if not exists users_app_owner_idx
  on users (app_owner_id);

create index if not exists space_members_user_idx
  on space_members (user_id);

create index if not exists chats_space_idx
  on chats (space_id);

create index if not exists messages_sender_idx
  on messages (sender_id);

-- =========================================================
do $$
begin
  if not exists (
    select 1
    from users
    where global_roles @> array['admin']::text[]
  ) then
    update users
       set global_roles = array_append(global_roles, 'admin')
     where id = (
       select id
       from users
       where is_bot = false
       order by created_at asc, id asc
       limit 1
     );
  end if;
end
$$;

-- =========================================================
-- These are optional

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'spaces_visibility_check'
      and conrelid = 'public.spaces'::regclass
  ) then
    alter table public.spaces
      add constraint spaces_visibility_check
      check (visibility in ('private', 'public'))
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'space_invites_max_uses_check'
      and conrelid = 'public.space_invites'::regclass
  ) then
    alter table public.space_invites
      add constraint space_invites_max_uses_check
      check (max_uses is null or max_uses > 0)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'space_invites_uses_count_check'
      and conrelid = 'public.space_invites'::regclass
  ) then
    alter table public.space_invites
      add constraint space_invites_uses_count_check
      check (uses_count >= 0)
      not valid;
  end if;
end
$$;