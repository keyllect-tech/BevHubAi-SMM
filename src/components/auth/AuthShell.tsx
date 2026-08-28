import { Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

export function AuthShell({ children, side }: { children: React.ReactNode; side: React.ReactNode }) {
  return (
    <div className="min-h-screen flex">
      {/* Left panel */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-bg-card items-center justify-center p-12 overflow-hidden">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-accent/20 blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
        </div>
        <div className="relative z-10 max-w-md">{side}</div>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-12 bg-bg">
        <Link to="/" className="flex items-center gap-2 mb-10">
          <div className="h-9 w-9 rounded-lg bg-accent flex items-center justify-center">
            <Zap size={20} className="text-bg" fill="currentColor" />
          </div>
          <span className="text-xl font-bold text-white">BevHubAI</span>
        </Link>
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
