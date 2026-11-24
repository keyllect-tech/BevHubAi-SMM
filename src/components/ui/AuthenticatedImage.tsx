import { useEffect, useState } from 'react';
import { createAuthenticatedImagePreview, type AuthenticatedImagePreview } from '@/lib/authenticated-image-preview.mjs';

type PreviewState =
  | { src: string; status: 'loading' }
  | { src: string; status: 'error'; message: string }
  | { src: string; status: 'ready'; preview: AuthenticatedImagePreview };

interface AuthenticatedImageProps {
  src: string;
  alt: string;
  className: string;
}

const LOAD_TIMEOUT_MS = 15_000;

export function AuthenticatedImage({ src, alt, className }: AuthenticatedImageProps) {
  const [state, setState] = useState<PreviewState>({ src, status: 'loading' });
  const currentState = state.src === src ? state : { src, status: 'loading' as const };

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    let preview: AuthenticatedImagePreview | null = null;
    setState({ src, status: 'loading' });

    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (active) {
        setState({ src, status: 'error', message: `Сервер не ответил за ${LOAD_TIMEOUT_MS / 1000} секунд.` });
      }
    }, LOAD_TIMEOUT_MS);

    createAuthenticatedImagePreview(src, { signal: controller.signal })
      .then((loadedPreview) => {
        if (!active || timedOut) {
          loadedPreview.dispose();
          return;
        }
        preview = loadedPreview;
        setState({ src, status: 'ready', preview: loadedPreview });
      })
      .catch((error: unknown) => {
        if (!active || timedOut) return;
        const message = error instanceof Error ? error.message : 'Неизвестная ошибка загрузки изображения.';
        setState({ src, status: 'error', message });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      preview?.dispose();
    };
  }, [src]);

  if (currentState.status === 'loading') {
    return (
      <div
        className={`${className} flex items-center justify-center bg-bg-elevated`}
        role="status"
        aria-label={`Загрузка изображения: ${alt}`}
      >
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (currentState.status === 'error') {
    return (
      <div className={`${className} flex items-center justify-center bg-bg-elevated p-2 text-center`} role="alert">
        <div className="min-w-0">
          <span className="block break-words text-xs font-medium text-red-100">{alt}</span>
          <span className="block break-words text-[10px] leading-tight text-red-200/90">{currentState.message}</span>
        </div>
      </div>
    );
  }

  return (
    <span className="relative block h-full w-full">
      <img
        src={currentState.preview.objectUrl}
        alt={alt}
        className={className}
        onError={() => {
          currentState.preview.dispose();
          setState((previous) => previous.src === src && previous.status === 'ready'
            ? { src, status: 'error', message: 'Файл получен, но браузер не смог декодировать изображение.' }
            : previous);
        }}
      />
      {currentState.preview.warning && (
        <span
          role="status"
          title={currentState.preview.warning}
          className="absolute bottom-1 left-1 rounded bg-amber-950/90 px-1.5 py-0.5 text-[9px] text-amber-100"
        >
          MIME
        </span>
      )}
    </span>
  );
}
