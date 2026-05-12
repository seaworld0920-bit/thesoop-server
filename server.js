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
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 임시 파일 저장
const upload = multer({ dest: os.tmpdir() });

// 헬스체크
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '맛모아 숏폼 서버 작동 중' });
});

// 영상 생성 API
// POST /generate-video
// body: { scripts: [{text, duration}], music: 'base64...' }
// files: photos[] (이미지 파일들)
app.post('/generate-video', upload.fields([
  { name: 'photos', maxCount: 5 },
  { name: 'music', maxCount: 1 }
]), async (req, res) => {
  const tmpFiles = [];

  try {
    const photos = req.files['photos'] || [];
    const musicFile = req.files['music'] ? req.files['music'][0] : null;
    const scripts = JSON.parse(req.body.scripts || '[]');
    const type = req.body.type || 'reels'; // reels or shorts

    if (photos.length === 0) {
      return res.status(400).json({ error: '사진을 올려주세요' });
    }

    // 임시 출력 파일 경로
    const outputPath = path.join(os.tmpdir(), `output_${Date.now()}_${type}.mp4`);
    tmpFiles.push(outputPath);

    // 씬별 영상 클립 생성
    const clipPaths = [];

    for (let i = 0; i < Math.min(photos.length, scripts.length); i++) {
      const photo = photos[i];
      const script = scripts[i];
      const clipPath = path.join(os.tmpdir(), `clip_${Date.now()}_${i}.mp4`);
      tmpFiles.push(clipPath);
      clipPaths.push(clipPath);

      // 자막 위치 설정 (릴스: 하단 / 쇼츠: 상단)
      const subtitleY = type === 'reels' ? 'h-150' : '80';
      const duration = script.duration || 4;

      await new Promise((resolve, reject) => {
        ffmpeg(photo.path)
          .inputOptions(['-loop 1'])
          .outputOptions([
            `-t ${duration}`,
            '-vf', [
              // 9:16 비율로 크롭/패드
              'scale=1080:1920:force_original_aspect_ratio=increase',
              'crop=1080:1920',
              // Ken Burns 줌인 효과
              `zoompan=z='min(zoom+0.0015,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${duration*30}:s=1080x1920:fps=30`,
              // 자막
              `drawtext=text='${script.text.replace(/'/g, "\\'")}':fontsize=52:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=${subtitleY}:line_spacing=10:font='NanumGothic'`
            ].join(','),
            '-c:v libx264',
            '-preset fast',
            '-pix_fmt yuv420p',
            '-r 30'
          ])
          .save(clipPath)
          .on('end', resolve)
          .on('error', reject);
      });
    }

    // 클립들 합치기
    const concatListPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    tmpFiles.push(concatListPath);
    const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    // 음악과 합치기
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f concat', '-safe 0']);

      if (musicFile) {
        cmd = cmd
          .input(musicFile.path)
          .audioFilters('volume=0.15'); // 음악 볼륨 낮게
      }

      cmd
        .outputOptions([
          '-c:v copy',
          musicFile ? '-c:a aac' : '-an',
          musicFile ? '-shortest' : '',
          '-movflags +faststart'
        ].filter(Boolean))
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject);
    });

    // 파일 전송
    res.download(outputPath, `matmoa_${type}_${Date.now()}.mp4`, () => {
      // 임시 파일 정리
      tmpFiles.forEach(f => {
        try { fs.unlinkSync(f); } catch(e) {}
      });
      photos.forEach(p => {
        try { fs.unlinkSync(p.path); } catch(e) {}
      });
      if (musicFile) {
        try { fs.unlinkSync(musicFile.path); } catch(e) {}
      }
    });

  } catch (err) {
    console.error('영상 생성 오류:', err);
    tmpFiles.forEach(f => {
      try { fs.unlinkSync(f); } catch(e) {}
    });
    res.status(500).json({ error: '영상 생성 실패: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`맛모아 숏폼 서버 실행 중: http://localhost:${PORT}`);
});
