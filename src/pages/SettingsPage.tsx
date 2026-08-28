import { useState } from 'react';
import { User, Mail, Building2, Save, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
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
    if (!workspace) return;
    setSaving(true);
    await supabase.from('workspaces').update({ name: workspaceName }).eq('id', workspace.id);
    await refreshWorkspace();
    setSaving(false);
    toast('Настройки сохранены', 'success');
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <AppLayout title="Settings">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Profile */}
        <Card>
          <h2 className="text-lg font-semibold text-white mb-1">Профиль</h2>
          <p className="text-muted text-sm mb-5">Ваши данные аккаунта</p>

          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated">
              <div className="h-10 w-10 rounded-full bg-accent/10 flex items-center justify-center">
                <User size={20} className="text-accent" />
              </div>
              <div>
                <p className="text-sm text-muted">User ID</p>
                <p className="text-sm text-white font-mono">{user?.id?.slice(0, 8)}...</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated">
              <div className="h-10 w-10 rounded-full bg-accent/10 flex items-center justify-center">
                <Mail size={20} className="text-accent" />
              </div>
              <div>
                <p className="text-sm text-muted">Email</p>
                <p className="text-sm text-white">{user?.email}</p>
              </div>
            </div>
          </div>
        </Card>

        {/* Workspace */}
        <Card>
          <h2 className="text-lg font-semibold text-white mb-1">Workspace</h2>
          <p className="text-muted text-sm mb-5">Название вашего рабочего пространства</p>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Building2 size={18} className="text-muted" />
              <Input
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Workspace name"
              />
            </div>
            <Button onClick={handleSaveWorkspace} loading={saving}>
              <Save size={16} />
              Сохранить
            </Button>
          </div>
        </Card>

        {/* Mode info */}
        <Card>
          <h2 className="text-lg font-semibold text-white mb-1">Режим работы</h2>
          <p className="text-muted text-sm mb-4">Текущий режим генерации видео</p>
          <div className={`p-4 rounded-lg border ${workspace?.demo_mode ? 'bg-accent/5 border-accent/20' : 'bg-blue-500/5 border-blue-500/20'}`}>
            <p className={`text-sm font-medium ${workspace?.demo_mode ? 'text-accent' : 'text-blue-400'}`}>
              {workspace?.demo_mode ? 'Demo Mode' : 'Real AI Mode'}
            </p>
            <p className="text-xs text-muted mt-1">
              {workspace?.demo_mode
                ? 'Видео генерируется в браузере. AI APIs не настроены.'
                : 'Подключены реальные AI API провайдеры.'}
            </p>
          </div>
        </Card>

        {/* Danger zone */}
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
