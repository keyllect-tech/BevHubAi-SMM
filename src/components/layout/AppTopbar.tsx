import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlusCircle, Bell } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function AppTopbar({ title, children }: { title: string; children?: ReactNode }) {
  const navigate = useNavigate();

  return (
    <header className="h-16 border-b border-border-default bg-bg-card/50 backdrop-blur-sm sticky top-0 z-30">
      <div className="h-full px-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        <div className="flex items-center gap-3">
          {children}
          <button className="h-9 w-9 rounded-lg flex items-center justify-center text-muted hover:text-white hover:bg-bg-elevated transition-colors">
            <Bell size={18} />
          </button>
          <Button size="md" onClick={() => navigate('/create')}>
            <PlusCircle size={18} />
            Create New Video
          </Button>
        </div>
      </div>
    </header>
  );
}
