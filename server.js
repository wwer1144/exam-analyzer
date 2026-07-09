const express = require('express');
const app = express();

app.use(express.json({ limit: '50mb' }));

// ====== 1) CORS: 실제 우리 프론트엔드 도메인만 허용 (* 전체 허용 금지) ======
const ALLOWED_ORIGINS = [
  'https://exam-analyze-rtm.netlify.app',
  'http://localhost:3000' // 로컬 테스트용
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ====== 2) 아주 단순한 메모리 기반 속도 제한 (IP당 분당/시간당 횟수 제한) ======
const rateBuckets = new Map(); // ip -> { minuteCount, minuteReset, hourCount, hourReset }
const MAX_PER_MINUTE = 5;
const MAX_PER_HOUR = 40;
function checkRateLimit(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b) {
    b = { minuteCount: 0, minuteReset: now + 60000, hourCount: 0, hourReset: now + 3600000 };
    rateBuckets.set(ip, b);
  }
  if (now > b.minuteReset) { b.minuteCount = 0; b.minuteReset = now + 60000; }
  if (now > b.hourReset) { b.hourCount = 0; b.hourReset = now + 3600000; }
  b.minuteCount++; b.hourCount++;
  return b.minuteCount <= MAX_PER_MINUTE && b.hourCount <= MAX_PER_HOUR;
}
// 메모리 누수 방지용 주기적 정리
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) {
    if (now > b.hourReset) rateBuckets.delete(ip);
  }
}, 10 * 60 * 1000);

// ====== 3) Supabase 로그인 토큰 검증 (로그인한 실제 사용자만 API 호출 가능) ======
const SUPABASE_URL = process.env.SUPABASE_URL;       // 예: https://xxxx.supabase.co
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
async function verifySupabaseUser(accessToken) {
  if (!accessToken || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': SUPABASE_ANON_KEY }
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

app.post('/api/analyze', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: { message: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' } });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = await verifySupabaseUser(token);
  if (!user) {
    return res.status(401).json({ error: { message: '로그인이 필요합니다.' } });
  }

  // ====== 4) 요청 내용 검증/제한 — 클라이언트가 임의로 크게/과하게 요청 못 하도록 서버가 강제로 상한선 적용 ======
  const body = req.body || {};
  const safeBody = {
    model: 'claude-sonnet-4-6', // 모델도 서버가 고정 (클라이언트 지정값 무시)
    max_tokens: Math.min(Number(body.max_tokens) || 8000, 10000),
    messages: Array.isArray(body.messages) ? body.messages.slice(0, 1) : [] // 메시지 1턴만 허용
  };
  if (Array.isArray(safeBody.messages[0]?.content)) {
    const imageCount = safeBody.messages[0].content.filter(c => c.type === 'image').length;
    if (imageCount > 20) {
      return res.status(400).json({ error: { message: '페이지 수가 너무 많습니다 (최대 20페이지).' } });
    }
  }
  if (body.tools && Array.isArray(body.tools)) {
    // 웹검색 도구만 허용하고, 검색 횟수 상한도 서버가 강제
    safeBody.tools = body.tools
      .filter(t => t.type === 'web_search_20250305')
      .map(t => ({ type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(Number(t.max_uses) || 5, 8) }));
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(safeBody)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
