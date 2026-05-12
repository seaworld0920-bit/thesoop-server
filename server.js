const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });

// 헬스체크
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '맛모아 숏폼 서버 작동 중' });
});

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.json({ status: 'ok', message: '맛모아 숏폼 서버 작동 중' });
  }
});

// ── Gemini API 스크립트 생성 ──
app.post('/generate-script', async (req, res) => {
  try {
    const { menu, point, goal, tone } = req.body;
    if (!menu) return res.status(400).json({ error: '메뉴를 입력해주세요' });

    const prompt = `당신은 반찬가게 전문 숏폼 스크립트 작가입니다.

아래 정보로 15초 숏폼 스크립트를 작성하세요.
메뉴: ${menu}
홍보 포인트: ${point || ''}
강조 목표: ${goal || '방문 유도'}
톤: ${tone || '감성적'}

반드시 아래 JSON 형식으로만 응답하세요. 마크다운 없이 순수 JSON만:
{
  "hook": "훅 자막 (2~3줄, 시선을 확 잡는 문장)",
  "body1": "본문1 자막 (메뉴 소개, 2줄)",
  "body2": "본문2 자막 (특징 강조, 2줄)",
  "cta": "CTA 자막 (방문 유도, 1~2줄)",
  "reels_caption": "인스타 릴스 캡션 (이모지 풍부하게, 감성적 문장, 4~5줄, 해시태그 없이)",
  "shorts_caption": "유튜브 쇼츠 캡션 (간결하고 정보 중심, 첫 줄에 핵심 키워드, 2~3줄, 링크 유도 문구 포함)",
  "hashtags": ["태그1","태그2","태그3","태그4","태그5","태그6","태그7","태그8","태그9","태그10","태그11","태그12","태그13","태그14","태그15"]
}

한국어 메인, 감성 영어 포인트 자연스럽게 포함. 반찬가게 따뜻한 분위기.`;

    const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-8b'];
    let result = null;
    let lastErr = '';

    for (const model of models) {
      try {
        const data = await callGemini(model, prompt);
        if (data && !data.error) {
          let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          text = text.replace(/```json|```/g, '').trim();
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            result = JSON.parse(match[0]);
            console.log(`스크립트 생성 성공: ${model}`);
            break;
          }
        }
        lastErr = data?.error?.message || '응답 없음';
      } catch (e) {
        lastErr = e.message;
      }
    }

    if (!result) return res.status(500).json({ error: '스크립트 생성 실패: ' + lastErr });
    res.json(result);

  } catch (err) {
    console.error('스크립트 생성 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

function callGemini(model, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 영상 생성 API ──
app.post('/generate-video', upload.fields([
  { name: 'photos', maxCount: 5 },
  { name: 'music', maxCount: 1 }
]), async (req, res) => {
  const tmpFiles = [];
  try {
    const photos = req.files['photos'] || [];
    const musicFile = req.files['music'] ? req.files['music'][0] : null;
    const scripts = JSON.parse(req.body.scripts || '[]');
    const type = req.body.type || 'reels';

    if (photos.length === 0) return res.status(400).json({ error: '사진을 올려주세요' });

    console.log(`영상 생성: ${type}, 사진 ${photos.length}장`);

    const outputPath = path.join(os.tmpdir(), `output_${Date.now()}_${type}.mp4`);
    tmpFiles.push(outputPath);
    const clipPaths = [];
    const sceneCount = Math.min(photos.length, scripts.length, 4);

    for (let i = 0; i < sceneCount; i++) {
      const photo = photos[i];
      const script = scripts[i];
      const clipPath = path.join(os.tmpdir(), `clip_${Date.now()}_${i}.mp4`);
      tmpFiles.push(clipPath);
      clipPaths.push(clipPath);

      const subtitleY = type === 'reels' ? 'h-180' : '100';
      const duration = script.duration || 4;
      const text = (script.text || '').replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\n/g, ' ');

      await new Promise((resolve, reject) => {
        ffmpeg(photo.path)
          .inputOptions(['-loop 1'])
          .complexFilter([
            '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[scaled]',
            `[scaled]zoompan=z='min(zoom+0.001,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${duration*25}:s=1080x1920:fps=25[zoomed]`,
            `[zoomed]drawtext=text='${text}':fontsize=55:fontcolor=white:borderw=5:bordercolor=black@0.8:x=(w-text_w)/2:y=${subtitleY}:line_spacing=12[out]`
          ])
          .outputOptions([`-t ${duration}`, '-map [out]', '-c:v libx264', '-preset ultrafast', '-pix_fmt yuv420p', '-r 25', '-an'])
          .save(clipPath)
          .on('end', () => { console.log(`클립 ${i} 완료`); resolve(); })
          .on('error', (err) => { console.error(`클립 ${i} 오류:`, err); reject(err); });
      });
    }

    const concatListPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    tmpFiles.push(concatListPath);
    fs.writeFileSync(concatListPath, clipPaths.map(p => `file '${p}'`).join('\n'));

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg().input(concatListPath).inputOptions(['-f concat', '-safe 0']);
      if (musicFile) {
        cmd = cmd.input(musicFile.path);
        cmd.outputOptions(['-c:v copy', '-c:a aac', '-shortest', '-filter:a volume=0.15', '-movflags +faststart']);
      } else {
        cmd.outputOptions(['-c:v copy', '-an', '-movflags +faststart']);
      }
      cmd.save(outputPath).on('end', resolve).on('error', reject);
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="matmoa_${type}_${Date.now()}.mp4"`);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
      photos.forEach(p => { try { fs.unlinkSync(p.path); } catch(e) {} });
      if (musicFile) { try { fs.unlinkSync(musicFile.path); } catch(e) {} }
    });

  } catch (err) {
    console.error('영상 생성 오류:', err);
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    res.status(500).json({ error: '영상 생성 실패: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`맛모아 숏폼 서버 실행 중: http://localhost:${PORT}`));
