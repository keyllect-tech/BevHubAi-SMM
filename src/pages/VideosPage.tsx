import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Video as VideoIcon, Play, AlertCircle, PlusCircle, Clock } from 'lucide-react';
import { api, apiUrl } from '@/lib/api';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, Badge } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { Video } from '@/types';

const FILTERS = ['all', 'completed', 'processing', 'failed'];
const FILTER_LABELS: Record<string, string> = { all: 'Все', completed: 'Готовые', processing: 'В процессе', failed: 'С ошибкой' };

export function VideosPage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    let mounted = true;
    api
      .listVideos()
      .then((data) => mounted && setVideos(data.videos))
      .catch((err) => mounted && setError(err.message))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, []);

  const filtered = filter === 'all' ? videos : videos.filter((v) => v.status === filter);

  const statusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge variant="success">Готово</Badge>;
      case 'processing':
        return <Badge variant="warning">В процессе</Badge>;
      case 'failed':
        return <Badge variant="error">Ошибка</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <AppLayout title="My Videos">
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap ${
                filter === f ? 'bg-accent/10 text-accent border border-accent/20' : 'text-muted hover:text-white border border-transparent'
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-6 flex items-start gap-3 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <div className="aspect-[9/16] bg-bg-elevated rounded-lg mb-3 shimmer" />
              <div className="h-4 bg-bg-elevated rounded w-2/3 mb-2 shimmer" />
              <div className="h-3 bg-bg-elevated rounded w-1/3 shimmer" />
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="text-center py-12">
          <VideoIcon size={40} className="text-muted mx-auto mb-3" />
          <p className="text-white font-medium mb-1">Нет видео</p>
          <p className="text-muted text-sm mb-4">
            {filter === 'all' ? 'Создайте первое видео' : `Нет видео в разделе «${FILTER_LABELS[filter]}»`}
          </p>
          <Link to="/create">
            <Button>
              <PlusCircle size={18} />
              Создать видео
            </Button>
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((video) => (
            <Link key={video.id} to={`/videos/${video.id}`}>
              <Card hover className="group cursor-pointer">
                <div className="relative aspect-[9/16] bg-bg-elevated rounded-lg overflow-hidden mb-3">
                  {video.thumbnail_url ? (
                    <img
                      src={apiUrl(video.thumbnail_url)}
                      alt={video.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <VideoIcon size={28} className="text-muted" />
                    </div>
                  )}
                  {video.status === 'completed' && (
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="h-10 w-10 rounded-full bg-accent flex items-center justify-center">
                        <Play size={18} className="text-bg" fill="currentColor" />
                      </div>
                    </div>
                  )}
                  <div className="absolute top-2 right-2">{statusBadge(video.status)}</div>
                  {video.status === 'completed' && (
                    <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-xs text-white flex items-center gap-1">
                      <Clock size={10} />
                      {video.duration_sec}s
                    </div>
                  )}
                </div>
                <p className="text-sm font-medium text-white truncate">{video.title}</p>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-xs text-muted">{new Date(video.created_at).toLocaleDateString('ru-RU')}</p>
                  {video.status === 'failed' && (
                    <span className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle size={12} />
                    </span>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
