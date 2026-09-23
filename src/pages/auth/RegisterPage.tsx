import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AuthShell } from '@/components/auth/AuthShell';

export function RegisterPage() {
  const { signUp } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError('');
    if (password !== confirm) {
      setError('Пароли не совпадают');
      return;
    }
    if (password.length < 8) {
      setError('Пароль должен быть не менее 8 символов');
      return;
    }
    setLoading(true);
    const { error } = await signUp(email, password, name);
    setLoading(false);
    if (error) {
      setError(error);
    } else {
      toast('Аккаунт создан! Добро пожаловать.', 'success');
      navigate('/dashboard');
    }
  };

  return (
    <AuthShell
      side={
        <>
          <h2 className="text-3xl font-bold text-white leading-tight mb-4">
            Начните создавать <span className="gradient-text">рекламу сегодня</span>
          </h2>
          <p className="text-muted mb-8">
            Зарегистрируйтесь и получите доступ к AI-генерации видео. Без дизайнера,
            без монтажёра, без сложного софта.
          </p>
          <div className="space-y-3">
            {['15 видео в месяц на старте', 'Поддержка русского и узбекского', 'Готовый MP4 для соцсетей'].map((f) => (
              <div key={f} className="flex items-center gap-3">
                <Sparkles size={18} className="text-accent" />
                <span className="text-white/80 text-sm">{f}</span>
              </div>
            ))}
          </div>
        </>
      }
    >
      <h1 className="text-2xl font-bold text-white mb-2">Регистрация</h1>
      <p className="text-muted text-sm mb-6">Создайте аккаунт за минуту</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Имя"
          type="text"
          placeholder="Иван Иванов"
          autoComplete="name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
          placeholder="Минимум 8 символов"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Input
          label="Подтвердите пароль"
          type="password"
          placeholder="••••••••"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {error && (
          <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <Button type="submit" size="lg" loading={loading} className="w-full">
          Создать аккаунт
          <ArrowRight size={18} />
        </Button>
      </form>

      <p className="text-center text-sm text-muted mt-6">
        Уже есть аккаунт?{' '}
        <Link to="/login" className="text-accent hover:underline">
          Войти
        </Link>
      </p>
    </AuthShell>
  );
}
