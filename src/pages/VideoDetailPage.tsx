import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  Download,
  RefreshCw,
  Share2,
  Edit3,
  Play,
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  ArrowLeft,
  FileText,
  Clock,
  Globe,
  Mic,
  Film,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, Badge } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { generateVideo } from '@/lib/pipeline';
import { GENERATION_STEPS, type Video, type VideoAsset } from '@/types';

export function VideoDetailPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { workspace } = useAuth();
  const { toast } = useToast();
  const isProcessing = searchParams.get('processing') === '1';

  const [video, setVideo] = useState<Video | null>(null);
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [stepLabel, setStepLabel] = useState('Queued');
  const [shareCopied, setShareCopied] = useState(false);
  const pipelineStarted = useRef(false);

  const loadVideo = useCallback(async () => {
    if (!id) return;
    const [vRes, aRes] = await Promise.all([
      supabase.from('videos').select('*').eq('id', id).maybeSingle(),
      supabase.from('video_assets').select('*').eq('video_id', id).order('sort_order'),
    ]);
    setVideo(vRes.data as Video | null);
    setAssets(aRes.data as VideoAsset[] || []);

    setLoading(false);
  }, [id]);

  useEffect(() => {
    loadVideo();
  }, [loadVideo]);

  // Run pipeline if processing
  useEffect(() => {
    if (!isProcessing || !video || !workspace || pipelineStarted.current) return;
    pipelineStarted.current = true;

    const runPipeline = async () => {
      // Get brand kit for project if available
      let brandName = video.product_name || 'BevHubAI';
      let primaryColor = '#A3E635';

      if (video.project_id) {
        const { data: bk } = await supabase
          .from('brand_kits')
          .select('*')
          .eq('project_id', video.project_id)
          .maybeSingle();
        if (bk) {
          brandName = (bk as { brand_name: string }).brand_name || brandName;
          primaryColor = (bk as { primary_color: string }).primary_color || primaryColor;
        }
      }

      // Update job to processing
      await supabase
        .from('generation_jobs')
        .update({ status: 'processing', started_at: new Date().toISOString() })
        .eq('video_id', video.id);

      const result = await generateVideo({
        video,
        assets,
        brandName,
        primaryColor,
        onStep: (step, prog) => {
          const stepIdx = GENERATION_STEPS.indexOf(step as typeof GENERATION_STEPS[number]);
          if (stepIdx >= 0) {
            setCurrentStep(stepIdx);
            setStepLabel(step);
          }
          setProgress(prog);

          // Update job in DB
          supabase
            .from('generation_jobs')
            .update({
              progress: prog,
              current_step: step,
            })
            .eq('video_id', video.id)
            .then();
        },
      });

      if (result.success) {
        // Update job to completed
        await supabase
          .from('generation_jobs')
          .update({
            status: 'completed',
            progress: 100,
            current_step: 'Finalizing',
            completed_at: new Date().toISOString(),
          })
          .eq('video_id', video.id);

        toast('Видео готово!', 'success');
        // Reload video data
        loadVideo();
        // Remove processing param
        navigate(`/videos/${video.id}`, { replace: true });
      } else {
        await supabase
          .from('generation_jobs')
          .update({
            status: 'failed',
            error_message: result.error,
            completed_at: new Date().toISOString(),
          })
          .eq('video_id', video.id);
        loadVideo();
      }
    };

    runPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProcessing, video, workspace]);

  const handleRetry = async () => {
    if (!video) return;
    pipelineStarted.current = false;
    await supabase.from('videos').update({ status: 'processing', error_message: '' }).eq('id', video.id);
    await supabase.from('generation_jobs').insert({
      video_id: video.id,
      status: 'processing',
      progress: 0,
      current_step: 'Queued',
      provider: 'demo',
      started_at: new Date().toISOString(),
    });
    navigate(`/videos/${video.id}?processing=1`);
    window.location.reload();
  };

  const handleDownload = async () => {
    if (!video?.video_url) return;
    try {
      const response = await fetch(video.video_url);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${video.title || 'bevhub-video'}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Видео скачивается', 'success');
    } catch {
      toast('Не удалось скачать видео', 'error');
    }
  };

  const handleShare = async () => {
    if (!video?.video_url) return;
    try {
      await navigator.clipboard.writeText(video.video_url);
      setShareCopied(true);
      toast('Ссылка скопирована', 'success');
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      toast('Не удалось скопировать', 'error');
    }
  };

  if (loading) {
    return (
      <AppLayout title="Video">
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </AppLayout>
    );
  }

  if (!video) {
    return (
      <AppLayout title="Video not found">
        <Card className="text-center py-12">
          <AlertCircle size={40} className="text-muted mx-auto mb-3" />
          <p className="text-white font-medium mb-4">Видео не найдено</p>
          <Link to="/videos">
            <Button variant="secondary">К списку видео</Button>
          </Link>
        </Card>
      </AppLayout>
    );
  }

  // Processing state
  if (isProcessing || (video.status === 'processing' && !video.video_url)) {
    return (
      <AppLayout title="Generating Video">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex h-16 w-16 rounded-full bg-accent/10 items-center justify-center mb-4 animate-pulse-glow">
              <Loader2 size={32} className="text-accent animate-spin" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">AI создаёт ваше видео...</h2>
            <p className="text-muted">{stepLabel}</p>
          </div>

          {/* Progress bar */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted">Прогресс</span>
              <span className="text-sm font-medium text-accent">{progress}%</span>
            </div>
            <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Steps */}
          <Card>
            <div className="space-y-3">
              {GENERATION_STEPS.slice(1).map((stepName, i) => {
                const stepIdx = i + 1;
                const isDone = currentStep > stepIdx;
                const isActive = currentStep === stepIdx;
                return (
                  <div key={stepName} className="flex items-center gap-3">
                    {isDone ? (
                      <CheckCircle2 size={20} className="text-accent shrink-0" />
                    ) : isActive ? (
                      <Loader2 size={20} className="text-accent animate-spin shrink-0" />
                    ) : (
                      <Circle size={20} className="text-muted/40 shrink-0" />
                    )}
                    <span
                      className={`text-sm ${
                        isDone ? 'text-white' : isActive ? 'text-accent' : 'text-muted/50'
                      }`}
                    >
                      {stepName}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // Failed state
  if (video.status === 'failed') {
    return (
      <AppLayout title="Generation Failed">
        <div className="max-w-2xl mx-auto">
          <Card className="text-center py-12">
            <div className="inline-flex h-16 w-16 rounded-full bg-red-500/10 items-center justify-center mb-4">
              <AlertCircle size={32} className="text-red-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Generation failed</h2>
            <p className="text-muted text-sm mb-6">
              {video.error_message || 'Произошла ошибка при генерации видео'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <Button onClick={handleRetry}>
                <RefreshCw size={18} />
                Retry
              </Button>
              <Link to="/create">
                <Button variant="secondary">Создать новое</Button>
              </Link>
            </div>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // Completed state
  return (
    <AppLayout title={video.title}>
      <div className="max-w-5xl mx-auto">
        <Link to="/videos" className="inline-flex items-center gap-2 text-muted hover:text-white text-sm mb-4 transition-colors">
          <ArrowLeft size={16} />
          Все видео
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Video player */}
          <div className="lg:col-span-2">
            <Card className="p-4">
              <div className="relative aspect-[9/16] max-h-[600px] mx-auto rounded-lg overflow-hidden bg-black">
                {video.video_url ? (
                  <video
                    src={video.video_url}
                    controls
                    autoPlay
                    loop
                    className="w-full h-full object-contain"
                    poster={video.thumbnail_url}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Play size={48} className="text-muted" />
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap items-center gap-3 mt-4">
                <Button onClick={handleDownload} disabled={!video.video_url}>
                  <Download size={18} />
                  Download MP4
                </Button>
                <Button variant="secondary" onClick={() => navigate('/create')}>
                  <Edit3 size={18} />
                  Create another
                </Button>
                <Button variant="outline" onClick={handleShare} disabled={!video.video_url}>
                  {shareCopied ? <CheckCircle2 size={18} className="text-accent" /> : <Share2 size={18} />}
                  {shareCopied ? 'Copied!' : 'Share'}
                </Button>
                <Button variant="ghost" onClick={handleRetry}>
                  <RefreshCw size={18} />
                  Retry
                </Button>
              </div>
            </Card>
          </div>

          {/* Details */}
          <div className="space-y-4">
            <Card>
              <h3 className="text-white font-semibold mb-4">Детали видео</h3>
              <div className="space-y-3">
                <DetailRow icon={FileText} label="Язык" value={video.language} />
                <DetailRow icon={Mic} label="Голос" value={video.voice_type} />
                <DetailRow icon={Film} label="Стиль" value={video.style} />
                <DetailRow icon={Clock} label="Длительность" value={`${video.duration_sec}s`} />
                <DetailRow icon={Globe} label="CTA" value={video.cta} />
              </div>
            </Card>

            {/* Script */}
            {(video.script_hook || video.script_body) && (
              <Card>
                <h3 className="text-white font-semibold mb-3">Сценарий</h3>
                <div className="space-y-3">
                  {video.script_hook && (
                    <div>
                      <p className="text-xs text-accent font-medium mb-1">HOOK</p>
                      <p className="text-sm text-white/90">{video.script_hook}</p>
                    </div>
                  )}
                  {video.script_body && (
                    <div>
                      <p className="text-xs text-accent font-medium mb-1">BODY</p>
                      <p className="text-sm text-white/90">{video.script_body}</p>
                    </div>
                  )}
                  {video.script_cta && (
                    <div>
                      <p className="text-xs text-accent font-medium mb-1">CTA</p>
                      <p className="text-sm text-white/90">{video.script_cta}</p>
                    </div>
                  )}
                </div>
              </Card>
            )}

            <div className="flex items-center gap-2">
              <Badge variant="success">Completed</Badge>
              <span className="text-xs text-muted">
                {new Date(video.created_at).toLocaleString('ru-RU')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function DetailRow({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 text-muted text-sm">
        <Icon size={15} />
        {label}
      </div>
      <span className="text-sm text-white capitalize">{value}</span>
    </div>
  );
}
