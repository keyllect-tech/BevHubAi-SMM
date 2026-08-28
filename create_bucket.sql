-- ============================================================
-- BevHubAI — Supabase Storage Setup
-- ============================================================
-- Выполни этот код в Supabase -> SQL Editor -> New query
-- ============================================================

-- 1. Создаём корзину (Bucket) для картинок и видео
insert into storage.buckets (id, name, public)
values ('video-assets', 'video-assets', true)
on conflict (id) do nothing;

-- 2. Политики безопасности (Storage RLS)

-- Разрешаем чтение всем (корзина публичная)
drop policy if exists "Public Access" on storage.objects;
create policy "Public Access"
on storage.objects for select
using ( bucket_id = 'video-assets' );

-- Разрешаем загрузку только авторизованным пользователям
drop policy if exists "Auth Insert" on storage.objects;
create policy "Auth Insert"
on storage.objects for insert
with check (
  bucket_id = 'video-assets' 
  and auth.role() = 'authenticated'
);

-- Разрешаем обновление только своих файлов
drop policy if exists "Auth Update" on storage.objects;
create policy "Auth Update"
on storage.objects for update
using (
  bucket_id = 'video-assets' 
  and auth.uid()::text = (storage.foldername(name))[1]
);

-- Разрешаем удаление только своих файлов
drop policy if exists "Auth Delete" on storage.objects;
create policy "Auth Delete"
on storage.objects for delete
using (
  bucket_id = 'video-assets' 
  and auth.uid()::text = (storage.foldername(name))[1]
);
