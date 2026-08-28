-- ============================================================
-- BevHubAI — Supabase Database Schema
-- ============================================================
-- Выполни этот SQL в Supabase Dashboard:
-- https://supabase.com → твой проект → SQL Editor → New query
-- ============================================================

-- 1. Workspaces
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  demo_mode   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- 2. Subscriptions
create table if not exists public.subscriptions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  plan           text not null default 'starter',
  monthly_limit  integer not null default 15,
  status         text not null default 'active',
  created_at     timestamptz not null default now()
);

-- 3. Projects
create table if not exists public.projects (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  created_at    timestamptz not null default now()
);

-- 4. Brand Kits
create table if not exists public.brand_kits (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  brand_name        text not null default '',
  logo_url          text not null default '',
  primary_color     text not null default '#7C3AED',
  secondary_color   text not null default '#4F46E5',
  default_language  text not null default 'ru',
  default_cta       text not null default 'Купить сейчас',
  created_at        timestamptz not null default now()
);

-- 5. Videos
create table if not exists public.videos (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  project_id           uuid references public.projects(id) on delete set null,
  title                text not null default '',
  product_name         text not null default '',
  product_description  text not null default '',
  price                text not null default '',
  cta                  text not null default '',
  website_url          text not null default '',
  language             text not null default 'ru',
  voice_type           text not null default 'female',
  voice_url            text not null default '',
  style                text not null default 'product',
  script_hook          text not null default '',
  script_body          text not null default '',
  script_cta           text not null default '',
  status               text not null default 'queued',
  video_url            text not null default '',
  thumbnail_url        text not null default '',
  duration_sec         integer not null default 0,
  error_message        text not null default '',
  created_at           timestamptz not null default now()
);

-- 6. Video Assets
create table if not exists public.video_assets (
  id           uuid primary key default gen_random_uuid(),
  video_id     uuid not null references public.videos(id) on delete cascade,
  asset_type   text not null,
  file_url     text not null,
  file_name    text not null default '',
  file_size    bigint not null default 0,
  mime_type    text not null default '',
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

-- 7. Generation Jobs
create table if not exists public.generation_jobs (
  id            uuid primary key default gen_random_uuid(),
  video_id      uuid not null references public.videos(id) on delete cascade,
  status        text not null default 'queued',
  progress      integer not null default 0,
  current_step  text not null default '',
  provider      text not null default '',
  error_message text not null default '',
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- 8. Usage
create table if not exists public.usage (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  month_start     date not null,
  videos_created  integer not null default 0,
  unique (workspace_id, month_start)
);

-- ============================================================
-- Row Level Security (RLS) — каждый видит только своё
-- ============================================================

alter table public.workspaces       enable row level security;
alter table public.subscriptions    enable row level security;
alter table public.projects         enable row level security;
alter table public.brand_kits       enable row level security;
alter table public.videos           enable row level security;
alter table public.video_assets     enable row level security;
alter table public.generation_jobs  enable row level security;
alter table public.usage            enable row level security;

-- workspaces: только свои
drop policy if exists "workspaces: own" on public.workspaces;
create policy "workspaces: own" on public.workspaces
  for all using (auth.uid() = user_id);

-- остальные таблицы: через workspaces
drop policy if exists "subscriptions: own workspace" on public.subscriptions;
create policy "subscriptions: own workspace" on public.subscriptions
  for all using (
    workspace_id in (select id from public.workspaces where user_id = auth.uid())
  );

drop policy if exists "projects: own workspace" on public.projects;
create policy "projects: own workspace" on public.projects
  for all using (
    workspace_id in (select id from public.workspaces where user_id = auth.uid())
  );

drop policy if exists "brand_kits: own workspace" on public.brand_kits;
create policy "brand_kits: own workspace" on public.brand_kits
  for all using (
    project_id in (
      select p.id from public.projects p
      join public.workspaces w on w.id = p.workspace_id
      where w.user_id = auth.uid()
    )
  );

drop policy if exists "videos: own workspace" on public.videos;
create policy "videos: own workspace" on public.videos
  for all using (
    workspace_id in (select id from public.workspaces where user_id = auth.uid())
  );

drop policy if exists "video_assets: own workspace" on public.video_assets;
create policy "video_assets: own workspace" on public.video_assets
  for all using (
    video_id in (
      select v.id from public.videos v
      join public.workspaces w on w.id = v.workspace_id
      where w.user_id = auth.uid()
    )
  );

drop policy if exists "generation_jobs: own workspace" on public.generation_jobs;
create policy "generation_jobs: own workspace" on public.generation_jobs
  for all using (
    video_id in (
      select v.id from public.videos v
      join public.workspaces w on w.id = v.workspace_id
      where w.user_id = auth.uid()
    )
  );

drop policy if exists "usage: own workspace" on public.usage;
create policy "usage: own workspace" on public.usage
  for all using (
    workspace_id in (select id from public.workspaces where user_id = auth.uid())
  );
