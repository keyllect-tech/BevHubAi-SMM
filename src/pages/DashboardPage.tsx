import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Video as VideoIcon, Calendar, FolderKanban, Sparkles, Play, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, Badge } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { Video, Project, Subscription, Usage } from '@/types';

export function DashboardPage() {
  const { workspace } = useAuth();
  const navigate = useNavigate();
  const [videos, setVideos] = useState<Video[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspace) return;
    const load = async () => {
      const [videosRes, projectsRes, subRes] = await Promise.all([
        supabase
          .from('videos')
          .select('*')
          .eq('workspace_id', workspace.id)
          .order('created_at', { ascending: false })
          .limit(6),
        supabase.from('projects').select('*').eq('workspace_id', workspace.id),
        supabase
          .from('subscriptions')
          .select('*')
          .eq('workspace_id', workspace.id)
          .maybeSingle(),
      ]);

      setVideos(videosRes.data as Video[] || []);
      setProjects(projectsRes.data as Project[] || []);
      setSubscription(subRes.data as Subscription | null);

      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const usageRes = await supabase
        .from('usage')
        .select('*')
        .eq('workspace_id', workspace.id)
        .eq('month_start', monthStart)
        .maybeSingle();
      setUsage(usageRes.data as Usage | null);
      setLoading(false);
    };
    load();
  }, [workspace]);

  const stats = [
    {
      label: 'Всего видео',
      value: videos.length,
      icon: VideoIcon,
      color: 'text-accent',
    },
    {
      label: 'Создано в этом месяце',
      value: usage?.videos_created || 0,
      icon: Calendar,
      color: 'text-blue-400',
    },
    {
      label: 'Проекты',
      value: projects.length,
      icon: FolderKanban,
      color: 'text-purple-400',
    },
    {
      label: 'Остаток генераций',
      value: `${(subscription?.monthly_limit || 15) - (usage?.videos_created || 0)} / ${subscription?.monthly_limit || 15}`,
      icon: Sparkles,
      color: 'text-accent',
    },
  ];

  const statusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge variant="success">Completed</Badge>;
      case 'processing':
        return <Badge variant="warning">Processing</Badge>;
      case 'queued':
        return <Badge variant="default">Queued</Badge>;
      case 'failed':
        return <Badge variant="error">Failed</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <AppLayout title="Dashboard">
      {workspace?.demo_mode && (
        <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-lg bg-accent/10 border border-accent/20">
          <Sparkles size={18} className="text-accent shrink-0" />
          <p className="text-sm text-white/90">
            <span className="text-accent font-medium">Demo Mode активен.</span> AI APIs не настроены —
            видео генерируется локально в браузере. Добавьте API ключи в настройках для Real AI Mode.
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label} hover>
              <div className="flex items-start justify-between mb-3">
                <div className={`p-2 rounded-lg bg-bg-elevated ${stat.color}`}>
                  <Icon size={20} />
                </div>
              </div>
              <p className="text-2xl font-bold text-white">{stat.value}</p>
              <p className="text-sm text-muted mt-1">{stat.label}</p>
            </Card>
          );
        })}
      </div>

      {/* Recent Videos */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Recent Videos</h2>
        <Link to="/videos" className="text-sm text-accent hover:underline">
          Все видео →
        </Link>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <div className="aspect-video bg-bg-elevated rounded-lg mb-3 shimmer" />
              <div className="h-4 bg-bg-elevated rounded w-2/3 mb-2 shimmer" />
              <div className="h-3 bg-bg-elevated rounded w-1/3 shimmer" />
            </Card>
          ))}
        </div>
      ) : videos.length === 0 ? (
        <Card className="text-center py-12">
          <VideoIcon size={40} className="text-muted mx-auto mb-3" />
          <p className="text-white font-medium mb-1">Пока нет видео</p>
          <p className="text-muted text-sm mb-4">Создайте первое рекламное видео</p>
          <Button onClick={() => navigate('/create')}>
            <Sparkles size={18} />
            Создать видео
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {videos.map((video) => (
            <Link key={video.id} to={`/videos/${video.id}`}>
              <Card hover className="group cursor-pointer">
                <div className="relative aspect-[9/16] bg-bg-elevated rounded-lg overflow-hidden mb-3 max-h-48">
                  {video.thumbnail_url ? (
                    <img
                      src={video.thumbnail_url}
                      alt={video.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <VideoIcon size={32} className="text-muted" />
                    </div>
                  )}
                  {video.status === 'completed' && (
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="h-10 w-10 rounded-full bg-accent flex items-center justify-center">
                        <Play size={20} className="text-bg" fill="currentColor" />
                      </div>
                    </div>
                  )}
                  <div className="absolute top-2 right-2">{statusBadge(video.status)}</div>
                </div>
                <p className="text-sm font-medium text-white truncate">{video.title}</p>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-xs text-muted">
                    {new Date(video.created_at).toLocaleDateString('ru-RU')}
                  </p>
                  {video.status === 'failed' && (
                    <span className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle size={12} />
                      Error
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
