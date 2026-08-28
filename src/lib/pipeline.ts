import { supabase } from '@/lib/supabase';
import { generateScript, type GeneratedScript } from '@/lib/ai/scriptGenerator';
import { uploadVideoBlob } from '@/lib/storage';
import { GENERATION_STEPS, type Video, type VideoAsset } from '@/types';

interface GenerateParams {
  video: Video;
  assets: VideoAsset[];
  brandName: string;
  primaryColor: string;
  onStep: (step: string, progress: number) => void;
}

export interface GenerationResult {
  success: boolean;
  videoUrl: string;
  script: GeneratedScript;
  error: string;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function generateVideo(params: GenerateParams): Promise<GenerationResult> {
  const { video, assets, onStep } = params;

  try {
    // Step 1: Analyzing product
    onStep(GENERATION_STEPS[1], 10);
    await delay(800);

    // Step 2: Writing script
    onStep(GENERATION_STEPS[2], 25);
    let script = {
        hook: video.script_hook || '',
        body: video.script_body || '',
        cta: video.script_cta || '',
        fullScript: `${video.script_hook} ${video.script_body} ${video.script_cta}`,
        scenes: [video.script_hook || '', video.script_body || '', video.script_cta || '']
    };

    if (!video.script_hook) {
        script = await generateScript({
          productName: video.product_name,
          productDescription: video.product_description,
          price: video.price,
          cta: video.cta,
          style: video.style,
          language: video.language,
        });
    }
    await delay(600);

    // Save script to DB
    await supabase
      .from('videos')
      .update({
        script_hook: script.hook,
        script_body: script.body,
        script_cta: script.cta,
      })
      .eq('id', video.id);

    // Step 3: Generating voice (demo mode — no real TTS)
    onStep(GENERATION_STEPS[3], 40);
    await delay(800);

    // Step 4: Creating video — via real FFmpeg backend
    onStep(GENERATION_STEPS[4], 55);

    const imageUrls = assets
      .filter((a) => a.asset_type === 'image')
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((a) => a.file_url);

    let imageFile: Blob | undefined;
    if (imageUrls.length > 0 && imageUrls[0]) {
      try {
        const resp = await fetch(imageUrls[0]);
        imageFile = await resp.blob();
      } catch (e) {
        console.error('Failed to fetch image for backend', e);
      }
    }

    const formData = new FormData();
    if (imageFile) formData.append('image', imageFile, 'image.jpg');
    formData.append('productName', video.product_name || '');
    formData.append('description', video.product_description || '');
    formData.append('cta', video.cta || '');
    formData.append('language', video.language || '');
    formData.append('style', video.style || '');
    formData.append('voiceType', video.voice_type || '');
    
    formData.append('t1', script.hook || '');
    formData.append('t2', script.scenes[1] || '');
    formData.append('t3', script.scenes[2] || '');
    formData.append('t4', script.cta || '');

    const backendUrl = 'http://localhost:3001';
    
    const apiRes = await fetch(`${backendUrl}/api/generations`, {
        method: 'POST',
        body: formData,
    });
    const jobData = await apiRes.json();
    if (!apiRes.ok) throw new Error(jobData.error || 'Backend error');

    onStep(GENERATION_STEPS[4], 65);

    let finalUrl = '';
    while (true) {
        await delay(2000);
        const pollRes = await fetch(`${backendUrl}/api/generations/${jobData.jobId}`);
        const pollData = await pollRes.json();
        if (pollData.status === 'COMPLETED') {
            finalUrl = backendUrl + pollData.url;
            break;
        }
        if (pollData.status === 'FAILED') {
            throw new Error('Video generation failed');
        }
    }

    // Fetch the actual video to upload it to Supabase
    const vidRes = await fetch(finalUrl);
    if (!vidRes.ok) throw new Error(`Failed to fetch generated video from backend: ${vidRes.status}`);
    const blob = await vidRes.blob();

    // Step 5: Adding subtitles (already embedded by FFmpeg)
    onStep(GENERATION_STEPS[5], 80);
    await delay(500);

    // Step 6: Upload to Supabase Storage (persistent URL)
    onStep(GENERATION_STEPS[6], 90);
    const userId = video.workspace_id;
    const { url: supabaseUrl, error: uploadError } = await uploadVideoBlob(userId, blob, video.id);
    
    // Use Supabase URL if upload succeeded, else fallback to backend localhost URL
    let videoUrl = finalUrl; // localhost fallback (works during current session)
    if (uploadError) {
      console.warn('[PIPELINE] Supabase upload failed, using localhost URL:', uploadError);
      console.warn('[PIPELINE] Video will not persist after server restart.');
    } else {
      videoUrl = supabaseUrl; // persistent URL
      console.log('[PIPELINE] Video uploaded to Supabase Storage:', supabaseUrl);
    }

    // Use first image as thumbnail
    const thumbnailUrl = imageUrls[0] || '';

    // Update video record in DB
    await supabase
      .from('videos')
      .update({
        status: 'completed',
        video_url: videoUrl,
        thumbnail_url: thumbnailUrl,
        duration_sec: 15,
        error_message: '',
      })
      .eq('id', video.id);

    onStep(GENERATION_STEPS[6], 100);

    return {
      success: true,
      videoUrl,
      script,
      error: '',
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown generation error';

    await supabase
      .from('videos')
      .update({ status: 'failed', error_message: errorMsg })
      .eq('id', video.id);

    return {
      success: false,
      videoUrl: '',
      script: await generateScript({
        productName: video.product_name,
        productDescription: video.product_description,
        price: video.price,
        cta: video.cta,
        style: video.style,
        language: video.language,
      }),
      error: errorMsg,
    };
  }
}
