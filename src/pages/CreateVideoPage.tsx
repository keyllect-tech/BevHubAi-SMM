import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Package,
  Image as ImageIcon,
  Mic,
  Film,
  Rocket,
  ArrowRight,
  ArrowLeft,
  Upload,
  X,
  Check,
  Link as LinkIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { uploadImage } from '@/lib/storage';
import { VIDEO_STYLES, LANGUAGES, VOICE_TYPES, CTA_OPTIONS, type Project } from '@/types';

interface UploadedImage {
  url: string;
  file: File;
  name: string;
}

interface ScriptData {
  hook: string;
  body: string;
  cta: string;
  fullScript: string;
  scenes: string[];
}

const STEPS = [
  { id: 0, label: 'Product', icon: Package },
  { id: 1, label: 'Media', icon: ImageIcon },
  { id: 2, label: 'Voice', icon: Mic },
  { id: 3, label: 'Style', icon: Film },
  { id: 4, label: 'Generate', icon: Rocket },
];

export function CreateVideoPage() {
  const { workspace, user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  // Step 1: Product
  const [productName, setProductName] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [price, setPrice] = useState('');
  const [cta, setCta] = useState<string>(CTA_OPTIONS[0]);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [projectId, setProjectId] = useState<string>('');

  // Step 2: Media
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Step 3: Voice
  const [voiceType, setVoiceType] = useState('female');
  const [language, setLanguage] = useState('ru');
  const [customVoiceFile, setCustomVoiceFile] = useState<File | null>(null);

  // Step 4: Style
  const [style, setStyle] = useState('dynamic');

  // Step 5: Generate
  const [generating, setGenerating] = useState(false);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [scriptData, setScriptData] = useState<ScriptData | null>(null);

  const handleGenerateScript = async () => {
    setGeneratingScript(true);
    try {
      // Lazy import generateScript from pipeline or scriptGenerator
      const { generateScript } = await import('@/lib/ai/scriptGenerator');
      const data = await generateScript({
        productName,
        productDescription,
        price,
        cta,
        language,
        style
      });
      setScriptData(data);
    } catch {
      toast('Не удалось сгенерировать сценарий', 'error');
    }
    setGeneratingScript(false);
  };

  const loadProjects = async () => {
    if (!workspace || projectsLoaded) return;
    const { data } = await supabase
      .from('projects')
      .select('*')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false });
    setProjects(data as Project[] || []);
    setProjectsLoaded(true);
  };

  const handleFiles = async (files: FileList) => {
    if (!user) return;
    const valid = Array.from(files).filter(
      (f) => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) && f.size < 10_000_000
    );
    if (valid.length === 0) {
      toast('Только JPG, PNG, WEBP до 10MB', 'error');
      return;
    }
    setUploading(true);
    for (const file of valid) {
      const { url, error } = await uploadImage(user.id, file);
      if (error) {
        toast(`Ошибка загрузки: ${file.name}`, 'error');
      } else {
        setImages((prev) => [...prev, { url, file, name: file.name }]);
      }
    }
    setUploading(false);
  };

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const canProceed = () => {
    switch (step) {
      case 0:
        return productName.trim().length > 0 && productDescription.trim().length > 0;
      case 1:
        return images.length > 0;
      case 2:
        return voiceType && language;
      case 3:
        return style;
      default:
        return true;
    }
  };

  const handleGenerate = async () => {
    if (!workspace) return;
    setGenerating(true);

    try {
      // Create video record
      const { data: video, error: vErr } = await supabase
        .from('videos')
        .insert({
          workspace_id: workspace.id,
          project_id: projectId || null,
          title: productName,
          product_name: productName,
          product_description: productDescription,
          price,
          cta,
          website_url: websiteUrl,
          language,
          voice_type: voiceType,
          style,
          status: 'processing',
          duration_sec: 20,
          script_hook: scriptData ? scriptData.hook : null,
          script_body: scriptData ? scriptData.body : null,
          script_cta: scriptData ? scriptData.cta : null,
        })
        .select()
        .single();

      if (vErr || !video) throw new Error('Failed to create video');

      // Create video assets
      for (let i = 0; i < images.length; i++) {
        await supabase.from('video_assets').insert({
          video_id: video.id,
          asset_type: 'image',
          file_url: images[i].url,
          file_name: images[i].name,
          mime_type: images[i].file.type,
          sort_order: i,
        });
      }

      // Create generation job
      await supabase.from('generation_jobs').insert({
        video_id: video.id,
        status: 'processing',
        progress: 0,
        current_step: 'Queued',
        provider: 'demo',
        started_at: new Date().toISOString(),
      });

      // Increment usage
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const { data: existingUsage } = await supabase
        .from('usage')
        .select('*')
        .eq('workspace_id', workspace.id)
        .eq('month_start', monthStart)
        .maybeSingle();

      if (existingUsage) {
        await supabase
          .from('usage')
          .update({ videos_created: (existingUsage as { videos_created: number }).videos_created + 1 })
          .eq('id', (existingUsage as { id: string }).id);
      } else {
        await supabase.from('usage').insert({
          workspace_id: workspace.id,
          month_start: monthStart,
          videos_created: 1,
        });
      }

      // Navigate to processing page
      navigate(`/videos/${video.id}?processing=1`);
    } catch {
      toast('Ошибка при запуске генерации', 'error');
      setGenerating(false);
    }
  };

  return (
    <AppLayout title="Create Video">
      <div className="max-w-3xl mx-auto">
        {/* Stepper */}
        <div className="flex items-center justify-between mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const isActive = step === s.id;
            const isDone = step > s.id;
            return (
              <div key={s.id} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors ${
                      isActive
                        ? 'bg-accent text-bg'
                        : isDone
                        ? 'bg-accent/20 text-accent'
                        : 'bg-bg-elevated text-muted'
                    }`}
                  >
                    {isDone ? <Check size={18} /> : <Icon size={18} />}
                  </div>
                  <span className={`text-xs ${isActive ? 'text-white' : 'text-muted'}`}>
                    {s.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-2 rounded transition-colors ${
                      step > s.id ? 'bg-accent/40' : 'bg-border-default'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="animate-fade-in">
          {step === 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-white mb-1">Опишите товар</h2>
              <p className="text-muted text-sm mb-6">AI создаст сценарий на основе этого описания</p>

              <div className="space-y-4" onFocus={loadProjects}>
                <Input
                  label="Название товара/услуги"
                  placeholder="Smart Watch, Nike Air Max..."
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                />
                <Textarea
                  label="Описание"
                  placeholder="Опишите ваш товар — преимущества, особенности, целевую аудиторию..."
                  value={productDescription}
                  onChange={(e) => setProductDescription(e.target.value)}
                  hint="Чем подробнее описание, тем лучше сценарий"
                />
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label="Цена (optional)"
                    placeholder="29 999 сум"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-white/90">CTA</label>
                    <select
                      value={cta}
                      onChange={(e) => setCta(e.target.value)}
                      className="w-full h-10 px-3.5 rounded-lg bg-bg-elevated border border-border-default text-white focus:outline-none focus:border-accent/50 transition-colors"
                    >
                      {CTA_OPTIONS.map((opt) => (
                        <option key={opt} value={opt} className="bg-bg-card">
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <Input
                  label="Website URL (optional)"
                  placeholder="https://example.com"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                />
                {projectsLoaded && projects.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-white/90">Проект (optional)</label>
                    <select
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="w-full h-10 px-3.5 rounded-lg bg-bg-elevated border border-border-default text-white focus:outline-none focus:border-accent/50 transition-colors"
                    >
                      <option value="" className="bg-bg-card">Без проекта</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id} className="bg-bg-card">
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </Card>
          )}

          {step === 1 && (
            <Card>
              <h2 className="text-lg font-semibold text-white mb-1">Загрузите медиа</h2>
              <p className="text-muted text-sm mb-6">Фотографии товара для рекламного ролика</p>

              {/* Drag & Drop */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  handleFiles(e.dataTransfer.files);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                  dragOver ? 'border-accent bg-accent/5' : 'border-border-default hover:border-accent/40'
                }`}
              >
                <Upload size={32} className="text-muted mx-auto mb-3" />
                <p className="text-white font-medium mb-1">Перетащите фото сюда</p>
                <p className="text-muted text-sm">JPG, PNG, WEBP до 10MB</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => e.target.files && handleFiles(e.target.files)}
                />
              </div>

              {uploading && (
                <div className="mt-4 flex items-center gap-2 text-sm text-accent">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  Загрузка...
                </div>
              )}

              {/* Thumbnails */}
              {images.length > 0 && (
                <div className="mt-6 grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {images.map((img, i) => (
                    <div key={i} className="relative group aspect-square rounded-lg overflow-hidden bg-bg-elevated">
                      <img src={img.url} alt={img.name} className="w-full h-full object-cover" />
                      <button
                        onClick={() => removeImage(i)}
                        className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/70 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Website URL fallback */}
              <div className="mt-6 pt-6 border-t border-border-default">
                <div className="flex items-center gap-2 text-muted text-sm mb-3">
                  <LinkIcon size={16} />
                  Или добавьте ссылку на сайт
                </div>
                <Input
                  placeholder="https://your-store.com/product"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                />
                <p className="text-xs text-muted mt-2">
                  Если scraping невозможен, используйте описание товара
                </p>
              </div>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <h2 className="text-lg font-semibold text-white mb-1">Выберите голос</h2>
              <p className="text-muted text-sm mb-6">AI озвучка или ваш аудиофайл</p>

              {/* AI Voice */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-white/90 mb-3">AI Voice</label>
                  <div className="grid grid-cols-2 gap-3">
                    {VOICE_TYPES.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => setVoiceType(v.id)}
                        className={`p-4 rounded-lg border text-left transition-colors ${
                          voiceType === v.id
                            ? 'border-accent bg-accent/10'
                            : 'border-border-default hover:border-accent/30'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Mic size={18} className={voiceType === v.id ? 'text-accent' : 'text-muted'} />
                          <span className="text-white font-medium">{v.name}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/90 mb-3">Язык</label>
                  <div className="grid grid-cols-3 gap-3">
                    {LANGUAGES.map((l) => (
                      <button
                        key={l.id}
                        onClick={() => setLanguage(l.id)}
                        className={`p-4 rounded-lg border text-center transition-colors ${
                          language === l.id
                            ? 'border-accent bg-accent/10'
                            : 'border-border-default hover:border-accent/30'
                        }`}
                      >
                        <span className="text-2xl block mb-1">{l.flag}</span>
                        <span className="text-sm text-white">{l.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Custom voice upload */}
                <div className="pt-4 border-t border-border-default">
                  <label className="block text-sm font-medium text-white/90 mb-2">
                    Загрузить свою озвучку (optional)
                  </label>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'audio/*';
                        input.onchange = (e) => {
                          const file = (e.target as HTMLInputElement).files?.[0];
                          if (file) setCustomVoiceFile(file);
                        };
                        input.click();
                      }}
                    >
                      <Upload size={16} />
                      {customVoiceFile ? customVoiceFile.name : 'Выбрать аудио'}
                    </Button>
                    {customVoiceFile && (
                      <button
                        onClick={() => setCustomVoiceFile(null)}
                        className="text-muted hover:text-white"
                      >
                        <X size={18} />
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted mt-2">
                    В Demo Mode используется AI voice. Custom voice будет доступен в Real AI Mode.
                  </p>
                </div>
              </div>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <h2 className="text-lg font-semibold text-white mb-1">Стиль видео</h2>
              <p className="text-muted text-sm mb-6">Выберите визуальный стиль ролика</p>

              <div className="grid grid-cols-2 gap-4">
                {VIDEO_STYLES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setStyle(s.id)}
                    className={`p-5 rounded-xl border text-left transition-all ${
                      style === s.id
                        ? 'border-accent bg-accent/10 accent-glow'
                        : 'border-border-default hover:border-accent/30'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Film size={20} className={style === s.id ? 'text-accent' : 'text-muted'} />
                      <span className="text-white font-semibold">{s.name}</span>
                    </div>
                    <p className="text-sm text-muted">{s.desc}</p>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {step === 4 && (
            <Card>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-white mb-1">AI Сценарий & Подготовка</h2>
                  <p className="text-muted text-sm">Мы сгенерировали рекламный текст для видео</p>
                </div>
                {!scriptData && !generatingScript && (
                   <Button variant="outline" size="sm" onClick={handleGenerateScript}>
                     Сгенерировать сценарий
                   </Button>
                )}
              </div>

              {generatingScript ? (
                <div className="flex flex-col items-center justify-center py-8">
                   <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent mb-4" />
                   <p className="text-white font-medium">AI пишет продающий сценарий...</p>
                </div>
              ) : scriptData ? (
                <div className="space-y-4 mb-6">
                  <div className="p-4 rounded-lg bg-accent/5 border border-accent/20">
                    <p className="text-sm font-medium text-accent mb-2">AI created your advertising script:</p>
                    <p className="text-sm text-white/90 italic">"{scriptData.fullScript}"</p>
                  </div>
                </div>
              ) : null}

              <div className="space-y-3 pt-4 border-t border-border-default/50">
                <SummaryRow label="Товар" value={productName} />
                {price && <SummaryRow label="Цена" value={price} />}
                <SummaryRow label="CTA" value={cta} />
                <SummaryRow label="Язык" value={LANGUAGES.find((l) => l.id === language)?.name || language} />
                <SummaryRow label="Голос" value={VOICE_TYPES.find((v) => v.id === voiceType)?.name || voiceType} />
                <SummaryRow label="Стиль" value={VIDEO_STYLES.find((s) => s.id === style)?.name || style} />
                <SummaryRow label="Фото" value={`${images.length} загружено`} />
              </div>

              <div className="mt-6 p-4 rounded-lg bg-bg-elevated border border-border-default">
                <p className="text-sm text-muted">
                  Нажимая «Generate Video», вы запускаете AI pipeline. Видео будет создано
                  в формате 1080×1920 (9:16) для TikTok, Reels и Shorts.
                </p>
              </div>
            </Card>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <Button
            variant="ghost"
            size="lg"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || generating}
          >
            <ArrowLeft size={18} />
            Назад
          </Button>

          {step < 4 ? (
            <Button
              size="lg"
              onClick={async () => {
                const nextStep = Math.min(4, step + 1);
                setStep(nextStep);
                // Auto-generate script when entering the final review step
                if (nextStep === 4) {
                  setTimeout(() => handleGenerateScript(), 100);
                }
              }}
              disabled={!canProceed()}
            >
              Далее
              <ArrowRight size={18} />
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={handleGenerate}
              loading={generating}
              disabled={!canProceed() || generating}
              className="animate-pulse-glow"
            >
              <Rocket size={18} />
              Generate Video
            </Button>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-border-default/50">
      <span className="text-sm text-muted shrink-0">{label}</span>
      <span className="text-sm text-white text-right max-w-[60%]">{value}</span>
    </div>
  );
}
