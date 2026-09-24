import { useState } from 'react';
import { User, Mail, Building2, Save, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
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
          <h2 className="text-lg font-semibold text-white mb-1">Режим работы</h2>
          <p className="text-muted text-sm mb-4">Текущий режим генерации видео</p>
          <div className="p-4 rounded-lg border bg-accent/5 border-accent/20">
            <p className="text-sm font-medium text-accent">Автономный режим</p>
            <p className="text-xs text-muted mt-1">
              Сценарий, субтитры, озвучка и монтаж выполняются на вашем сервере и работают без внешних ключей. Если
              подключить ключ OpenAI, сценарии начнёт писать он.
            </p>
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
