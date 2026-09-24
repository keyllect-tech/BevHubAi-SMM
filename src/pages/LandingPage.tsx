import { Link } from 'react-router-dom';
import {
  Zap,
  ArrowRight,
  Play,
  Sparkles,
  FileText,
  Mic,
  Film,
  Download,
  Globe,
  Check,
  ChevronDown,
  Wand2,
  Layers,
  Clock,
  TrendingDown,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { PLANS } from '@/types';

export function LandingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const faqs = [
    {
      q: 'Что такое BevHubAI?',
      a: 'BevHubAI — это AI-платформа для автоматического создания коротких рекламных видео. Вы описываете товар, услугу, заведение, недвижимость или вакансию, загружаете фото — AI пишет сценарий и создаёт готовый ролик для TikTok, Reels и Shorts.',
    },
    {
      q: 'Нужны ли технические знания?',
      a: 'Нет. Интерфейс построен как простой мастер из 5 шагов. Никакого монтажа, никакого сложного софта — только описание товара и фотографии.',
    },
    {
      q: 'Какие языки поддерживаются?',
      a: 'Русский, узбекский и английский. AI генерирует сценарий и субтитры на выбранном языке.',
    },
    {
      q: 'Как озвучивается видео?',
      a: 'Озвучка создаётся автоматически по сценарию. Для английского можно выбрать мужской или женский голос, для русского и узбекского используется женский голос.',
    },
    {
      q: 'В каком формате получается видео?',
      a: 'Вертикальный MP4 1080×1920 (9:16), оптимизированный для TikTok, Instagram Reels и YouTube Shorts. Длительность 15 секунд.',
    },
    {
      q: 'Нужны ли API-ключи или подписки?',
      a: 'Нет. Сценарий, субтитры, озвучка и монтаж создаются на сервере BevHubAI и работают без внешних ключей. При желании можно подключить OpenAI — тогда сценарии будет писать он.',
    },
  ];

  return (
    <div className="min-h-screen bg-bg">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 glass border-b border-border-default">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-accent flex items-center justify-center">
              <Zap size={18} className="text-bg" fill="currentColor" />
            </div>
            <span className="text-lg font-bold text-white">BevHubAI</span>
          </div>
          <div className="hidden md:flex items-center gap-6">
            <a href="#how" className="text-sm text-muted hover:text-white transition-colors">Как работает</a>
            <a href="#features" className="text-sm text-muted hover:text-white transition-colors">Возможности</a>
            <a href="#pricing" className="text-sm text-muted hover:text-white transition-colors">Цены</a>
            <a href="#faq" className="text-sm text-muted hover:text-white transition-colors">FAQ</a>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login">
              <Button variant="ghost" size="sm">Войти</Button>
            </Link>
            <Link to="/register">
              <Button size="sm">Начать</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-32 pb-20 px-6 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-20 left-1/4 h-96 w-96 rounded-full bg-accent/10 blur-3xl" />
          <div className="absolute bottom-0 right-1/4 h-64 w-64 rounded-full bg-accent/5 blur-3xl" />
        </div>
        <div className="max-w-4xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass mb-6 animate-fade-in">
            <Sparkles size={14} className="text-accent" />
            <span className="text-xs text-white/80">AI-генерация рекламных видео</span>
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white leading-tight mb-6 animate-slide-up">
            Создавайте рекламные видео<br />
            <span className="gradient-text">за 5 минут</span>
          </h1>
          <p className="text-lg text-muted max-w-2xl mx-auto mb-8 animate-slide-up" style={{ animationDelay: '0.1s' }}>
            BevHubAI превращает описание товара, услуги или бизнеса и фотографии в готовый
            рекламный ролик для Reels, TikTok и Shorts.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-12 animate-slide-up" style={{ animationDelay: '0.2s' }}>
            <Link to="/register">
              <Button size="lg" className="animate-pulse-glow">
                Создать первое видео
                <ArrowRight size={18} />
              </Button>
            </Link>
            <a href="#how">
              <Button variant="outline" size="lg">
                <Play size={18} />
                Посмотреть демо
              </Button>
            </a>
          </div>

          {/* Visual demo: INPUT → AI → VIDEO */}
          <div className="grid grid-cols-3 gap-3 sm:gap-6 max-w-2xl mx-auto animate-fade-in" style={{ animationDelay: '0.3s' }}>
            <div className="glass rounded-xl p-4 sm:p-6 text-center">
              <div className="h-12 w-12 mx-auto rounded-lg bg-bg-elevated flex items-center justify-center mb-3">
                <FileText size={24} className="text-accent" />
              </div>
              <p className="text-xs sm:text-sm text-white font-medium">ДАННЫЕ</p>
              <p className="text-xs text-muted mt-1 hidden sm:block">Описание + фото</p>
            </div>
            <div className="glass rounded-xl p-4 sm:p-6 text-center relative">
              <div className="h-12 w-12 mx-auto rounded-lg bg-accent/10 flex items-center justify-center mb-3">
                <Wand2 size={24} className="text-accent animate-pulse" />
              </div>
              <p className="text-xs sm:text-sm text-accent font-medium">AI</p>
              <p className="text-xs text-muted mt-1 hidden sm:block">Сценарий + монтаж</p>
            </div>
            <div className="glass rounded-xl p-4 sm:p-6 text-center">
              <div className="h-12 w-12 mx-auto rounded-lg bg-bg-elevated flex items-center justify-center mb-3">
                <Film size={24} className="text-accent" />
              </div>
              <p className="text-xs sm:text-sm text-white font-medium">ВИДЕО</p>
              <p className="text-xs text-muted mt-1 hidden sm:block">Готовый MP4</p>
            </div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="py-20 px-6 border-t border-border-default">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-4">
              Замените дорогой SMM-процесс<br />одним AI-инструментом
            </h2>
            <p className="text-muted">Создание рекламного видео больше не требует команды и недель работы</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="rounded-xl bg-bg-card border border-border-default p-6">
              <div className="flex items-center gap-2 mb-4 text-red-400">
                <TrendingDown size={20} />
                <span className="font-medium">Без BevHubAI</span>
              </div>
              <ul className="space-y-3">
                {['Копирайтер для сценария', 'Дизайнер для графики', 'Монтажёр для видео', 'Озвучка отдельно', 'Дни или недели на один ролик'].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-muted text-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-400/50" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl bg-accent/5 border border-accent/20 p-6">
              <div className="flex items-center gap-2 mb-4 text-accent">
                <Zap size={20} />
                <span className="font-medium">С BevHubAI</span>
              </div>
              <ul className="space-y-3">
                {['AI пишет сценарий', 'AI монтирует видео', 'AI добавляет субтитры', 'Озвучка в один клик', '5 минут на готовый ролик'].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-white/90 text-sm">
                    <Check size={16} className="text-accent" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="py-20 px-6 border-t border-border-default">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-2">Как это работает</h2>
            <p className="text-muted">Пять простых шагов от идеи до готового видео</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {[
              { icon: FileText, title: 'Опишите товар', desc: 'Название, описание, цена' },
              { icon: Layers, title: 'Загрузите фото', desc: 'JPG, PNG или WEBP' },
              { icon: Mic, title: 'Выберите голос', desc: 'AI-озвучка на 3 языках' },
              { icon: Film, title: 'Выберите стиль', desc: 'Dynamic, Premium, UGC' },
              { icon: Download, title: 'Получите видео', desc: 'MP4 1080×1920' },
            ].map((step, i) => {
              const Icon = step.icon;
              return (
                <div key={i} className="relative">
                  <div className="glass rounded-xl p-5 text-center">
                    <div className="h-12 w-12 mx-auto rounded-lg bg-accent/10 flex items-center justify-center mb-3">
                      <Icon size={22} className="text-accent" />
                    </div>
                    <div className="text-xs text-accent mb-1">Шаг {i + 1}</div>
                    <h3 className="text-sm font-medium text-white mb-1">{step.title}</h3>
                    <p className="text-xs text-muted">{step.desc}</p>
                  </div>
                  {i < 4 && (
                    <div className="hidden md:block absolute top-1/2 -right-2 text-accent/30">
                      <ArrowRight size={16} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 px-6 border-t border-border-default">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-2">Возможности</h2>
            <p className="text-muted">Всё для создания рекламы в одном инструменте</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Wand2, title: 'AI Script Generation', desc: 'Сценарий с hook, преимуществами и CTA — автоматически' },
              { icon: Mic, title: 'AI Voice-over', desc: 'Мужской и женский голос на трёх языках' },
              { icon: Film, title: 'Video Styles', desc: 'Product Ad, Dynamic, Premium, UGC — выбирайте подачу' },
              { icon: Globe, title: 'Multi-language', desc: 'Русский, узбекский, английский — из коробки' },
              { icon: Sparkles, title: 'Auto Subtitles', desc: 'Крупные, читаемые субтитры с динамическим появлением' },
              { icon: Clock, title: 'Fast Generation', desc: 'Готовый ролик за минуты, не за дни' },
            ].map((feat) => {
              const Icon = feat.icon;
              return (
                <div key={feat.title} className="glass rounded-xl p-5 hover:border-accent/30 transition-colors group">
                  <div className="h-10 w-10 rounded-lg bg-accent/10 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                    <Icon size={20} className="text-accent" />
                  </div>
                  <h3 className="text-white font-medium mb-1">{feat.title}</h3>
                  <p className="text-sm text-muted">{feat.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Before / After */}
      <section className="py-20 px-6 border-t border-border-default">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-2">До и после</h2>
            <p className="text-muted">Что получает пользователь на выходе</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="rounded-xl bg-bg-card border border-border-default p-6">
              <p className="text-xs text-muted mb-3">ВВОД — описание товара</p>
              <div className="rounded-lg bg-bg-elevated p-4 font-mono text-sm text-muted">
                <p>Название: Smart Watch X7</p>
                <p>Описание: Премиальные смарт-часы с AMOLED экраном, NFC и поддержкой 100+ спортивных режимов.</p>
                <p>Цена: 299 000 сум</p>
                <p>CTA: Заказать</p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="aspect-square rounded-lg bg-bg-elevated flex items-center justify-center">
                  <FileText size={20} className="text-muted" />
                </div>
                <div className="aspect-square rounded-lg bg-bg-elevated flex items-center justify-center">
                  <FileText size={20} className="text-muted" />
                </div>
              </div>
            </div>
            <div className="rounded-xl bg-accent/5 border border-accent/20 p-6">
              <p className="text-xs text-accent mb-3">РЕЗУЛЬТАТ — готовый ролик</p>
              <div className="relative aspect-[9/16] max-h-64 mx-auto rounded-lg overflow-hidden bg-gradient-to-b from-bg-elevated to-bg">
                <div className="absolute inset-0 flex flex-col items-center justify-center p-4">
                  <Film size={32} className="text-accent mb-3" />
                  <p className="text-white text-sm text-center font-semibold mb-2">Smart Watch X7</p>
                  <p className="text-accent text-xs text-center mb-1">Премиальные часы</p>
                  <p className="text-white/70 text-xs text-center">AMOLED • NFC • 100+ режимов</p>
                  <div className="mt-3 px-4 py-1.5 rounded bg-accent text-bg text-xs font-semibold">
                    Заказать
                  </div>
                </div>
              </div>
              <p className="text-xs text-center text-muted mt-3">1080×1920 • 20 сек • MP4</p>
            </div>
          </div>
        </div>
      </section>

      {/* Video examples */}
      <section className="py-20 px-6 border-t border-border-default">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-2">Примеры видео</h2>
            <p className="text-muted">Вертикальные ролики, готовые для соцсетей</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { title: 'Smart Watch', style: 'Динамичный', img: '/examples/smart-watch.jpg' },
              { title: 'Smartphone Pro', style: 'Премиум', img: '/examples/smartphone.jpg' },
              { title: 'Tech Bundle', style: 'Реклама товара', img: '/examples/tech-bundle.jpg' },
              { title: 'Latest Device', style: 'UGC', img: '/examples/device.jpg' },
            ].map((ex) => (
              <div key={ex.title} className="group cursor-pointer">
                <div className="relative aspect-[9/16] rounded-xl overflow-hidden bg-bg-elevated mb-3">
                  <img
                    src={ex.img}
                    alt={ex.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  <div className="absolute bottom-3 left-3 right-3">
                    <p className="text-white text-sm font-semibold">{ex.title}</p>
                    <p className="text-accent text-xs">{ex.style}</p>
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="h-10 w-10 rounded-full bg-accent flex items-center justify-center">
                      <Play size={20} className="text-bg" fill="currentColor" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 px-6 border-t border-border-default">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-2">Цены</h2>
            <p className="text-muted">Выберите план для вашего бизнеса</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {PLANS.map((plan, i) => (
              <div
                key={plan.id}
                className={`rounded-xl p-6 border ${i === 1 ? 'border-accent/40 accent-glow bg-accent/5' : 'border-border-default bg-bg-card'}`}
              >
                {i === 1 && (
                  <div className="inline-block px-3 py-0.5 rounded-full bg-accent text-bg text-xs font-semibold mb-3">
                    Популярный
                  </div>
                )}
                <h3 className="text-xl font-bold text-white mb-1">{plan.name}</h3>
                <p className="text-3xl font-bold text-white mb-1">
                  ${plan.price}
                  <span className="text-sm font-normal text-muted">/мес</span>
                </p>
                <p className="text-sm text-muted mb-5">{plan.monthly_limit} видео в месяц</p>
                <ul className="space-y-2 mb-6">
                  {[
                    `${plan.monthly_limit} видео в месяц`,
                    'AI-сценарии',
                    'Автоматические субтитры',
                    'Все стили видео',
                    'AI-озвучка: RU, UZ, EN',
                  ].map((feat) => (
                    <li key={feat} className="flex items-center gap-2 text-sm text-white/80">
                      <Check size={15} className="text-accent shrink-0" />
                      {feat}
                    </li>
                  ))}
                </ul>
                <Link to="/register" className="block">
                  <Button variant={i === 1 ? 'primary' : 'secondary'} className="w-full">
                    Выбрать план
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 px-6 border-t border-border-default">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-white mb-2">FAQ</h2>
            <p className="text-muted">Частые вопросы</p>
          </div>
          <div className="space-y-3">
            {faqs.map((faq, i) => (
              <div key={i} className="glass rounded-xl overflow-hidden">
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full px-5 py-4 flex items-center justify-between text-left"
                >
                  <span className="text-white font-medium text-sm">{faq.q}</span>
                  <ChevronDown
                    size={18}
                    className={`text-muted shrink-0 transition-transform ${openFaq === i ? 'rotate-180' : ''}`}
                  />
                </button>
                {openFaq === i && (
                  <div className="px-5 pb-4 text-sm text-muted animate-fade-in">
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6 border-t border-border-default">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex h-16 w-16 rounded-full bg-accent/10 items-center justify-center mb-6">
            <Zap size={32} className="text-accent" fill="currentColor" />
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Начните создавать видео сегодня
          </h2>
          <p className="text-muted mb-8 max-w-xl mx-auto">
            Зарегистрируйтесь и создайте первое рекламное видео за 5 минут. Без дизайнера, без монтажёра.
          </p>
          <Link to="/register">
            <Button size="lg" className="animate-pulse-glow">
              Создать первое видео
              <ArrowRight size={18} />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-border-default">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-accent flex items-center justify-center">
                <Zap size={16} className="text-bg" fill="currentColor" />
              </div>
              <span className="text-white font-semibold">BevHubAI</span>
            </div>
            <p className="text-sm text-muted">
              © 2026 BevHubAI. AI-генерация рекламных видео.
            </p>
            <div className="flex items-center gap-4">
              <a href="#how" className="text-sm text-muted hover:text-white transition-colors">Как работает</a>
              <a href="#pricing" className="text-sm text-muted hover:text-white transition-colors">Цены</a>
              <a href="#faq" className="text-sm text-muted hover:text-white transition-colors">FAQ</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
