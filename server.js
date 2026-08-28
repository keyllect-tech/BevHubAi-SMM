import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.setFfmpegPath(ffmpegPath.path);

// ── AI Script Generation ──────────────────────────────────────────────────────
async function generateAIScript({ productName, description, cta, language, style }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const langLabel = language === 'uz' ? 'Uzbek' : language === 'en' ? 'English' : 'Russian';

  console.log(`[AI SCRIPT] product: ${productName} | language: ${langLabel} | style: ${style}`);

  if (apiKey) {
    try {
      const payload = JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are an expert short-form video ad scriptwriter. Write a 15-second ad script in ${langLabel}. Style: ${style}.
Return ONLY valid JSON:
{"hook":"0-3s text","benefit1":"3-8s text","benefit2":"8-12s text","cta":"12-15s text","fullScript":"full text"}
Rules: Be punchy. Do NOT invent features not mentioned. Keep each field under 60 chars.`
          },
          {
            role: 'user',
            content: `Product: ${productName}. Description: ${description || 'N/A'}. CTA: ${cta || 'Order now'}.`
          }
        ]
      });

      const data = await new Promise((resolve, reject) => {
        const req = https.request(
          { hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(payload) } },
          (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => resolve(JSON.parse(body)));
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      const content = JSON.parse(data.choices?.[0]?.message?.content || 'null');
      if (!content || !content.hook) throw new Error('Invalid AI response structure');
      console.log('[AI SCRIPT] Generated:', JSON.stringify(content));
      return {
        t1: (content.hook || '').replace(/'/g, ''),
        t2: (content.benefit1 || '').replace(/'/g, ''),
        t3: (content.benefit2 || '').replace(/'/g, ''),
        t4: (content.cta || cta || 'Order now').replace(/'/g, '')
      };
    } catch (err) {
      console.error('[AI SCRIPT] OpenAI failed, using fallback:', err.message);
    }
  } else {
    console.log('[AI SCRIPT] No OPENAI_API_KEY — using fallback templates');
  }

  // ── Fallback: deterministic templates ───────────────────────────────────────
  return generateFallbackScript({ productName, description, cta, language, style });
}

function generateFallbackScript({ productName, description, cta, language, style }) {
  const name = productName || (language === 'uz' ? 'Mahsulot' : language === 'en' ? 'this product' : 'товар');
  const hooks = {
    ru: {
      product: `Знакомьтесь — ${name}`,
      dynamic: `Стоп. ${name} меняет всё`,
      premium: `${name}. Создано для лучших`,
      ugc: `Не верил, пока не попробовал ${name}`
    },
    uz: {
      product: `${name} — siz kutgan narsa`,
      dynamic: `Toʻxtang! ${name} hamma narsani oʻzgartiradi`,
      premium: `${name}. Eng yaxshilar uchun`,
      ugc: `${name}ni sinab koʻrgunimcha ishonmadim`
    },
    en: {
      product: `Meet ${name} — the upgrade you need`,
      dynamic: `Stop scrolling. ${name} changes everything`,
      premium: `${name}. Crafted for those who expect more`,
      ugc: `I can't believe I waited this long to try ${name}`
    }
  };
  const lang = ['ru','uz','en'].includes(language) ? language : 'ru';
  const hook = (hooks[lang][style] || hooks[lang].dynamic).replace(/'/g, '');
  const benefit = (description ? description.substring(0, 50) : (
    lang === 'ru' ? 'Превосходное качество' : lang === 'uz' ? 'Ajoyib sifat' : 'Premium quality'
  )).replace(/'/g, '');
  const benefit2 = lang === 'ru' ? 'Для тех кто выбирает лучшее' : lang === 'uz' ? 'Eng yaxshilarni tanlang' : 'Choose the best';
  const ctaText = (cta || (lang === 'ru' ? 'Закажите сейчас' : lang === 'uz' ? 'Hozir buyurtma qiling' : 'Order now')).replace(/'/g, '');
  console.log('[AI SCRIPT] Fallback script generated');
  return { t1: hook, t2: benefit, t3: benefit2, t4: ctaText };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'images');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

app.use('/videos', express.static(path.join(__dirname, 'uploads', 'videos')));

// Mock Voice Provider (just a text-to-speech placeholder for now, or just silence)
async function generateSpeech(text, language) {
  // In a real app we'd call an API. For now, generate a silent audio file or use a demo file.
  // We'll generate a 15-second silent audio file for the demo.
  const outputPath = path.join(__dirname, 'uploads', 'audio', `voice_${Date.now()}.mp3`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('anullsrc')
      .inputFormat('lavfi')
      .duration(15)
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}



app.post('/api/generations', upload.single('image'), async (req, res) => {
  try {
    const file = req.file;
    if (!file && process.env.DEMO_MODE !== 'true') {
      return res.status(400).json({ error: 'Image file is required' });
    }

    const { productName, description, cta, language, style, voiceType, t1: reqT1, t2: reqT2, t3: reqT3, t4: reqT4 } = req.body;
    
    // 1. Initializing
    const jobId = Date.now().toString();
    const videoDir = path.join(__dirname, 'uploads', 'videos');
    fs.mkdirSync(videoDir, { recursive: true });
    const outputVideoPath = path.join(videoDir, `${jobId}.mp4`);
    
    // Simulate generation asynchronously
    setTimeout(async () => {
      try {
        // 2. AI Script generation (with fallback)
        // Client-provided texts (from frontend AI call) take priority
        let t1 = reqT1 ? reqT1.replace(/'/g, '') : null;
        let t2 = reqT2 ? reqT2.replace(/'/g, '') : null;
        let t3 = reqT3 ? reqT3.replace(/'/g, '') : null;
        let t4 = reqT4 ? reqT4.replace(/'/g, '') : null;

        if (!t1) {
          // No script from client — generate server-side
          const generated = await generateAIScript({ productName, description, cta, language, style });
          t1 = generated.t1;
          t2 = generated.t2;
          t3 = generated.t3;
          t4 = generated.t4;
        } else {
          console.log('[AI SCRIPT] Using client-provided script texts');
        }

        // 3. Generating voice
        const audioPath = await generateSpeech(`${t1} ${t2} ${t3} ${t4}`, language);
        
        // 4. Creating video & adding subtitles via FFmpeg
        const imagePath = file ? file.path : path.join(__dirname, 'public', 'demo', 'product.jpg');
        
        // Ensure image exists in demo mode
        if (!fs.existsSync(imagePath)) {
            fs.mkdirSync(path.dirname(imagePath), { recursive: true });
            await new Promise((resolve) => {
                ffmpeg()
                .input('color=c=blue:s=1080x1920:d=1')
                .inputFormat('lavfi')
                .frames(1)
                .output(imagePath)
                .on('end', resolve)
                .run();
            });
        }

        await new Promise((resolve, reject) => {
          ffmpeg(imagePath)
            .loop(15)
            .input(audioPath)
            .complexFilter([
              // Force 1080x1920 portrait, pad with blurred background if needed, then Ken Burns zoom
              `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,zoompan=z='min(zoom+0.0010,1.4)':d=450:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920[bg]`,
              // HOOK: 0-3s
              `[bg]drawtext=text='${t1}':fontcolor=white:fontsize=68:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-380:enable='between(t,0,3)'[v1]`,
              // BENEFIT 1: 3-8s
              `[v1]drawtext=text='${t2}':fontcolor=white:fontsize=60:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=h-380:enable='between(t,3,8)'[v2]`,
              // BENEFIT 2: 8-12s
              `[v2]drawtext=text='${t3}':fontcolor=white:fontsize=60:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=h-380:enable='between(t,8,12)'[v3]`,
              // CTA: 12-15s (gold)
              `[v3]drawtext=text='${t4}':fontcolor=#FFD700:fontsize=80:box=1:boxcolor=black@0.7:boxborderw=22:x=(w-text_w)/2:y=h-380:enable='between(t,12,15)'[vout]`
            ])
            .outputOptions([
              '-map [vout]',
              '-map 1:a',
              '-c:v libx264',
              '-preset ultrafast',
              '-c:a aac',
              '-b:a 192k',
              '-pix_fmt yuv420p',
              '-r 30',
              '-s 1080x1920',
              '-t 15'
            ])
            .output(outputVideoPath)
            .on('end', resolve)
            .on('error', (err) => {
              console.error('FFmpeg Error:', err);
              reject(err);
            })
            .run();
        });
        
        // In real app, we would update status to COMPLETED here.
        console.log(`Video generated: ${outputVideoPath}`);
      } catch (err) {
        console.error('[VIDEO_GENERATION] [ERROR]', err);
      }
    }, 0);

    res.json({
      jobId,
      status: 'PROCESSING',
      message: 'Generation started'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to check status and get URL
app.get('/api/generations/:id', async (req, res) => {
  const jobId = req.params.id;
  const videoPath = path.join(__dirname, 'uploads', 'videos', `${jobId}.mp4`);
  
  if (fs.existsSync(videoPath)) {
    // Ensure FFmpeg has finished writing by checking file size is stable
    try {
      const size1 = fs.statSync(videoPath).size;
      await new Promise(r => setTimeout(r, 500));
      const size2 = fs.statSync(videoPath).size;
      if (size2 === size1 && size2 > 10000) {
        return res.json({ status: 'COMPLETED', url: `/videos/${jobId}.mp4` });
      }
    } catch (_) {}
    return res.json({ status: 'PROCESSING', progress: 80 });
  } else {
    return res.json({ status: 'PROCESSING', progress: 50 });
  }
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
server.on('error', (err) => {
    console.error('Server error:', err);
});
