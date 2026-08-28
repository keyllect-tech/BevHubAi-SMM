import { supabase } from '@/lib/supabase';

const BUCKET = 'video-assets';

export function getUploadPath(userId: string, fileName: string) {
  const clean = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ts = Date.now();
  return `${userId}/${ts}-${clean}`;
}

export async function uploadImage(
  userId: string,
  file: File
): Promise<{ url: string; path: string; error: string | null }> {
  const path = getUploadPath(userId, file.name);
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) return { url: '', path: '', error: error.message };
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: pub.publicUrl, path, error: null };
}

export async function uploadVideoBlob(
  userId: string,
  blob: Blob,
  videoId: string
): Promise<{ url: string; path: string; error: string | null }> {
  const filePath = `${userId}/videos/${videoId}.mp4`;
  const { error } = await supabase.storage.from(BUCKET).upload(filePath, blob, {
    contentType: 'video/mp4',
    upsert: true,
  });
  if (error) return { url: '', path: '', error: error.message };
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
  return { url: pub.publicUrl, path: filePath, error: null };
}

export function getThumbnailFromImage(imageUrl: string): string {
  return imageUrl;
}
