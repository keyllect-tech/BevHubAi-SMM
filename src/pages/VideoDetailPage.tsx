import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Download,
  RefreshCw,
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
  WifiOff,
} from 'lucide-react';
import { api, apiUrl, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, Badge } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { GENERATION_STEPS, LANGUAGES, VIDEO_STYLES, type GenerationJob, type Video } from '@/types';

const POLL_INTERVAL_MS = 2000;

const AUDIO_LABELS: Record<string, string> = {
  'tts-online': 'AI-озвучка (онлайн)',
  'tts-online-ru-voice': 'AI-озвучка (онлайн, русский голос)',
  'tts-offline': 'AI-озвучка (офлайн)',
  'tts-offline-ru-voice': 'AI-озвучка (офлайн, русский голос)',
  // Values written by earlier versions.
  tts: 'AI-озвучка (онлайн)',
  'tts-ru-voice': 'AI-озвучка (онлайн, русский голос)',
  silence: 'Без озвучки',
};

// The server reports steps by stable English ids; show them in Russian like the rest of the page.
// Keyed by the step type so adding a step without a translation fails the type check.
const STEP_LABELS: Record<(typeof GENERATION_STEPS)[number], string> = {
  Queued: 'В очереди',
  'Analyzing product': 'Анализ товара',
  'Writing script': 'Пишем сценарий',
  'Generating voice': 'Озвучка',
  'Creating video': 'Монтаж видео',
  'Adding subtitles': 'Субтитры',
  Finalizing: 'Финализация',
};
const stepLabel = (step: string) => (STEP_LABELS as Record<string, string>)[step] || step;

