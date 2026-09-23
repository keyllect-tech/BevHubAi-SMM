import { useEffect, useState } from 'react';
import { Check, Sparkles, Zap, Crown, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PLANS, type Subscription, type Usage } from '@/types';

const planIcons = { starter: Sparkles, pro: Zap, agency: Crown };

export function BillingPage() {
  const { toast } = useToast();
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [changingTo, setChangingTo] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    api
      .billing()
      .then((data) => {
        if (!mounted) return;
        setSubscription(data.subscription);
        setUsage(data.usage);
      })
      .catch((err) => toast(err.message, 'error'))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [toast]);

  const handleUpgrade = async (planId: string) => {
    const plan = PLANS.find((p) => p.id === planId);
    if (!plan || changingTo) return;
    setChangingTo(planId);
    try {
      const data = await api.changePlan(plan.id);
      setSubscription(data.subscription);
      setUsage(data.usage);
      toast(`План изменён на ${plan.name}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сменить план', 'error');
    } finally {
      setChangingTo(null);
    }
  };

  const videosUsed = usage?.videos_created || 0;
  const limit = subscription?.monthly_limit || 15;
  const usedPct = Math.min(100, (videosUsed / limit) * 100);
  const isLimitReached = videosUsed >= limit;
  const currentPlan = subscription?.plan || 'starter';

  if (loading) {
    return (
      <AppLayout title="Billing">
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Billing">
      <div className="max-w-4xl mx-auto">
        <Card className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-1">Использование</h2>
          <p className="text-muted text-sm mb-5">Текущий месяц</p>

          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-white">Videos used</span>
            <span className="text-sm font-medium text-white">
              {videosUsed} / {limit}
            </span>
          </div>
          <div className="h-3 bg-bg-elevated rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${isLimitReached ? 'bg-red-500' : 'bg-accent'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
          {isLimitReached && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
              <TrendingUp size={18} className="text-red-400" />
              <p className="text-sm text-red-400">Лимит генераций исчерпан. Смените тариф.</p>
            </div>
          )}
        </Card>

        <h2 className="text-lg font-semibold text-white mb-4">Тарифные планы</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map((plan) => {
            const Icon = planIcons[plan.id as keyof typeof planIcons] || Sparkles;
            const isCurrent = currentPlan === plan.id;
            return (
              <Card key={plan.id} className={`relative ${isCurrent ? 'border-accent/40 accent-glow' : ''}`}>
                {isCurrent && (
                  <div className="absolute -top-2 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-accent text-bg text-xs font-semibold">
                    Current
                  </div>
                )}
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-10 w-10 rounded-lg bg-accent/10 flex items-center justify-center">
                    <Icon size={20} className="text-accent" />
                  </div>
                  <h3 className="text-white font-semibold">{plan.name}</h3>
                </div>
                <p className="text-3xl font-bold text-white mb-1">
                  ${plan.price}
                  <span className="text-sm font-normal text-muted">/month</span>
                </p>
                <p className="text-sm text-muted mb-4">{plan.monthly_limit} videos / month</p>

                <ul className="space-y-2 mb-5">
                  {[
                    `${plan.monthly_limit} videos per month`,
                    'AI script generation',
                    'Auto subtitles',
                    '1080×1920 vertical format',
                    plan.id === 'agency' ? 'Priority support' : 'Community support',
                  ].map((feat) => (
                    <li key={feat} className="flex items-center gap-2 text-sm text-white/80">
                      <Check size={15} className="text-accent shrink-0" />
                      {feat}
                    </li>
                  ))}
                </ul>

                <Button
                  variant={isCurrent ? 'secondary' : 'primary'}
                  className="w-full"
                  disabled={isCurrent || Boolean(changingTo)}
                  loading={changingTo === plan.id}
                  onClick={() => handleUpgrade(plan.id)}
                >
                  {isCurrent ? 'Current plan' : 'Switch'}
                </Button>
              </Card>
            );
          })}
        </div>

        <p className="text-center text-xs text-muted mt-6">Это mock биллинг для MVP. Реальная оплата будет подключена позже.</p>
      </div>
    </AppLayout>
  );
}
