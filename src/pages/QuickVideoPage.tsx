import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Wand2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/api';
import { newRequestId } from '@/lib/id';
import { useToast } from '@/components/ui/Toast';

interface QuickForm {
  request: string;
  price: string;
  websiteUrl: string;
}

const EMPTY: QuickForm = { request: '', price: '', websiteUrl: '' };

const EXAMPLES = [
  'Уютная двухкомнатная квартира 65 м² в новом ЖК рядом с парком. Свежий ремонт, подземный паркинг, ипотека. Звоните!',
  'Кофейня «Заря»: свежая обжарка, завтраки до 12 и кофе с собой. Заходите каждый день с 8 утра!',
  'Продаём смартфоны с гарантией 2 года. Рассрочка 0%, доставка по всему Узбекистану за день.',
];

export function QuickVideoPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [form, setForm] = useState<QuickForm>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  // One request id per page: re-clicking "Generate" after a failed network request returns the
  // already created video (the server dedupes by clientRequestId) instead of making a duplicate.
  const requestIdRef = useRef(newRequestId());

  const set = (patch: Partial<QuickForm>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    if (submitting || form.request.trim().length < 15) return;
    setSubmitting(true);
    try {
      const { video } = await api.createAutoVideo({
        clientRequestId: requestIdRef.current,
        request: form.request.trim(),
        price: form.price.trim(),
        websiteUrl: form.websiteUrl.trim(),
      });
      navigate(`/videos/${video.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Не удалось создать видео', 'error');
      setSubmitting(false);
    }
  };

  return (
    <AppLayout title="Быстрое видео">
      <div className="max-w-2xl space-y-5">
        <p className="text-sm text-muted">
          Опишите рекламу одним текстом — сервер сам определит язык, тип рекламы и стиль, напишет
          сценарий, озвучит его и соберёт вертикальное 15-секундное видео.
        </p>
        <div className="bg-bg-card border border-border-default rounded-2xl p-5 space-y-4">
          <Textarea
            label="Что рекламируем?"
            placeholder="Товар или услуга, для кого, главное преимущество, призыв…"
            value={form.request}
            onChange={(e) => set({ request: e.target.value.slice(0, 1200) })}
            rows={5}
            hint={`${form.request.length}/1200`}
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => set({ request: ex })}
                className="text-xs px-3 py-1.5 rounded-full bg-bg-elevated border border-border-default text-muted hover:text-white transition-colors"
              >
                Пример {i + 1}
              </button>
            ))}
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Input
              label="Цена (необязательно)"
              placeholder="990 000 сум"
              value={form.price}
              onChange={(e) => set({ price: e.target.value.slice(0, 50) })}
              hint="Появится крупно в конце ролика"
            />
            <Input
              label="Сайт или соцсеть (необязательно)"
              placeholder="https://…"
              value={form.websiteUrl}
              onChange={(e) => set({ websiteUrl: e.target.value.trim().slice(0, 300) })}
              hint="Ссылка в финальном кадре"
            />
          </div>
          <Button onClick={submit} disabled={submitting || form.request.trim().length < 15} className="w-full">
            {submitting ? 'Нейросеть пишет сценарий и собирает видео…' : <><Wand2 size={16} /> Сгенерировать видео</>}
          </Button>
          <p className="text-xs text-muted">
            15 секунд, вертикальное видео с озвучкой и субтитрами. Нужно рекламировать товар по фото?{' '}
            <Link to="/create" className="text-accent hover:underline">
              Мастер создания видео
            </Link>
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