export function VideoDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [video, setVideo] = useState<Video | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [connectionLost, setConnectionLost] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getVideo(id);
      setVideo(data.video);
      setJob(data.job);
      setLoadError('');
      setNotFound(false);
      setConnectionLost(false);
      return data.video;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else if (err instanceof ApiError && err.status === 401) return null;
      else setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить видео');
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    setVideo(null);
    load();
  }, [load]);

  // Poll while the server is rendering. The job lives on the server, so refreshing or leaving the
  // page never starts a second render — polling simply reconnects to the current state.
  const status = video?.status;
  useEffect(() => {
    if (status !== 'processing') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const data = await api.getVideo(id);
        if (cancelled) return;
        setConnectionLost(false);
        setVideo(data.video);
        setJob(data.job);
        if (data.video.status === 'completed') toast('Видео готово!', 'success');
        if (data.video.status === 'failed') toast(data.video.error_message || 'Генерация не удалась', 'error');
        if (data.video.status !== 'processing') return;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setConnectionLost(true);
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, id, toast]);

  const handleRetry = async () => {
    if (!video || retrying) return;
    setRetrying(true);
    try {
      const data = await api.retryVideo(video.id);
      setJob({ status: 'processing', progress: 0, current_step: 'Queued', error_message: '', started_at: new Date().toISOString(), completed_at: null });
      setVideo(data.video);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось перезапустить генерацию', 'error');
    } finally {
      setRetrying(false);
    }
  };

  const handleDownload = async () => {
    if (!video?.video_url || downloading) return;
    setDownloading(true);
    const url = api.videoDownloadUrl(video.id);
    try {
      // Check first so a missing file shows an error instead of downloading an error page.
      const head = await fetch(url, { method: 'HEAD', credentials: 'include' });
      if (!head.ok || !head.headers.get('content-type')?.startsWith('video/mp4')) {
        throw new Error(head.status === 401 ? 'Сессия истекла. Войдите снова.' : 'Файл видео недоступен');
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Видео скачивается', 'success');
    } catch (err) {
      toast(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : 'Не удалось скачать видео', 'error');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <AppLayout title="Видео">
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </AppLayout>
    );
  }

  if (notFound || loadError || !video) {
    return (
      <AppLayout title="Видео">
        <Card className="text-center py-12">
          <AlertCircle size={40} className="text-muted mx-auto mb-3" />
          <p className="text-white font-medium mb-1">{notFound ? 'Видео не найдено' : 'Не удалось загрузить видео'}</p>
          {loadError && !notFound && <p className="text-muted text-sm mb-4 break-words">{loadError}</p>}
          <div className="flex flex-wrap items-center justify-center gap-3 mt-4">
            {loadError && !notFound && (
              <Button variant="secondary" onClick={() => load()}>
                <RefreshCw size={16} />
                Повторить
              </Button>
            )}
            <Link to="/videos">
              <Button variant="secondary">К списку видео</Button>
            </Link>
          </div>
        </Card>
      </AppLayout>
    );
  }

  if (video.status === 'processing' || video.status === 'queued') {
    const stepIdx = Math.max(0, GENERATION_STEPS.indexOf((job?.current_step || 'Queued') as (typeof GENERATION_STEPS)[number]));
    const progress = job?.progress ?? 0;
    return (
      <AppLayout title="Генерация видео">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex h-16 w-16 rounded-full bg-accent/10 items-center justify-center mb-4 animate-pulse-glow">
              <Loader2 size={32} className="text-accent animate-spin" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">AI создаёт ваше видео...</h2>
            <p className="text-muted">{stepLabel(job?.current_step || 'Queued')}</p>
          </div>

          {connectionLost && (
            <div role="alert" className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <WifiOff size={18} className="text-yellow-400 shrink-0" />
              <p className="text-sm text-yellow-200">Нет связи с сервером — продолжаем попытки подключения…</p>
            </div>
          )}

          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted">Прогресс</span>
              <span className="text-sm font-medium text-accent">{progress}%</span>
            </div>
            <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <Card>
            <div className="space-y-3">
              {GENERATION_STEPS.slice(1).map((stepName, i) => {
                const idx = i + 1;
                const isDone = stepIdx > idx;
                const isActive = stepIdx === idx;
                return (
                  <div key={stepName} className="flex items-center gap-3">
                    {isDone ? (
                      <CheckCircle2 size={20} className="text-accent shrink-0" />
                    ) : isActive ? (
                      <Loader2 size={20} className="text-accent animate-spin shrink-0" />
                    ) : (
                      <Circle size={20} className="text-muted/40 shrink-0" />
                    )}
                    <span className={`text-sm ${isDone ? 'text-white' : isActive ? 'text-accent' : 'text-muted/50'}`}>{stepLabel(stepName)}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </AppLayout>
    );
  }

  if (video.status === 'failed') {
    return (
      <AppLayout title="Ошибка генерации">
        <div className="max-w-2xl mx-auto">
          <Card className="text-center py-12">
            <div className="inline-flex h-16 w-16 rounded-full bg-red-500/10 items-center justify-center mb-4">
              <AlertCircle size={32} className="text-red-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Не удалось создать видео</h2>
            <p className="text-muted text-sm mb-6 break-words">{video.error_message || 'Произошла ошибка при генерации видео'}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button onClick={handleRetry} loading={retrying}>
                <RefreshCw size={18} />
                Повторить
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

  const [benefit1, benefit2] = (video.script_body || '').split('\n');

  return (
    <AppLayout title={video.title}>
      <div className="max-w-5xl mx-auto">
        <Link to="/videos" className="inline-flex items-center gap-2 text-muted hover:text-white text-sm mb-4 transition-colors">
          <ArrowLeft size={16} />
          Все видео
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 min-w-0">
            <Card className="p-4">
              <div className="relative aspect-[9/16] w-full max-w-[340px] mx-auto rounded-lg overflow-hidden bg-black">
                {video.video_url ? (
                  <video
                    key={video.video_url}
                    src={apiUrl(video.video_url)}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full h-full object-contain"
                    poster={video.thumbnail_url ? apiUrl(video.thumbnail_url) : undefined}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Play size={48} className="text-muted" />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 mt-4">
                <Button onClick={handleDownload} disabled={!video.video_url} loading={downloading}>
                  {!downloading && <Download size={18} />}
                  Скачать MP4
                </Button>
                <Button variant="secondary" onClick={() => navigate('/create')}>
                  <Edit3 size={18} />
                  Создать ещё
                </Button>
                <Button variant="ghost" onClick={handleRetry} loading={retrying}>
                  <RefreshCw size={18} />
                  Пересоздать
                </Button>
              </div>
            </Card>
          </div>

          <div className="space-y-4 min-w-0">
            <Card>
              <h3 className="text-white font-semibold mb-4">Детали видео</h3>
              <div className="space-y-3">
                <DetailRow icon={FileText} label="Язык" value={LANGUAGES.find((l) => l.id === video.language)?.name || video.language} />
                <DetailRow icon={Mic} label="Озвучка" value={AUDIO_LABELS[video.audio_kind] || video.voice_type} />
                <DetailRow icon={Film} label="Стиль" value={VIDEO_STYLES.find((s) => s.id === video.style)?.name || video.style} />
                <DetailRow icon={Clock} label="Длительность" value={`${video.duration_sec}s`} />
                <DetailRow icon={Globe} label="Призыв" value={video.cta} />
              </div>
            </Card>

            {(video.script_hook || video.script_body) && (
              <Card>
                <h3 className="text-white font-semibold mb-1">Сценарий</h3>
                <p className="text-xs text-muted mb-3">
                  {video.script_source === 'openai' ? 'OpenAI' : video.script_source === 'fallback' ? 'BevHub Engine' : 'Пользовательский'}
                </p>
                <div className="space-y-3">
                  {video.script_hook && <ScriptBlock label="Хук" text={video.script_hook} />}
                  {benefit1 && <ScriptBlock label="Преимущество 1" text={benefit1} />}
                  {benefit2 && <ScriptBlock label="Преимущество 2" text={benefit2} />}
                  {video.script_cta && <ScriptBlock label="Призыв к действию" text={video.script_cta} />}
                </div>
              </Card>
            )}

            <div className="flex items-center gap-2">
              <Badge variant="success">Готово</Badge>
              <span className="text-xs text-muted">{new Date(video.created_at).toLocaleString('ru-RU')}</span>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function ScriptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-xs text-accent font-medium mb-1">{label}</p>
      <p className="text-sm text-white/90 break-words">{text}</p>
    </div>
  );
}

function DetailRow({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-muted text-sm shrink-0">
        <Icon size={15} />
        {label}
      </div>
      <span className="text-sm text-white text-right break-words min-w-0">{value}</span>
    </div>
  );
}
