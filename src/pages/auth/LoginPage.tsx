import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AuthShell } from '@/components/auth/AuthShell';

export function LoginPage() {
  const { signIn } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) {
      setError(error);
    } else {
      toast('Добро пожаловать!', 'success');
      navigate('/dashboard');
    }
  };

  return (
    <AuthShell
      side={
        <>
          <h2 className="text-3xl font-bold text-white leading-tight mb-4">
            Создавайте рекламные <span className="gradient-text">видео за 5 минут</span>
          </h2>
          <p className="text-muted mb-8">
            BevHubAI превращает описание вашего товара, фотографии и голос в готовый
            рекламный ролик для Reels, TikTok и Shorts.
          </p>
          <div className="space-y-3">
            {['AI-генерация сценария', 'Автоматические субтитры', 'Вертикальный MP4 1080×1920'].map((f) => (
              <div key={f} className="flex items-center gap-3">
                <Sparkles size={18} className="text-accent" />
                <span className="text-white/80 text-sm">{f}</span>
              </div>
            ))}
          </div>
        </>
      }
    >
      <h1 className="text-2xl font-bold text-white mb-2">Вход</h1>
      <p className="text-muted text-sm mb-6">Войдите в свой аккаунт BevHubAI</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Пароль"
          type="password"
          placeholder="••••••••"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <Button type="submit" size="lg" loading={loading} className="w-full">
          Войти
          <ArrowRight size={18} />
        </Button>
      </form>

      <p className="text-center text-sm text-muted mt-6">
        Нет аккаунта?{' '}
        <Link to="/register" className="text-accent hover:underline">
          Зарегистрироваться
        </Link>
      </p>
    </AuthShell>
  );
}
