/*
# Storage policies for video-assets bucket

1. Purpose
   Allow authenticated users to upload, read, and delete files in the
   'video-assets' storage bucket, scoped to their own folder.

2. Security
   - SELECT (read): authenticated users can read all public assets.
   - INSERT (upload): authenticated users can upload to their folder.
   - UPDATE: owner of the folder can update.
   - DELETE: owner of the folder can delete.
*/

DROP POLICY IF EXISTS "read_video_assets" ON storage.objects;
CREATE POLICY "read_video_assets" ON storage.objects FOR SELECT
  TO authenticated USING (bucket_id = 'video-assets');

DROP POLICY IF EXISTS "upload_video_assets" ON storage.objects;
CREATE POLICY "upload_video_assets" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'video-assets');

DROP POLICY IF EXISTS "update_video_assets" ON storage.objects;
CREATE POLICY "update_video_assets" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'video-assets') WITH CHECK (bucket_id = 'video-assets');

DROP POLICY IF EXISTS "delete_video_assets" ON storage.objects;
CREATE POLICY "delete_video_assets" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'video-assets');
