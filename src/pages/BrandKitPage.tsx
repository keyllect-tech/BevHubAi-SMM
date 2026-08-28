import { useEffect, useState } from 'react';
import { Palette, Upload, Check, Image as ImageIcon } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { uploadImage } from '@/lib/storage';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LANGUAGES, CTA_OPTIONS, type Project, type BrandKit } from '@/types';

export function BrandKitPage() {
  const { workspace, user } = useAuth();
  const { toast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [brandKit, setBrandKit] = useState<BrandKit | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [brandName, setBrandName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#A3E635');
  const [secondaryColor, setSecondaryColor] = useState('#0B0D0C');
  const [defaultLanguage, setDefaultLanguage] = useState('ru');
  const [defaultCta, setDefaultCta] = useState('Купить сейчас');

  useEffect(() => {
    if (!workspace) return;
    const load = async () => {
      const { data } = await supabase
        .from('projects')
        .select('*')
        .eq('workspace_id', workspace.id)
        .order('created_at', { ascending: false });
      setProjects(data as Project[] || []);
      setLoading(false);
    };
    load();
  }, [workspace]);

  useEffect(() => {
    if (!selectedProject) return;
    const load = async () => {
      const { data } = await supabase
        .from('brand_kits')
        .select('*')
        .eq('project_id', selectedProject)
        .maybeSingle();
      const bk = data as BrandKit | null;
      setBrandKit(bk);
      if (bk) {
        setBrandName(bk.brand_name);
        setLogoUrl(bk.logo_url);
        setPrimaryColor(bk.primary_color);
        setSecondaryColor(bk.secondary_color);
        setDefaultLanguage(bk.default_language);
        setDefaultCta(bk.default_cta);
      } else {
        setBrandName('');
        setLogoUrl('');
        setPrimaryColor('#A3E635');
        setSecondaryColor('#0B0D0C');
        setDefaultLanguage('ru');
        setDefaultCta('Купить сейчас');
      }
    };
    load();
  }, [selectedProject]);

  const handleLogoUpload = async () => {
    if (!user) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const { url, error } = await uploadImage(user.id, file);
      if (error) {
        toast('Ошибка загрузки логотипа', 'error');
      } else {
        setLogoUrl(url);
        toast('Логотип загружен', 'success');
      }
    };
    input.click();
  };

  const handleSave = async () => {
    if (!selectedProject) return;
    setSaving(true);
    if (brandKit) {
      await supabase
        .from('brand_kits')
        .update({ brand_name: brandName, logo_url: logoUrl, primary_color: primaryColor, secondary_color: secondaryColor, default_language: defaultLanguage, default_cta: defaultCta })
        .eq('id', brandKit.id);
    } else {
      await supabase.from('brand_kits').insert({
        project_id: selectedProject,
        brand_name: brandName,
        logo_url: logoUrl,
        primary_color: primaryColor,
        secondary_color: secondaryColor,
        default_language: defaultLanguage,
        default_cta: defaultCta,
      });
    }
    setSaving(false);
    toast('Brand Kit сохранён', 'success');
  };

  if (loading) {
    return (
      <AppLayout title="Brand Kit">
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Brand Kit">
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
            {/* Project selector */}
            <div className="space-y-1.5 mb-6">
              <label className="block text-sm font-medium text-white/90">Проект</label>
              <select
                value={selectedProject}
                onChange={(e) => setSelectedProject(e.target.value)}
                className="w-full h-10 px-3.5 rounded-lg bg-bg-elevated border border-border-default text-white focus:outline-none focus:border-accent/50 transition-colors"
              >
                <option value="" className="bg-bg-card">Выберите проект</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id} className="bg-bg-card">{p.name}</option>
                ))}
              </select>
            </div>

            {selectedProject && (
              <Card>
                <div className="space-y-5">
                  {/* Logo */}
                  <div>
                    <label className="block text-sm font-medium text-white/90 mb-2">Логотип</label>
                    <div className="flex items-center gap-4">
                      <div className="h-16 w-16 rounded-lg bg-bg-elevated border border-border-default flex items-center justify-center overflow-hidden shrink-0">
                        {logoUrl ? (
                          <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
                        ) : (
                          <ImageIcon size={24} className="text-muted" />
                        )}
                      </div>
                      <Button variant="secondary" onClick={handleLogoUpload}>
                        <Upload size={16} />
                        Загрузить
                      </Button>
                    </div>
                  </div>

                  <Input
                    label="Название бренда"
                    placeholder="Nike, Dunya Jewellery..."
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                  />

                  {/* Colors */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-white/90">Primary color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={primaryColor}
                          onChange={(e) => setPrimaryColor(e.target.value)}
                          className="h-10 w-12 rounded-lg border border-border-default bg-transparent cursor-pointer"
                        />
                        <input
                          type="text"
                          value={primaryColor}
                          onChange={(e) => setPrimaryColor(e.target.value)}
                          className="flex-1 h-10 px-3 rounded-lg bg-bg-elevated border border-border-default text-white text-sm focus:outline-none focus:border-accent/50"
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-white/90">Secondary color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={secondaryColor}
                          onChange={(e) => setSecondaryColor(e.target.value)}
                          className="h-10 w-12 rounded-lg border border-border-default bg-transparent cursor-pointer"
                        />
                        <input
                          type="text"
                          value={secondaryColor}
                          onChange={(e) => setSecondaryColor(e.target.value)}
                          className="flex-1 h-10 px-3 rounded-lg bg-bg-elevated border border-border-default text-white text-sm focus:outline-none focus:border-accent/50"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Defaults */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-white/90">Язык по умолчанию</label>
                      <select
                        value={defaultLanguage}
                        onChange={(e) => setDefaultLanguage(e.target.value)}
                        className="w-full h-10 px-3.5 rounded-lg bg-bg-elevated border border-border-default text-white focus:outline-none focus:border-accent/50 transition-colors"
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.id} value={l.id} className="bg-bg-card">{l.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-white/90">CTA по умолчанию</label>
                      <select
                        value={defaultCta}
                        onChange={(e) => setDefaultCta(e.target.value)}
                        className="w-full h-10 px-3.5 rounded-lg bg-bg-elevated border border-border-default text-white focus:outline-none focus:border-accent/50 transition-colors"
                      >
                        {CTA_OPTIONS.map((opt) => (
                          <option key={opt} value={opt} className="bg-bg-card">{opt}</option>
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
