import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderKanban,
  PlusCircle,
  Video as VideoIcon,
  Palette,
  Settings,
  CreditCard,
  LogOut,
  Zap,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/create', label: 'Create Video', icon: PlusCircle },
  { to: '/videos', label: 'My Videos', icon: VideoIcon },
  { to: '/brand-kit', label: 'Brand Kit', icon: Palette },
  { to: '/billing', label: 'Billing', icon: CreditCard },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function useSignOut() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  return async () => {
    await signOut();
    navigate('/');
  };
}

export function AppSidebar() {
  const { workspace, user } = useAuth();
  const handleSignOut = useSignOut();

  return (
    <aside className="hidden md:flex w-64 shrink-0 border-r border-border-default bg-bg-card flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="h-16 flex items-center gap-2 px-6 border-b border-border-default">
        <div className="h-8 w-8 rounded-lg bg-accent flex items-center justify-center">
          <Zap size={18} className="text-bg" fill="currentColor" />
        </div>
        <span className="text-lg font-bold text-white">BevHubAI</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-muted hover:text-white hover:bg-bg-elevated'
                }`
              }
            >
              <Icon size={18} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Workspace info + sign out */}
      <div className="p-3 border-t border-border-default">
        {workspace?.demo_mode && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-accent/10 border border-accent/20">
            <p className="text-xs text-accent font-medium">Demo Mode</p>
            <p className="text-xs text-muted mt-0.5">AI APIs не настроены</p>
          </div>
        )}
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="h-8 w-8 rounded-full bg-bg-elevated flex items-center justify-center text-sm font-medium text-accent shrink-0">
            {user?.email?.[0]?.toUpperCase() ?? 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white truncate">{user?.email}</p>
            <p className="text-xs text-muted truncate">{workspace?.name}</p>
          </div>
          <button
            onClick={handleSignOut}
            className="text-muted hover:text-white transition-colors shrink-0"
            title="Выйти"
            aria-label="Выйти"
          >
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Horizontal nav shown instead of the sidebar below the md breakpoint. */
export function MobileNav() {
  const handleSignOut = useSignOut();

  return (
    <nav className="md:hidden border-b border-border-default bg-bg-card">
      <div className="flex items-center gap-1 px-2 py-2 overflow-x-auto scrollbar-thin">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap shrink-0 transition-colors ${
                  isActive ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-white'
                }`
              }
            >
              <Icon size={16} />
              {item.label}
            </NavLink>
          );
        })}
        <button
          onClick={handleSignOut}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-muted hover:text-white whitespace-nowrap shrink-0"
        >
          <LogOut size={16} />
          Выйти
        </button>
      </div>
    </nav>
  );
}
