import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Image as ImageIcon, Mic, Film, Rocket, ArrowRight, ArrowLeft, Upload, X, Check, RefreshCw } from 'lucide-react';
import { api, apiUrl } from '@/lib/api';
import { newRequestId } from '@/lib/id';
import { useToast } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { VIDEO_STYLES, LANGUAGES, VOICE_TYPES, CTA_OPTIONS, type Project, type VideoScript } from '@/types';

interface UploadedImage {
  id: string;
  url: string;
  name: string;
}

type ScriptData = VideoScript & { source: 'openai' | 'fallback' };

const STEPS = [
  { id: 0, label: 'Product', icon: Package },
  { id: 1, label: 'Media', icon: ImageIcon },
  { id: 2, label: 'Voice', icon: Mic },
  { id: 3, label: 'Style', icon: Film },
  { id: 4, label: 'Generate', icon: Rocket },
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 10;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

export function CreateVideoPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const scriptRequestRef = useRef(0);
  // One id per wizard: a repeated submit (double click, retry after a network error) is deduplicated by the server.
  const clientRequestIdRef = useRef(newRequestId());

  const [step, setStep] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const [productName, setProductName] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [price, setPrice] = useState('');
  const [cta, setCta] = useState<string>(CTA_OPTIONS[0]);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [projectId, setProjectId] = useState<string>('');

  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [voiceType, setVoiceType] = useState('female');
  const [language, setLanguage] = useState('ru');
  const [style, setStyle] = useState('dynamic');

  const [generating, setGenerating] = useState(false);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [scriptData, setScriptData] = useState<ScriptData | null>(null);
  const [scriptError, setScriptError] = useState('');

  // Any input change makes a previously generated script stale.
  useEffect(() => {
    scriptRequestRef.current++;
    setScriptData(null);
    setScriptError('');
    setGeneratingScript(false);
  }, [productName, productDescription, cta, language, style]);

  const handleGenerateScript = async () => {
    const requestId = ++scriptRequestRef.current;
    setGeneratingScript(true);
    setScriptError('');
    try {
      const data = await api.generateScript({ productName, description: productDescription, cta, language, style });
      if (requestId === scriptRequestRef.current) setScriptData({ ...data.script, source: data.source });
    } catch (err) {
      if (requestId === scriptRequestRef.current) {
        setScriptError(err instanceof Error ? err.message : 'Не удалось сгенерировать сценарий');
      }
    } finally {
      if (requestId === scriptRequestRef.current) setGeneratingScript(false);
    }
  };

  const loadProjects = async () => {
    if (projectsLoaded) return;
    setProjectsLoaded(true);
    try {
      setProjects((await api.listProjects()).projects);
    } catch {
      setProjectsLoaded(false);
    }
  };

  const handleFiles = async (files: FileList) => {
    const all = Array.from(files);
    const accepted = all.filter((f) => IMAGE_MIME.includes(f.type) && f.size <= MAX_IMAGE_BYTES);
    if (accepted.length < all.length) toast('Только JPG, PNG, WEBP до 10MB', 'error');

    // The server accepts at most 10 images per video — stop before uploading the extras.
    const room = MAX_IMAGES - images.length;
    if (accepted.length > room) toast(`Можно добавить максимум ${MAX_IMAGES} фото`, 'error');
    const valid = accepted.slice(0, Math.max(0, room));
    if (valid.length === 0) return;

    setUploading(true);
    for (const file of valid) {
      try {
        const { file: uploaded } = await api.uploadImage(file);
        setImages((prev) => [...prev, { id: uploaded.id, url: uploaded.url, name: uploaded.name }]);
      } catch (err) {
        toast(`${file.name}: ${err instanceof Error ? err.message : 'ошибка загрузки'}`, 'error');
      }
    }
    setUploading(false);
  };

  const removeImage = (id: string) => setImages((prev) => prev.filter((img) => img.id !== id));

  const canProceed = () => {
    switch (step) {
      case 0:
        return productName.trim().length > 0 && productDescription.trim().length > 0 && cta.trim().length > 0;
      case 1:
        return images.length > 0 && !uploading;
      case 2:
        return Boolean(voiceType && language);
      case 3:
        return Boolean(style);
      default:
        return images.length > 0 && productName.trim().length > 0 && productDescription.trim().length > 0;
    }
  };

  const handleGenerate = async () => {
    // Ref guard: two clicks can land before React re-renders the disabled button.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setGenerating(true);
    try {
      const { video } = await api.createVideo({
        clientRequestId: clientRequestIdRef.current,
        projectId: projectId || null,
        productName: productName.trim(),
        description: productDescription.trim(),
        price,
        cta: cta.trim(),
        websiteUrl: websiteUrl.trim(),
        language,
        voiceType,
        style,
        fileIds: images.map((img) => img.id),
        script: scriptData ? { hook: scriptData.hook, benefit1: scriptData.benefit1, benefit2: scriptData.benefit2, cta: scriptData.cta } : null,
        scriptSource: scriptData?.source ?? null,
      });
      navigate(`/videos/${video.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Ошибка при запуске генерации', 'error');
      submittingRef.current = false;
      setGenerating(false);
    }
  };

  const goNext = () => {
    const nextStep = Math.min(4, step + 1);
    setStep(nextStep);
    if (nextStep === 4 && !scriptData && !generatingScript) handleGenerateScript();
  };

  return (
    <AppLayout title="Create Video">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const isActive = step === s.id;
            const isDone = step > s.id;
            return (
              <div key={s.id} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className={`h-9 w-9 sm:h-10 sm:w-10 rounded-full flex items-center justify-center transition-colors ${
                      isActive ? 'bg-accent text-bg' : isDone ? 'bg-accent/20 text-accent' : 'bg-bg-elevated text-muted'
                    }`}
                  >
                    {isDone ? <Check size={18} /> : <Icon size={18} />}
                  </div>
                  <span className={`hidden sm:block text-xs ${isActive ? 'text-white' : 'text-muted'}`}>{s.label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-1 sm:mx-2 rounded transition-colors ${step > s.id ? 'bg-accent/40' : 'bg-border-default'}`} />
                )}
              </div>
            );
          })}
        </div>

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
                  maxLength={100}
                  onChange={(e) => setProductName(e.target.value)}
                />
                <Textarea
                  label="Описание"
                  placeholder="Опишите ваш товар — преимущества, особенности, целевую аудиторию..."
                  value={productDescription}
                  maxLength={600}
                  onChange={(e) => setProductDescription(e.target.value)}
                  hint="Чем подробнее описание, тем лучше сценарий"
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input label="Цена (optional)" placeholder="29 999 сум" maxLength={50} value={price} onChange={(e) => setPrice(e.target.value)} />
                  <div>
                    <Input
                      label="CTA (призыв к действию)"
                      placeholder="Закажите сейчас"
                      list="cta-options"
                      maxLength={60}
                      value={cta}
                      onChange={(e) => setCta(e.target.value)}
                    />
                    <datalist id="cta-options">
                      {CTA_OPTIONS.map((opt) => (
                        <option key={opt} value={opt} />
                      ))}
                    </datalist>
                  </div>
                </div>
                <Input
                  label="Website URL (optional)"
                  placeholder="https://example.com"
                  maxLength={300}
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                />
                {projects.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-white/90">Проект (optional)</label>
                    <select
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="w-full h-10 px-3.5 rounded-lg bg-bg-elevated border border-border-default text-white focus:outline-none focus:border-accent/50 transition-colors"
                    >
                      <option value="" className="bg-bg-card">
                        Без проекта
                      </option>
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
              <h2 className="text-lg font-semibold text-white mb-1">Загрузите фото товара</h2>
              <p className="text-muted text-sm mb-6">В видео используется первое фото</p>

              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInputRef.current?.click()}
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
                <p className="text-white font-medium mb-1">Перетащите фото сюда или нажмите</p>
                <p className="text-muted text-sm">JPG, PNG, WEBP до 10MB</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) handleFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>

              {uploading && (
                <div className="mt-4 flex items-center gap-2 text-sm text-accent">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  Загрузка...
                </div>
              )}

              {images.length > 0 && (
                <div className="mt-6 grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {images.map((img) => (
                    <div key={img.id} className="relative group aspect-square rounded-lg overflow-hidden bg-bg-elevated">
                      <img src={apiUrl(img.url)} alt={img.name} className="w-full h-full object-cover" />
                      <button
                        onClick={() => removeImage(img.id)}
                        aria-label={`Удалить ${img.name}`}
                        className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/70 flex items-center justify-center text-white sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {step === 2 && (
            <Card>
              <h2 className="text-lg font-semibold text-white mb-1">Голос и язык</h2>
              <p className="text-muted text-sm mb-6">Язык сценария, субтитров и озвучки</p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-white/90 mb-3">Язык</label>
                  <div className="grid grid-cols-3 gap-3">
                    {LANGUAGES.map((l) => (
                      <button
                        key={l.id}
                        onClick={() => {
                          setLanguage(l.id);
                          // Only English has a male voice.
                          if (l.id !== 'en') setVoiceType('female');
                        }}
                        className={`p-3 sm:p-4 rounded-lg border text-center transition-colors ${
                          language === l.id ? 'border-accent bg-accent/10' : 'border-border-default hover:border-accent/30'
                        }`}
                      >
                        <span className="text-2xl block mb-1">{l.flag}</span>
                        <span className="text-sm text-white">{l.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/90 mb-3">Голос</label>
                  <div className="grid grid-cols-2 gap-3">
                    {VOICE_TYPES.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => setVoiceType(v.id)}
                        disabled={v.id === 'male' && language !== 'en'}
                        title={v.id === 'male' && language !== 'en' ? 'Мужской голос доступен только для английского' : undefined}
                        className={`p-4 rounded-lg border text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          voiceType === v.id ? 'border-accent bg-accent/10' : 'border-border-default hover:border-accent/30'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Mic size={18} className={voiceType === v.id ? 'text-accent' : 'text-muted'} />
                          <span className="text-white font-medium">{v.name}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted mt-2">
                    Озвучка генерируется автоматически. Мужской и женский голос доступны для английского; для русского и
                    узбекского используется женский голос.
                  </p>
                </div>
              </div>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <h2 className="text-lg font-semibold text-white mb-1">Стиль видео</h2>
              <p className="text-muted text-sm mb-6">Выберите визуальный стиль ролика</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {VIDEO_STYLES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setStyle(s.id)}
                    className={`p-5 rounded-xl border text-left transition-all ${
                      style === s.id ? 'border-accent bg-accent/10 accent-glow' : 'border-border-default hover:border-accent/30'
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
              <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-white mb-1">AI сценарий</h2>
                  <p className="text-muted text-sm">Текст для субтитров и озвучки</p>
                </div>
                {!generatingScript && (
                  <Button variant="outline" size="sm" onClick={handleGenerateScript} disabled={generating}>
                    <RefreshCw size={14} />
                    {scriptData ? 'Другой вариант' : 'Сгенерировать'}
                  </Button>
                )}
              </div>

              {generatingScript ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent mb-4" />
                  <p className="text-white font-medium">AI пишет продающий сценарий...</p>
                </div>
              ) : scriptData ? (
                <div className="space-y-2 mb-6 p-4 rounded-lg bg-accent/5 border border-accent/20">
                  <p className="text-xs text-muted mb-2">
                    {scriptData.source === 'openai' ? 'Сгенерировано OpenAI' : 'Сгенерировано BevHub Engine'}
                  </p>
                  <ScriptLine label="0–3s HOOK" value={scriptData.hook} />
                  <ScriptLine label="3–8s" value={scriptData.benefit1} />
                  <ScriptLine label="8–12s" value={scriptData.benefit2} />
                  <ScriptLine label="12–15s CTA" value={scriptData.cta} />
                </div>
              ) : scriptError ? (
                <div role="alert" className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300">
                  {scriptError}
                  <p className="text-muted mt-1">Сценарий будет создан сервером при генерации.</p>
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
                <p className="text-sm text-muted">Видео будет создано в формате MP4 1080×1920 (9:16), 15 секунд — для TikTok, Reels и Shorts.</p>
              </div>
            </Card>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 mt-6">
          <Button variant="ghost" size="lg" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || generating}>
            <ArrowLeft size={18} />
            Назад
          </Button>

          {step < 4 ? (
            <Button size="lg" onClick={goNext} disabled={!canProceed()}>
              Далее
              <ArrowRight size={18} />
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={handleGenerate}
              loading={generating}
              disabled={!canProceed() || generating || generatingScript}
              className="animate-pulse-glow"
            >
              {!generating && <Rocket size={18} />}
              Generate Video
            </Button>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function ScriptLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-3">
      <span className="text-xs font-medium text-accent sm:w-24 shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-white/90 break-words">{value}</span>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-border-default/50">
      <span className="text-sm text-muted shrink-0">{label}</span>
      <span className="text-sm text-white text-right max-w-[60%] break-words">{value}</span>
    </div>
  );
}
