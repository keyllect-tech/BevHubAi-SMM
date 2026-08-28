export interface ComposerScene {
  imageUrl: string;
  text: string;
  subtitle: string;
  duration: number;
}

export interface ComposerConfig {
  scenes: ComposerScene[];
  style: string;
  language: string;
  primaryColor: string;
  secondaryColor: string;
  brandName: string;
  cta: string;
  fps: number;
  width: number;
  height: number;
  onProgress?: (progress: number) => void;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

type DrawStyle = 'product' | 'dynamic' | 'premium' | 'ugc';

function drawBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  style: string
) {
  if (style === 'premium') {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#0B0D0C');
    grad.addColorStop(1, '#1A1F1D');
    ctx.fillStyle = grad;
  } else if (style === 'dynamic') {
    ctx.fillStyle = '#0B0D0C';
  } else if (style === 'ugc') {
    ctx.fillStyle = '#0B0D0C';
  } else {
    ctx.fillStyle = '#0B0D0C';
  }
  ctx.fillRect(0, 0, w, h);
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom: number,
  panX: number,
  panY: number
) {
  const imgRatio = img.width / img.height;
  const boxRatio = w / h;
  let drawW: number, drawH: number;
  if (imgRatio > boxRatio) {
    drawH = h * zoom;
    drawW = drawH * imgRatio;
  } else {
    drawW = w * zoom;
    drawH = drawW / imgRatio;
  }
  const dx = x + (w - drawW) / 2 + panX;
  const dy = y + (h - drawH) / 2 + panY;
  ctx.drawImage(img, dx, dy, drawW, drawH);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  text: string,
  w: number,
  h: number,
  style: string,
  primaryColor: string,
  progress: number
) {
  if (!text) return;
  const s = style as DrawStyle;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const fontSize = s === 'dynamic' ? 52 : s === 'premium' ? 44 : 48;
  ctx.font = `700 ${fontSize}px Inter, sans-serif`;

  const maxWidth = w * 0.82;
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize * 1.25;

  let yPos: number;
  if (s === 'ugc') {
    yPos = h * 0.18;
  } else if (s === 'dynamic') {
    yPos = h * 0.28;
  } else {
    yPos = h * 0.22;
  }

  const alpha = Math.min(1, progress * 3);
  ctx.globalAlpha = alpha;

  lines.forEach((line) => {
    const textY = yPos + lineHeight / 2;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(line, w / 2 + 2, textY + 2);

    // Text
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(line, w / 2, textY);

    yPos += lineHeight;
  });

  ctx.globalAlpha = 1;
}

