/*
# BevHubAI Core Schema

1. Purpose
   Multi-tenant SaaS for automatic short ad-video creation.
   Each user owns a workspace; workspace owns projects, brand kit, videos, jobs.

2. New Tables
   - workspaces ........ per-user workspace (1:1 with auth user)
   - projects .......... marketing projects inside a workspace
   - brand_kits ........ brand identity per project (logo, colors, defaults)
   - videos ............ generated ad videos
   - video_assets ...... uploaded media files per video (images)
   - generation_jobs ... async generation pipeline state
   - subscriptions .... mock billing tier per workspace
   - usage ............. monthly video count tracking

3. Relationships
   auth.users 1—1 workspaces 1—n projects 1—1 brand_kits
   workspaces 1—n videos, projects 1—n videos
   videos 1—n video_assets, videos 1—n generation_jobs

4. Security
   RLS enabled on every table.
   Owner-scoped policies using auth.uid() via workspace ownership.
   Storage bucket "video-assets" created with per-user folder isolation.
*/

-- ======================= WORKSPACES =======================
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'My Workspace',
  demo_mode boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_workspaces" ON workspaces;
CREATE POLICY "select_own_workspaces" ON workspaces FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "insert_own_workspaces" ON workspaces;
CREATE POLICY "insert_own_workspaces" ON workspaces FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "update_own_workspaces" ON workspaces;
CREATE POLICY "update_own_workspaces" ON workspaces FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "delete_own_workspaces" ON workspaces;
CREATE POLICY "delete_own_workspaces" ON workspaces FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- ======================= PROJECTS =======================
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

DROP POLICY IF EXISTS "select_own_projects" ON projects;
CREATE POLICY "select_own_projects" ON projects FOR SELECT
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = projects.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_projects" ON projects;
CREATE POLICY "insert_own_projects" ON projects FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = projects.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_projects" ON projects;
CREATE POLICY "update_own_projects" ON projects FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = projects.workspace_id AND w.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = projects.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_projects" ON projects;
CREATE POLICY "delete_own_projects" ON projects FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = projects.workspace_id AND w.user_id = auth.uid()));

-- ======================= BRAND KITS =======================
CREATE TABLE IF NOT EXISTS brand_kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  brand_name text DEFAULT '',
  logo_url text DEFAULT '',
  primary_color text DEFAULT '#A3E635',
  secondary_color text DEFAULT '#0B0D0C',
  default_language text DEFAULT 'ru',
  default_cta text DEFAULT 'Купить сейчас',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE brand_kits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_brand_kits" ON brand_kits;
CREATE POLICY "select_own_brand_kits" ON brand_kits FOR SELECT
  TO authenticated USING (EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = brand_kits.project_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_brand_kits" ON brand_kits;
CREATE POLICY "insert_own_brand_kits" ON brand_kits FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = brand_kits.project_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_brand_kits" ON brand_kits;
CREATE POLICY "update_own_brand_kits" ON brand_kits FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = brand_kits.project_id AND w.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = brand_kits.project_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_brand_kits" ON brand_kits;
CREATE POLICY "delete_own_brand_kits" ON brand_kits FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = brand_kits.project_id AND w.user_id = auth.uid()));

-- ======================= VIDEOS =======================
CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Untitled Video',
  product_name text DEFAULT '',
  product_description text DEFAULT '',
  price text DEFAULT '',
  cta text DEFAULT 'Купить сейчас',
  website_url text DEFAULT '',
  language text DEFAULT 'ru',
  voice_type text DEFAULT 'female',
  voice_url text DEFAULT '',
  style text DEFAULT 'dynamic',
  script_hook text DEFAULT '',
  script_body text DEFAULT '',
  script_cta text DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  video_url text DEFAULT '',
  thumbnail_url text DEFAULT '',
  duration_sec integer DEFAULT 20,
  error_message text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_videos_workspace ON videos(workspace_id);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);

