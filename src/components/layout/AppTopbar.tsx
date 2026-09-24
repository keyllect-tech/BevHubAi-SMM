import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlusCircle, Bell } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function AppTopbar({ title, children }: { title: string; children?: ReactNode }) {
  const navigate = useNavigate();

  return (
    <header className="h-16 border-b border-border-default bg-bg-card/50 backdrop-blur-sm sticky top-0 z-30">
      <div className="h-full px-4 md:px-6 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-white truncate min-w-0">{title}</h1>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {children}
          <button
            aria-label="Уведомления"
            className="hidden sm:flex h-9 w-9 rounded-lg items-center justify-center text-muted hover:text-white hover:bg-bg-elevated transition-colors"
          >
            <Bell size={18} />
          </button>
          <Button size="md" onClick={() => navigate('/create')} aria-label="Создать видео">
            <PlusCircle size={18} />
            <span className="hidden sm:inline">Создать видео</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