function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  w: number,
  h: number,
  progress: number
) {
  if (!text) return;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const fontSize = 40;
  ctx.font = `600 ${fontSize}px Inter, sans-serif`;

  const maxWidth = w * 0.86;
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize * 1.2;
  let yPos = h * 0.82 - (lines.length * lineHeight) / 2;

  const alpha = Math.min(1, progress * 4);
  ctx.globalAlpha = alpha;

  lines.forEach((line) => {
    const textY = yPos + lineHeight / 2;

    // Background bar
    const textWidth = ctx.measureText(line).width;
    const padX = 16;
    const padY = 8;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    const rx = w / 2 - textWidth / 2 - padX;
    const ry = textY - lineHeight / 2 - padY;
    const rw = textWidth + padX * 2;
    const rh = lineHeight + padY * 2;
    const r = 8;
    ctx.moveTo(rx + r, ry);
    ctx.lineTo(rx + rw - r, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
    ctx.lineTo(rx + rw, ry + rh - r);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
    ctx.lineTo(rx + r, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
    ctx.lineTo(rx, ry + r);
    ctx.quadraticCurveTo(rx, ry, rx + r, ry);
    ctx.fill();

    ctx.fillStyle = '#A3E635';
    ctx.fillText(line, w / 2, textY);

    yPos += lineHeight;
  });

  ctx.globalAlpha = 1;
}

function drawBrandBar(
  ctx: CanvasRenderingContext2D,
  brandName: string,
  cta: string,
  w: number,
  h: number,
  style: string,
  primaryColor: string
) {
  // Top brand bar
  ctx.font = `600 22px Inter, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = primaryColor;
  ctx.fillText(brandName, 32, 36);

  // Bottom CTA bar
  const barH = 64;
  const y = h - barH;
  ctx.fillStyle = primaryColor;
  ctx.fillRect(0, y, w, barH);

  ctx.font = `700 26px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0B0D0C';
  ctx.fillText(cta, w / 2, y + barH / 2);
}

function drawProgressBar(
  ctx: CanvasRenderingContext2D,
  progress: number,
  w: number,
  h: number,
  color: string
) {
  const barW = w * progress;
  const barH = 4;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(0, h - 72 - barH, w, barH);
  ctx.fillStyle = color;
  ctx.fillRect(0, h - 72 - barH, barW, barH);
}

function drawTransition(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  type: 'fade' | 'slide',
  progress: number,
  direction: 'in' | 'out'
) {
  const alpha = direction === 'in' ? 1 - progress : progress;
  if (type === 'fade') {
    ctx.fillStyle = `rgba(11,13,12,${alpha})`;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = `rgba(11,13,12,${alpha * 0.7})`;
    ctx.fillRect(0, 0, w, h);
  }
}

export async function composeVideo(
  config: ComposerConfig
): Promise<Blob> {
  const { scenes, style, fps, width, height, onProgress, primaryColor, brandName, cta } = config;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Load all images
  const images = await Promise.all(
    scenes.map((s) => loadImage(s.imageUrl).catch(() => null))
  );

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9',
    videoBitsPerSecond: 4_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      resolve(blob);
    };
    recorder.onerror = (e) => reject(e);

    recorder.start();

    const totalFrames = scenes.reduce((sum, s) => sum + Math.ceil(s.duration * fps), 0);
    let currentFrame = 0;
    let sceneIndex = 0;
    let frameInScene = 0;

    const renderFrame = () => {
      if (sceneIndex >= scenes.length) {
        recorder.stop();
        return;
      }

      const scene = scenes[sceneIndex];
      const sceneFrames = Math.ceil(scene.duration * fps);
      const sceneProgress = frameInScene / sceneFrames;
      const img = images[sceneIndex];

      drawBackground(ctx, width, height, style);

      if (img) {
        // Ken Burns effect — zoom + pan
        const zoomStart = style === 'dynamic' ? 1.0 : 1.05;
        const zoomEnd = style === 'dynamic' ? 1.15 : 1.12;
        const zoom = zoomStart + (zoomEnd - zoomStart) * easeInOutCubic(sceneProgress);
        const panX = (sceneProgress - 0.5) * 40;
        const panY = (sceneProgress - 0.5) * 30;

        // Image area: top portion for dynamic, full for others
        const imgAreaH = style === 'dynamic' || style === 'ugc' ? height * 0.55 : height * 0.6;
        drawImageCover(ctx, img, 0, 0, width, imgAreaH, zoom, panX, panY);

        // Dark gradient overlay for text readability
        if (style === 'premium' || style === 'product') {
          const grad = ctx.createLinearGradient(0, imgAreaH - 100, 0, imgAreaH + 50);
          grad.addColorStop(0, 'rgba(11,13,12,0)');
          grad.addColorStop(1, 'rgba(11,13,12,0.9)');
          ctx.fillStyle = grad;
          ctx.fillRect(0, imgAreaH - 100, width, 150);
        }
      } else {
        // Fallback: gradient background with text
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, '#1A1F1D');
        grad.addColorStop(1, '#0B0D0C');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }

      // Text overlay
      drawTextOverlay(ctx, scene.text, width, height, style, primaryColor, sceneProgress);

      // Subtitle
      drawSubtitle(ctx, scene.subtitle, width, height, sceneProgress);

      // Brand bar
      drawBrandBar(ctx, brandName, cta, width, height, style, primaryColor);

      // Progress bar (video timeline)
      drawProgressBar(ctx, currentFrame / totalFrames, width, height, primaryColor);

      // Transition fade at scene boundaries
      if (frameInScene < fps * 0.3 && sceneIndex > 0) {
        drawTransition(ctx, width, height, 'fade', frameInScene / (fps * 0.3), 'in');
      }
      if (frameInScene > sceneFrames - fps * 0.3 && sceneIndex < scenes.length - 1) {
        const fadeProg = (frameInScene - (sceneFrames - fps * 0.3)) / (fps * 0.3);
        drawTransition(ctx, width, height, 'fade', fadeProg, 'out');
      }

      currentFrame++;
      frameInScene++;

      if (onProgress) {
        onProgress(Math.round((currentFrame / totalFrames) * 100));
      }

      if (frameInScene >= sceneFrames) {
        sceneIndex++;
        frameInScene = 0;
      }

      // Schedule next frame
      setTimeout(renderFrame, 1000 / fps);
    };

    renderFrame();
  });
}