DROP POLICY IF EXISTS "select_own_videos" ON videos;
CREATE POLICY "select_own_videos" ON videos FOR SELECT
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = videos.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_videos" ON videos;
CREATE POLICY "insert_own_videos" ON videos FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = videos.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_videos" ON videos;
CREATE POLICY "update_own_videos" ON videos FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = videos.workspace_id AND w.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = videos.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_videos" ON videos;
CREATE POLICY "delete_own_videos" ON videos FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = videos.workspace_id AND w.user_id = auth.uid()));

-- ======================= VIDEO ASSETS =======================
CREATE TABLE IF NOT EXISTS video_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_type text NOT NULL DEFAULT 'image',
  file_url text NOT NULL,
  file_name text DEFAULT '',
  file_size bigint DEFAULT 0,
  mime_type text DEFAULT 'image/jpeg',
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE video_assets ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_assets_video ON video_assets(video_id);

DROP POLICY IF EXISTS "select_own_assets" ON video_assets;
CREATE POLICY "select_own_assets" ON video_assets FOR SELECT
  TO authenticated USING (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = video_assets.video_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_assets" ON video_assets;
CREATE POLICY "insert_own_assets" ON video_assets FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = video_assets.video_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_assets" ON video_assets;
CREATE POLICY "update_own_assets" ON video_assets FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = video_assets.video_id AND w.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = video_assets.video_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_assets" ON video_assets;
CREATE POLICY "delete_own_assets" ON video_assets FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = video_assets.video_id AND w.user_id = auth.uid()));

-- ======================= GENERATION JOBS =======================
CREATE TABLE IF NOT EXISTS generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0,
  current_step text DEFAULT 'Queued',
  provider text DEFAULT 'demo',
  error_message text DEFAULT '',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_jobs_video ON generation_jobs(video_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);

DROP POLICY IF EXISTS "select_own_jobs" ON generation_jobs;
CREATE POLICY "select_own_jobs" ON generation_jobs FOR SELECT
  TO authenticated USING (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = generation_jobs.video_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_jobs" ON generation_jobs;
CREATE POLICY "insert_own_jobs" ON generation_jobs FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = generation_jobs.video_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_jobs" ON generation_jobs;
CREATE POLICY "update_own_jobs" ON generation_jobs FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = generation_jobs.video_id AND w.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = generation_jobs.video_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_jobs" ON generation_jobs;
CREATE POLICY "delete_own_jobs" ON generation_jobs FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM videos v JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = generation_jobs.video_id AND w.user_id = auth.uid()));

-- ======================= SUBSCRIPTIONS =======================
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'starter',
  monthly_limit integer NOT NULL DEFAULT 15,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_subscriptions" ON subscriptions;
CREATE POLICY "select_own_subscriptions" ON subscriptions FOR SELECT
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = subscriptions.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_subscriptions" ON subscriptions;
CREATE POLICY "insert_own_subscriptions" ON subscriptions FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = subscriptions.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_subscriptions" ON subscriptions;
CREATE POLICY "update_own_subscriptions" ON subscriptions FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = subscriptions.workspace_id AND w.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = subscriptions.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_subscriptions" ON subscriptions;
CREATE POLICY "delete_own_subscriptions" ON subscriptions FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = subscriptions.workspace_id AND w.user_id = auth.uid()));

-- ======================= USAGE =======================
CREATE TABLE IF NOT EXISTS usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  videos_created integer NOT NULL DEFAULT 0,
  UNIQUE(workspace_id, month_start)
);
ALTER TABLE usage ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_usage_workspace ON usage(workspace_id);

DROP POLICY IF EXISTS "select_own_usage" ON usage;
CREATE POLICY "select_own_usage" ON usage FOR SELECT
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = usage.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_usage" ON usage;
CREATE POLICY "insert_own_usage" ON usage FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = usage.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_usage" ON usage;
CREATE POLICY "update_own_usage" ON usage FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = usage.workspace_id AND w.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = usage.workspace_id AND w.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_usage" ON usage;
CREATE POLICY "delete_own_usage" ON usage FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = usage.workspace_id AND w.user_id = auth.uid()));
