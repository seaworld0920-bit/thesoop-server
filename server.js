const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 8080;

// CORS 전체 허용
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));

// 정적 파일 서빙 (HTML, mp3 등)
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ 
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// 헬스체크
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '맛모아 숏폼 서버 작동 중' });
});

app.get('/', (req, res) => {
  // public/index.html 있으면 서빙, 없으면 상태 반환
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.json({ status: 'ok', message: '맛모아 숏폼 서버 작동 중' });
  }
});

// 영상 생성 API
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

    if (photos.length === 0) {
      return res.status(400).json({ error: '사진을 올려주세요' });
    }

    console.log(`영상 생성 시작: ${type}, 사진 ${photos.length}장, 스크립트 ${scripts.length}개`);

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

      // 자막 위치: 릴스=하단, 쇼츠=상단
      const subtitleY = type === 'reels' ? 'h-180' : '100';
      const duration = script.duration || 4;
      const text = (script.text || '').replace(/'/g, "\'").replace(/:/g, "\:").replace(/
/g, ' ');

      await new Promise((resolve, reject) => {
        ffmpeg(photo.path)
          .inputOptions(['-loop 1'])
          .complexFilter([
            // 스케일 + 크롭 (9:16)
            '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[scaled]',
            // Ken Burns 줌인
            `[scaled]zoompan=z='min(zoom+0.001,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${duration*25}:s=1080x1920:fps=25[zoomed]`,
            // 자막
            `[zoomed]drawtext=text='${text}':fontsize=55:fontcolor=white:borderw=5:bordercolor=black@0.8:x=(w-text_w)/2:y=${subtitleY}:line_spacing=12[out]`
          ])
          .outputOptions([
            `-t ${duration}`,
            '-map [out]',
            '-c:v libx264',
            '-preset ultrafast',
            '-pix_fmt yuv420p',
            '-r 25',
            '-an'
          ])
          .save(clipPath)
          .on('end', () => { console.log(`클립 ${i} 완료`); resolve(); })
          .on('error', (err) => { console.error(`클립 ${i} 오류:`, err); reject(err); });
      });
    }

    // 클립 합치기
    const concatListPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    tmpFiles.push(concatListPath);
    fs.writeFileSync(concatListPath, clipPaths.map(p => `file '${p}'`).join('\n'));

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f concat', '-safe 0']);

      if (musicFile) {
        cmd = cmd.input(musicFile.path);
        cmd.outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-shortest',
          '-filter:a volume=0.15',
          '-movflags +faststart'
        ]);
      } else {
        cmd.outputOptions(['-c:v copy', '-an', '-movflags +faststart']);
      }

      cmd.save(outputPath)
        .on('end', () => { console.log('최종 영상 완성'); resolve(); })
        .on('error', reject);
    });

    // 파일 전송
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

app.listen(PORT, () => {
  console.log(`맛모아 숏폼 서버 실행 중: http://localhost:${PORT}`);
});
