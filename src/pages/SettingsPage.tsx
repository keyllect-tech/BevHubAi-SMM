import { useEffect, useState } from 'react';
import { User, Mail, Building2, Save, LogOut, Bot, Mic } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type AiProviderStatus, type TtsProviderStatus } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

export function SettingsPage() {
  const { user, workspace, signOut, refreshWorkspace } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [workspaceName, setWorkspaceName] = useState(workspace?.name || '');
  const [saving, setSaving] = useState(false);
  // Real provider status from the server: never claim an AI or voice that is not there.
  const [aiProviders, setAiProviders] = useState<AiProviderStatus[]>([]);
  const [ttsProviders, setTtsProviders] = useState<TtsProviderStatus[]>([]);
  const [aiActive, setAiActive] = useState(false);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setAiProviders(h.aiProviders ?? []);
        setTtsProviders(h.ttsProviders ?? []);
        setAiActive(Boolean(h.aiActive));
      })
      .catch(() => {
        setAiProviders([]);
        setTtsProviders([]);
      })
      .finally(() => setProvidersLoaded(true));
  }, []);

  const handleSaveWorkspace = async () => {
    setSaving(true);
    try {
      await api.updateWorkspace(workspaceName);
      await refreshWorkspace();
      toast('Настройки сохранены', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сохранить', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <AppLayout title="Настройки">
      <div className="max-w-2xl mx-auto space-y-6">
        <Card>
          <h2 className="text-lg font-semibold text-white mb-1">Профиль</h2>
          <p className="text-muted text-sm mb-5">Ваши данные аккаунта</p>

          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated">
              <div className="h-10 w-10 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                <User size={20} className="text-accent" />
              </div>
              <div className="min-w-0">
                <p className="text-sm text-muted">Имя</p>
                <p className="text-sm text-white truncate">{user?.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated">
              <div className="h-10 w-10 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                <Mail size={20} className="text-accent" />
              </div>
              <div className="min-w-0">
                <p className="text-sm text-muted">Email</p>
                <p className="text-sm text-white truncate">{user?.email}</p>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-white mb-1">Рабочее пространство</h2>
          <p className="text-muted text-sm mb-5">Название вашего рабочего пространства</p>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Building2 size={18} className="text-muted shrink-0" />
              <div className="flex-1 min-w-0">
                <Input value={workspaceName} maxLength={80} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Название" />
              </div>
            </div>
            <Button onClick={handleSaveWorkspace} loading={saving} disabled={!workspaceName.trim()}>
              <Save size={16} />
              Сохранить
            </Button>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-white mb-1">AI и озвучка</h2>
          <p className="text-muted text-sm mb-4">Что реально подключено на этом сервере</p>
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-white/80 mb-2 flex items-center gap-2">
                <Bot size={14} className="text-muted" />
                Сценарий
                {providersLoaded && (
                  <span className={aiActive ? 'text-accent' : 'text-amber-300/90'}>
                    — {aiActive ? 'AI активен' : 'AI недоступен, используется офлайн-шаблон'}
                  </span>
                )}
              </p>
              <ul className="space-y-1">
                {aiProviders.map((p) => (
                  <li key={p.id} className="text-xs text-muted flex items-start gap-2">
                    <span className={p.available ? 'text-accent' : 'text-red-400'}>•</span>
                    <span className="min-w-0">
                      {p.label}
                      {p.model ? ` (${p.model})` : ''} — {p.configured ? (p.available ? 'доступен' : 'не отвечает') : 'не настроен'}
                      {p.lastError && <span className="text-amber-300/80"> · {p.lastError.code}: {p.lastError.message}</span>}
                    </span>
                  </li>
                ))}
                {providersLoaded && aiProviders.length === 0 && <li className="text-xs text-muted">Провайдеры не найдены</li>}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium text-white/80 mb-2 flex items-center gap-2">
                <Mic size={14} className="text-muted" />
                Озвучка
              </p>
              <ul className="space-y-1">
                {ttsProviders.map((p) => (
                  <li key={p.id} className="text-xs text-muted flex items-start gap-2">
                    <span className={p.available ? 'text-accent' : 'text-red-400'}>•</span>
                    <span>
                      {p.label} — {p.available ? 'доступен' : 'не отвечает'}; языки: {(p.languages || []).join(', ') || '—'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted mt-2">
                Мужской голос и точный узбекский голос зависят от доступных провайдеров. Если голоса для языка нет, текст
                читается голосом другого языка, и видео помечается как озвучка не на нужном языке.
              </p>
            </div>
          </div>
        </Card>

        <Card className="border-red-500/20">
          <h2 className="text-lg font-semibold text-white mb-1">Аккаунт</h2>
          <p className="text-muted text-sm mb-5">Управление сессией</p>
          <Button variant="danger" onClick={handleSignOut}>
            <LogOut size={16} />
            Выйти из аккаунта
          </Button>
        </Card>
      </div>
    </AppLayout>
  );
}
