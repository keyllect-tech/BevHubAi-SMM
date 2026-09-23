import { useCallback, useEffect, useState } from 'react';
import { FolderKanban, Plus, Trash2, Pencil, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import type { Project } from '@/types';

export function ProjectsPage() {
  const { toast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.listProjects();
      setProjects(data.projects);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось загрузить проекты', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setDescription('');
    setShowModal(true);
  };

  const openEdit = (project: Project) => {
    setEditing(project);
    setName(project.name);
    setDescription(project.description);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      if (editing) {
        await api.updateProject(editing.id, name, description);
        toast('Проект обновлён', 'success');
      } else {
        await api.createProject(name, description);
        toast('Проект создан', 'success');
      }
      setShowModal(false);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сохранить проект', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить проект? Все видео в нём останутся, но без проекта.')) return;
    try {
      await api.deleteProject(id);
      toast('Проект удалён', 'info');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось удалить проект', 'error');
    }
  };

  return (
    <AppLayout title="Projects">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <p className="text-muted text-sm">Управляйте вашими рекламными проектами</p>
        <Button onClick={openCreate}>
          <Plus size={18} />
          New Project
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-xl bg-bg-card border border-border-default p-5 animate-pulse h-32 shimmer" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Card className="text-center py-12">
          <FolderKanban size={40} className="text-muted mx-auto mb-3" />
          <p className="text-white font-medium mb-1">Нет проектов</p>
          <p className="text-muted text-sm mb-4">Создайте проект для организации видео</p>
          <Button onClick={openCreate}>
            <Plus size={18} />
            Создать проект
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Card key={project.id} hover>
              <div className="flex items-start justify-between mb-3">
                <div className="h-10 w-10 rounded-lg bg-accent/10 flex items-center justify-center">
                  <FolderKanban size={20} className="text-accent" />
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEdit(project)}
                    aria-label="Редактировать"
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-white hover:bg-bg-elevated transition-colors"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => handleDelete(project.id)}
                    aria-label="Удалить"
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-muted hover:text-red-400 hover:bg-bg-elevated transition-colors"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <h3 className="text-white font-medium mb-1 break-words">{project.name}</h3>
              <p className="text-sm text-muted line-clamp-2">{project.description || 'Без описания'}</p>
              <p className="text-xs text-muted/60 mt-3">{new Date(project.created_at).toLocaleDateString('ru-RU')}</p>
            </Card>
          ))}
        </div>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setShowModal(false)}
        >
          <div
            className="w-full max-w-md bg-bg-card border border-border-default rounded-xl p-6 animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">{editing ? 'Редактировать' : 'Новый проект'}</h2>
              <button onClick={() => setShowModal(false)} aria-label="Закрыть" className="text-muted hover:text-white">
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4">
              <Input label="Название" placeholder="Nike, Dunya Jewellery..." maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
              <Textarea
                label="Описание"
                placeholder="Краткое описание проекта"
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <Button onClick={handleSave} className="w-full" size="lg" loading={saving} disabled={!name.trim()}>
                {editing ? 'Сохранить' : 'Создать'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
