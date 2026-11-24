import { useEffect, useState } from 'react';
import { Palette, Upload, Check, Image as ImageIcon } from 'lucide-react';
import { api, apiUrl } from '@/lib/api';
import { AuthenticatedImage } from '@/components/ui/AuthenticatedImage';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LANGUAGES, CTA_OPTIONS, type Project } from '@/types';

const DEFAULTS = {
  brandName: '',
  logoUrl: '',
  primaryColor: '#A3E635',
  secondaryColor: '#0B0D0C',
  defaultLanguage: 'ru',
  defaultCta: 'Купить сейчас',
};

export function BrandKitPage() {
  const { toast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [brandName, setBrandName] = useState(DEFAULTS.brandName);
  const [logoUrl, setLogoUrl] = useState(DEFAULTS.logoUrl);
  const [primaryColor, setPrimaryColor] = useState(DEFAULTS.primaryColor);
  const [secondaryColor, setSecondaryColor] = useState(DEFAULTS.secondaryColor);
  const [defaultLanguage, setDefaultLanguage] = useState(DEFAULTS.defaultLanguage);
  const [defaultCta, setDefaultCta] = useState(DEFAULTS.defaultCta);

  useEffect(() => {
    let mounted = true;
    api
      .listProjects()
      .then((data) => mounted && setProjects(data.projects))
      .catch((err) => toast(err.message, 'error'))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [toast]);

  useEffect(() => {
    if (!selectedProject) return;
    let mounted = true;
    api
      .getBrandKit(selectedProject)
      .then(({ brandKit: bk }) => {
        if (!mounted) return;
        setBrandName(bk?.brand_name ?? DEFAULTS.brandName);
        setLogoUrl(bk?.logo_url ?? DEFAULTS.logoUrl);
        setPrimaryColor(bk?.primary_color ?? DEFAULTS.primaryColor);
        setSecondaryColor(bk?.secondary_color ?? DEFAULTS.secondaryColor);
        setDefaultLanguage(bk?.default_language ?? DEFAULTS.defaultLanguage);
        setDefaultCta(bk?.default_cta ?? DEFAULTS.defaultCta);
      })
      .catch((err) => toast(err.message, 'error'));
    return () => {
      mounted = false;
    };
  }, [selectedProject, toast]);

  const handleLogoUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const { file: uploaded } = await api.uploadImage(file);
        setLogoUrl(uploaded.url);
        toast('Логотип загружен', 'success');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Ошибка загрузки логотипа', 'error');
      } finally {
        setUploading(false);
      }
    };
    input.click();
  };

  const handleSave = async () => {
    if (!selectedProject) return;
    setSaving(true);
    try {
      await api.saveBrandKit(selectedProject, {
        brand_name: brandName,
        logo_url: logoUrl,
        primary_color: primaryColor,
        secondary_color: secondaryColor,
        default_language: defaultLanguage,
        default_cta: defaultCta,
      });
      toast('Brand Kit сохранён', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось сохранить Brand Kit', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppLayout title="Бренд-кит">
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </AppLayout>
    );
  }

  const selectClass =
    'w-full h-10 px-3.5 rounded-lg bg-bg-elevated border border-border-default text-white focus:outline-none focus:border-accent/50 transition-colors';

  return (
    <AppLayout title="Бренд-кит">
      <div className="max-w-2xl mx-auto">
        <p className="text-muted text-sm mb-6">Настройте бренд для каждого проекта</p>

        {projects.length === 0 ? (
          <Card className="text-center py-12">
            <Palette size={40} className="text-muted mx-auto mb-3" />
            <p className="text-white font-medium mb-1">Нет проектов</p>
            <p className="text-muted text-sm">Создайте проект, чтобы настроить Brand Kit</p>
          </Card>
        ) : (
          <>
            <div className="space-y-1.5 mb-6">
              <label className="block text-sm font-medium text-white/90">Проект</label>
              <select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)} className={selectClass}>
                <option value="" className="bg-bg-card">
                  Выберите проект
                </option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id} className="bg-bg-card">
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {selectedProject && (
              <Card>
                <div className="space-y-5">
                  <div>
                    <label className="block text-sm font-medium text-white/90 mb-2">Логотип</label>
                    <div className="flex items-center gap-4">
                      <div className="h-16 w-16 rounded-lg bg-bg-elevated border border-border-default flex items-center justify-center overflow-hidden shrink-0">
                        {logoUrl ? (
                          <AuthenticatedImage src={apiUrl(logoUrl)} alt="Логотип" className="w-full h-full object-contain" />
                        ) : (
                          <ImageIcon size={24} className="text-muted" />
                        )}
                      </div>
                      <Button variant="secondary" onClick={handleLogoUpload} loading={uploading}>
                        <Upload size={16} />
                        Загрузить
                      </Button>
                    </div>
                  </div>

                  <Input label="Название бренда" placeholder="Nike, Dunya Jewellery..." value={brandName} onChange={(e) => setBrandName(e.target.value)} />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <ColorField label="Основной цвет" value={primaryColor} onChange={setPrimaryColor} />
                    <ColorField label="Дополнительный цвет" value={secondaryColor} onChange={setSecondaryColor} />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-white/90">Язык по умолчанию</label>
                      <select value={defaultLanguage} onChange={(e) => setDefaultLanguage(e.target.value)} className={selectClass}>
                        {LANGUAGES.map((l) => (
                          <option key={l.id} value={l.id} className="bg-bg-card">
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-white/90">CTA по умолчанию</label>
                      <select value={defaultCta} onChange={(e) => setDefaultCta(e.target.value)} className={selectClass}>
                        {CTA_OPTIONS.map((opt) => (
                          <option key={opt} value={opt} className="bg-bg-card">
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <Button onClick={handleSave} loading={saving} size="lg" className="w-full">
                    <Check size={18} />
                    Сохранить Brand Kit
                  </Button>
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-white/90">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 rounded-lg border border-border-default bg-transparent cursor-pointer shrink-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 min-w-0 h-10 px-3 rounded-lg bg-bg-elevated border border-border-default text-white text-sm focus:outline-none focus:border-accent/50"
        />
      </div>
    </div>
  );
}
