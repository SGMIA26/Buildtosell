/**
 * ================================================================
 *  VALUITBIZ – CLOUDFLARE WORKER BACKEND ENGINE
 *  File: worker.js  |  Version: 2.0 – Multi-Scale Valuation Engine
 *
 *  Endpoints:
 *    POST /api/valuate          → Tính toán định giá 3 nhóm
 *    POST /api/create-order     → Tạo đơn hàng thanh toán SePay
 *    POST /api/webhook/sepay    → Nhận xác nhận thanh toán
 *    GET  /api/health           → Health check
 *
 *  Tích hợp:
 *    • Google Sheets API  – Lưu lead + kết quả (ẩn danh hóa)
 *    • Telegram Bot API   – Thông báo real-time
 *    • SePay Webhook      – Xác nhận chuyển khoản tự động
 *    • Resend API         – Gửi email PDF báo cáo
 *
 *  Biến môi trường (Cloudflare Dashboard → Worker → Settings):
 *    GOOGLE_SHEET_ID          – ID Google Sheet
 *    GOOGLE_SERVICE_ACCOUNT   – JSON Service Account (stringify)
 *    TELEGRAM_BOT_TOKEN       – Token từ @BotFather
 *    TELEGRAM_CHAT_ID         – Chat ID kênh/nhóm nhận thông báo
 *    SEPAY_WEBHOOK_SECRET     – Chuỗi bí mật xác thực SePay
 *    SEPAY_BANK_ACCOUNT       – Số tài khoản ngân hàng
 *    SEPAY_BANK_BIN           – BIN ngân hàng (MB=970422, VCB=970436...)
 *    RESEND_API_KEY           – API Key Resend.com
 *    ALLOWED_ORIGIN           – Domain frontend (https://valuitbiz.com)
 * ================================================================
 */

export default {
  async fetch(request, env, ctx) {

    // ============================================================
    // CORS – Chỉ cho phép domain frontend gọi API
    // ============================================================
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Secret',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { pathname } = new URL(request.url);

    try {
      if (pathname === '/api/valuate'       && request.method === 'POST') return handleValuate(request, env, cors);
      if (pathname === '/api/create-order'  && request.method === 'POST') return handleCreateOrder(request, env, cors);
      if (pathname === '/api/webhook/sepay' && request.method === 'POST') return handleSepayWebhook(request, env, cors);
      if (pathname === '/api/health'        && request.method === 'GET')  return jsonRes({ status: 'ok', v: '2.0' }, 200, cors);

      return jsonRes({ error: 'Endpoint không tồn tại.' }, 404, cors);

    } catch (err) {
      console.error('[WORKER]', err.message, err.stack);
      return jsonRes({ error: 'Lỗi hệ thống.', code: 'INTERNAL_ERROR' }, 500, cors);
    }
  }
};

/* ================================================================
   HANDLER 1 – /api/valuate
   Nhận answers từ Frontend → Chạy thuật toán → Lưu Sheets + Telegram
================================================================ */

async function handleValuate(request, env, cors) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'Body không hợp lệ (phải là JSON).' }, 400, cors); }

  const { segment, answers } = body;

  if (!segment || !['startup', 'sme', 'enterprise'].includes(segment))
    return jsonRes({ error: 'Tham số segment không hợp lệ.' }, 400, cors);

  if (!answers || typeof answers !== 'object')
    return jsonRes({ error: 'Dữ liệu answers không hợp lệ.' }, 400, cors);

  // Chạy engine tính toán
  let result;
  if (segment === 'startup')    result = computeStartup(answers);
  if (segment === 'sme')        result = computeSME(answers);
  if (segment === 'enterprise') result = computeEnterprise(answers);

  const sessionId = generateSessionId();

  // Lưu Sheets + gửi Telegram (bất đồng bộ, không chặn response)
  fire(() => saveToSheets(env, { sessionId, segment, answers: sanitizeAnswers(answers), result, timestamp: new Date().toISOString() }));
  fire(() => sendTelegram(env, { sessionId, segment, finalValuation: result.finalValuation }));

  return jsonRes({ status: 'success', sessionId, segment, result }, 200, cors);
}

/* ================================================================
   HANDLER 2 – /api/create-order
   Nhận name + email + sessionId → Tạo QR SePay → Lưu Lead Sheet
================================================================ */

async function handleCreateOrder(request, env, cors) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'Body không hợp lệ.' }, 400, cors); }

  const { name, email, sessionId, segment } = body;

  if (!name || !email || !email.includes('@'))
    return jsonRes({ error: 'Họ tên và email hợp lệ là bắt buộc.' }, 400, cors);

  const orderId  = `VB-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  const amount   = 350000; // ~$15 USD

  const bankBin  = env.SEPAY_BANK_BIN     || '970422'; // MB Bank mặc định
  const bankAcc  = env.SEPAY_BANK_ACCOUNT || '0000000000';
  const addInfo  = encodeURIComponent(`ValuitBiz ${orderId}`);
  const accName  = encodeURIComponent('VALUITBIZ');

  const paymentInfo = {
    orderId,
    amount,
    description: `ValuitBiz ${orderId}`,
    bankAccount: bankAcc,
    bankBin,
    // VietQR URL – hiển thị trực tiếp dạng <img src="..."> trên Frontend
    qrUrl: `https://img.vietqr.io/image/${bankBin}-${bankAcc}-compact2.jpg?amount=${amount}&addInfo=${addInfo}&accountName=${accName}`,
  };

  // Lưu lead vào Sheet riêng (TÁCH BIỆT với Sheet số liệu tài chính)
  fire(() => saveLeadToSheets(env, {
    orderId, sessionId: sessionId || 'N/A', name, email,
    segment: segment || 'N/A', status: 'pending',
    timestamp: new Date().toISOString()
  }));

  // Thông báo Telegram có đơn mới
  fire(() => sendTelegram(env, { type: 'NEW_ORDER', orderId, name, email, segment }));

  return jsonRes({ status: 'success', paymentInfo }, 200, cors);
}

/* ================================================================
   HANDLER 3 – /api/webhook/sepay
   SePay gọi endpoint này khi phát hiện giao dịch khớp nội dung CK
================================================================ */

async function handleSepayWebhook(request, env, cors) {
  // Xác thực bí mật SePay
  const secret = request.headers.get('x-sepay-secret') || '';
  if (env.SEPAY_WEBHOOK_SECRET && secret !== env.SEPAY_WEBHOOK_SECRET)
    return jsonRes({ error: 'Unauthorized' }, 401, cors);

  let payload;
  try { payload = await request.json(); }
  catch { return jsonRes({ error: 'Payload không hợp lệ.' }, 400, cors); }

  const { transferType, transferAmount, content, code, id: txnId } = payload;

  // Chỉ xử lý giao dịch tiền vào
  if (transferType !== 'in')
    return jsonRes({ success: true, message: 'Bỏ qua giao dịch tiền ra.' }, 200, cors);

  // Tách orderId từ nội dung chuyển khoản (pattern: VB-TIMESTAMP-XXXX)
  const match = (content || code || '').match(/VB-\d+-[A-Z0-9]+/);
  if (!match) {
    console.warn('[SEPAY] Không tìm được orderId trong:', content);
    return jsonRes({ success: true, message: 'Không khớp orderId.' }, 200, cors);
  }

  const orderId = match[0];
  const STATUS  = transferAmount >= 350000 ? 'paid' : 'partial_payment';

  // Cập nhật trạng thái + gửi email + thông báo Telegram
  fire(() => updateOrderStatus(env, orderId, STATUS, payload));

  if (STATUS === 'paid') {
    fire(async () => {
      const lead = await getLeadByOrderId(env, orderId);
      if (lead) await sendReportEmail(env, lead);
    });
    fire(() => sendTelegram(env, {
      type: 'PAYMENT_CONFIRMED', orderId,
      amount: transferAmount, txnId
    }));
  }

  // SePay yêu cầu response { success: true }
  return jsonRes({ success: true }, 200, cors);
}


/* ================================================================
   THUẬT TOÁN – NHÓM 1: STARTUP
   Berkus 5 yếu tố + Funding-implied valuation
================================================================ */

function computeStartup(ans) {
  const M = 1_000_000;
  const B = 1_000_000_000;
  const CAP = 500 * M; // Tối đa 500 triệu / yếu tố Berkus

  // Yếu tố 1: Giai đoạn phát triển
  const stageScore = { idea: 100, mvp: 300, revenue: 450, growth: 500 };
  const s1 = Math.min((stageScore[ans.idea_stage] || 100) * M, CAP);

  // Yếu tố 2: Đội ngũ (giá trị do user chọn trực tiếp: 0 / 250 / 500)
  const s2 = Math.min(safeFloat(ans.team_score) * M, CAP);

  // Yếu tố 3: TAM – score = TAM(tỷ) × 0.0005 × 1B, tối đa 500tr
  const tam = safeFloat(ans.tam_billion) * B;
  const s3  = Math.min(tam * 0.0005, CAP);

  // Yếu tố 4: IP / Công nghệ lõi
  const s4 = Math.min(safeFloat(ans.ip_score) * M, CAP);

  // Yếu tố 5: Traction (khách hàng trả tiền)
  const s5 = Math.min(safeFloat(ans.product_score) * M, CAP);

  const berkusVal = s1 + s2 + s3 + s4 + s5;

  // Điều chỉnh theo vốn đã gọi: funding-implied = raise × 3 (giả định 33% stake)
  const raise          = safeFloat(ans.funding_raised_billion) * B;
  const fundingImplied = raise * 3;

  // Kết hợp: 60% Berkus + 40% Funding Implied (chỉ khi đã gọi vốn)
  const finalVal = raise > 0
    ? (berkusVal * 0.60) + (fundingImplied * 0.40)
    : berkusVal;

  return {
    segment:        'startup',
    finalValuation: Math.round(Math.max(finalVal, 0)),
    pricePerShare:  Math.round(Math.max(finalVal, 0) / 1_000_000),
    isLoss:         false,
    methods: [
      { name: 'Ý tưởng / Giai đoạn (Berkus)', value: Math.round(s1), weight: 0.20 },
      { name: 'Đội ngũ & Kinh nghiệm',         value: Math.round(s2), weight: 0.15 },
      { name: 'Quy mô thị trường (TAM)',         value: Math.round(s3), weight: 0.25 },
      { name: 'Công nghệ lõi / IP',              value: Math.round(s4), weight: 0.15 },
      { name: 'Traction (khách trả tiền)',        value: Math.round(s5), weight: 0.25 },
    ],
    meta: { berkusVal: Math.round(berkusVal), fundingImplied: Math.round(fundingImplied) }
  };
}


/* ================================================================
   THUẬT TOÁN – NHÓM 2: SMEs
   P/E · P/S · P/B · Gordon Growth Model
   Logic đặc biệt: tự động dịch trọng số khi LNST <= 0
   Chiết khấu BCTC: A=100% / B=50% / C=25%
================================================================ */

function computeSME(ans) {
  const M = 1_000_000;

  // Parse (đơn vị triệu VNĐ → VNĐ)
  const rev    = safeFloat(ans.revenue)    * M;
  const profit = safeFloat(ans.net_profit) * M;
  const equity = safeFloat(ans.equity)     * M;
  const shares = safeInt(ans.total_shares) || 1_000_000;
  const divPct = safeFloat(ans.dividend_pct) / 100;
  const bctc   = ans.bctc_transparency || 'A';
  const model  = ans.biz_model || 'trading';

  // Bội số ngành theo mô hình kinh doanh
  const mult = getMultiples(model);

  // ── Trọng số mặc định (khi có lãi)
  let w = { pe: 0.20, ps: 0.50, pb: 0.20, gordon: 0.10 };

  // ── LOGIC ĐẶC BIỆT KHI DOANH NGHIỆP LỖ (LNST <= 0)
  if (profit <= 0) {
    w.pe = 0; w.gordon = 0;
    if (model === 'franchise' || model === 'fb_chain') {
      w.ps = 0.60; w.pb = 0.40;          // Bảo vệ giá trị qua hạ tầng mạng lưới
    } else if (model === 'saas' || model === 'marketplace') {
      w.ps = 0.90; w.pb = 0.10;          // Ưu tiên top-line ARR / GMV
    } else {
      w.ps = 0.30; w.pb = 0.70;          // Giá trị sổ sách tài sản cố định
    }
  }

  // Giá trị từng phương pháp
  const vPE     = profit > 0 ? profit * mult.pe : 0;
  const vPS     = rev    * mult.ps;
  const vPB     = equity * mult.pb;
  const d0      = (profit > 0 && divPct > 0) ? profit * divPct : 0;
  const vGordon = d0 > 0 ? (d0 * 1.05) / (0.15 - 0.05) : 0;

  // Chiết khấu theo BCTC (Gordon KHÔNG chiết khấu – phản ánh dòng cổ tức thực)
  const df = { A: 1.00, B: 0.50, C: 0.25 }[bctc] || 1.00;
  const discountedBase = ((vPE * w.pe) + (vPS * w.ps) + (vPB * w.pb)) * df;
  const finalVal       = discountedBase + (vGordon * w.gordon);

  return {
    segment:        'sme',
    finalValuation: Math.round(Math.max(finalVal, 0)),
    pricePerShare:  Math.round(Math.max(finalVal / shares, 0)),
    isLoss:         profit <= 0,
    bctc,
    discountFactor: df,
    multiples:      mult,
    methods: [
      { name: `P/E × ${mult.pe}`,      value: Math.round(vPE),     weight: w.pe     },
      { name: `P/S × ${mult.ps}`,      value: Math.round(vPS),     weight: w.ps     },
      { name: `P/B × ${mult.pb}`,      value: Math.round(vPB),     weight: w.pb     },
      { name: 'Gordon Growth Model',    value: Math.round(vGordon), weight: w.gordon },
    ],
    meta: { weights: w, isNegativeProfit: profit <= 0 }
  };
}


/* ================================================================
   THUẬT TOÁN – NHÓM 3: ENTERPRISE
   FCFF DCF 5 năm + Terminal Value (Gordon Perpetuity)
   Cross-check: EV/EBITDA
================================================================ */

function computeEnterprise(ans) {
  const B = 1_000_000_000;

  const ebitda    = safeFloat(ans.ebitda)     * B;
  const totalDebt = safeFloat(ans.total_debt) * B;
  const cash      = safeFloat(ans.cash)       * B;
  const fcf1      = safeFloat(ans.fcf_year1)  * B;
  const g5yr      = safeFloat(ans.growth_rate) / 100;
  const wacc      = Math.max(safeFloat(ans.wacc) / 100, 0.05); // tối thiểu 5%
  const shares    = safeInt(ans.total_shares_ent) || 50_000_000;

  const gT  = 0.03;                               // Terminal growth rate cố định 3%
  const wEff = Math.max(wacc, gT + 0.005);       // WACC > gT để tránh chia cho 0

  // DCF 5 năm: tính NPV từng năm
  let dcfPV = 0;
  const fcfYears = [];
  for (let yr = 1; yr <= 5; yr++) {
    const fcfYr = fcf1 * Math.pow(1 + g5yr, yr - 1);
    const pv    = fcfYr / Math.pow(1 + wEff, yr);
    dcfPV      += pv;
    fcfYears.push({ year: yr, fcf: Math.round(fcfYr), pv: Math.round(pv) });
  }

  // Terminal Value: FCF năm 6 / (WACC - g_terminal)
  const fcf6      = fcf1 * Math.pow(1 + g5yr, 5);
  const tv        = fcf6 / (wEff - gT);
  const tvPV      = tv   / Math.pow(1 + wEff, 5);

  const ev        = dcfPV + tvPV;
  const netDebt   = totalDebt - cash;
  const equityVal = ev - netDebt;
  const pps       = Math.max(equityVal, 0) / shares;

  return {
    segment:         'enterprise',
    finalValuation:  Math.round(Math.max(equityVal, 0)),
    pricePerShare:   Math.round(Math.max(pps, 0)),
    enterpriseValue: Math.round(ev),
    netDebt:         Math.round(netDebt),
    evEbitda:        ebitda > 0 ? (ev / ebitda).toFixed(1) : 'N/A',
    fcfProjection:   fcfYears,
    methods: [
      { name: 'NPV Dòng tiền tự do 5 năm (DCF)',  value: Math.round(dcfPV), weight: 0.55 },
      { name: 'Terminal Value (chiết khấu về PV)', value: Math.round(tvPV),  weight: 0.40 },
      { name: 'EV/EBITDA cross-check',             value: Math.round(ev),    weight: 0.05 },
    ],
    meta: {
      wacc: wEff, g5yr, gTerminal: gT,
      tvGross:     Math.round(tv),
      tvShareOfEV: ev > 0 ? ((tvPV / ev) * 100).toFixed(1) + '%' : 'N/A'
    }
  };
}


/* ================================================================
   INDUSTRY MULTIPLES – Bội số ngành tham chiếu
   Nguồn: HOSE/HNX sector average 2024–2025
================================================================ */

function getMultiples(model) {
  const map = {
    saas:          { pe: 28.0, ps: 6.50, pb: 5.00 },
    marketplace:   { pe: 25.0, ps: 5.00, pb: 4.50 },
    franchise:     { pe: 16.45,ps: 2.03, pb: 3.02 },
    fb_chain:      { pe: 16.45,ps: 2.03, pb: 3.02 },
    manufacturing: { pe: 12.0, ps: 1.20, pb: 1.80 },
    trading:       { pe: 10.5, ps: 0.80, pb: 1.50 },
    services:      { pe: 14.0, ps: 1.80, pb: 2.50 },
  };
  return map[model] || { pe: 12.0, ps: 1.50, pb: 2.00 };
}


/* ================================================================
   GOOGLE SHEETS – Lưu dữ liệu
   Xác thực: Service Account JWT → Access Token
================================================================ */

async function saveToSheets(env, { sessionId, segment, answers, result, timestamp }) {
  if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_SERVICE_ACCOUNT) return;
  const tok = await getGoogleToken(env);
  if (!tok) return;

  // Sheet 1: DuLieuDinhGia – CHỈ số liệu tài chính, KHÔNG có tên/email
  const row = [
    timestamp, sessionId, segment.toUpperCase(),
    answers.biz_model || 'N/A',
    answers.bctc_transparency || 'N/A',
    answers.revenue || answers.ebitda || '0',
    answers.net_profit || answers.fcf_year1 || '0',
    answers.equity || answers.total_debt || '0',
    answers.total_shares || answers.total_shares_ent || '0',
    result.finalValuation,
    result.pricePerShare,
    result.isLoss ? 'LỖ' : 'LÃI',
  ];

  await sheetsAppend(env, tok, 'DuLieuDinhGia!A:L', row);
}

async function saveLeadToSheets(env, { orderId, sessionId, name, email, segment, status, timestamp }) {
  if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_SERVICE_ACCOUNT) return;
  const tok = await getGoogleToken(env);
  if (!tok) return;

  // Sheet 2: DuLieuLead – TÁCH BIỆT, chứa PII (tên, email)
  const row = [timestamp, orderId, sessionId, segment.toUpperCase(), name, email, status, ''];
  await sheetsAppend(env, tok, 'DuLieuLead!A:H', row);
}

async function updateOrderStatus(env, orderId, status, txnPayload) {
  if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_SERVICE_ACCOUNT) return;
  const tok = await getGoogleToken(env);
  if (!tok) return;

  const row = [
    new Date().toISOString(), orderId, 'UPDATE', status.toUpperCase(),
    txnPayload?.id || '',
    txnPayload?.transferAmount || '',
    txnPayload?.referenceCode || '',
    JSON.stringify(txnPayload || {}).slice(0, 300),
  ];
  await sheetsAppend(env, tok, 'LichSuThanhToan!A:H', row);
}

async function getLeadByOrderId(env, orderId) {
  try {
    const tok = await getGoogleToken(env);
    if (!tok) return null;

    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/DuLieuLead!A:H`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!resp.ok) return null;

    const { values = [] } = await resp.json();
    const row = values.find(r => r[1] === orderId);
    if (!row) return null;

    return { orderId: row[1], sessionId: row[2], segment: row[3], name: row[4], email: row[5] };
  } catch (err) {
    console.error('[getLeadByOrderId]', err.message);
    return null;
  }
}

async function sheetsAppend(env, token, range, values) {
  const sheetId = env.GOOGLE_SHEET_ID;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  });

  if (!resp.ok) console.error('[SHEETS APPEND]', resp.status, await resp.text());
}

/**
 * Lấy Google Access Token từ Service Account (JWT RS256)
 */
async function getGoogleToken(env) {
  try {
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);

    const b64url = (obj) => btoa(JSON.stringify(obj))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const now = Math.floor(Date.now() / 1000);
    const hdr = b64url({ alg: 'RS256', typ: 'JWT' });
    const pld = b64url({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    });

    const sigInput = `${hdr}.${pld}`;
    const pem = sa.private_key.replace(/\\n/g, '\n');
    const raw = atob(pem.replace(/-----.*?-----/g, '').replace(/\s/g, ''));
    const der = Uint8Array.from(raw, c => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
      'pkcs8', der.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );

    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const jwt = `${sigInput}.${sigB64}`;

    const tkResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    if (!tkResp.ok) { console.error('[GOOGLE TOKEN]', await tkResp.text()); return null; }
    return (await tkResp.json()).access_token;

  } catch (err) {
    console.error('[GOOGLE TOKEN ERROR]', err.message);
    return null;
  }
}


/* ================================================================
   TELEGRAM BOT API
================================================================ */

async function sendTelegram(env, data) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const tz = (d) => new Date(d || Date.now()).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const esc = (s) => String(s || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

  let msg = '';

  if (data.type === 'NEW_ORDER') {
    msg = [
      `🛒 *ĐƠN HÀNG MỚI – ValuitBiz*`,
      `📋 Order: \`${data.orderId}\``,
      `👤 KH: ${esc(data.name)} | 📧 ${esc(data.email)}`,
      `📊 Phân khúc: *${(data.segment || '').toUpperCase()}*`,
      `💰 *350,000 VNĐ* · ${tz()}`,
    ].join('\n');

  } else if (data.type === 'PAYMENT_CONFIRMED') {
    msg = [
      `✅ *THANH TOÁN XÁC NHẬN – ValuitBiz*`,
      `📋 Order: \`${data.orderId}\``,
      `💵 Nhận: *${(data.amount || 0).toLocaleString('vi-VN')} VNĐ*`,
      `🏦 TXN: \`${data.txnId || 'N/A'}\``,
      `📨 Đang gửi PDF đến email khách… · ${tz()}`,
    ].join('\n');

  } else {
    const valStr = data.finalValuation
      ? (data.finalValuation / 1e9).toFixed(2) + ' tỷ VNĐ'
      : 'N/A';
    msg = [
      `📊 *ĐỊNH GIÁ MỚI – ValuitBiz*`,
      `🆔 Session: \`${data.sessionId}\``,
      `📁 Phân khúc: *${(data.segment || '').toUpperCase()}*`,
      `💎 Giá trị ước tính: *~${valStr}*`,
      `⏰ ${tz()}`,
    ].join('\n');
  }

  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
  });

  if (!resp.ok) console.error('[TELEGRAM]', resp.status, await resp.text());
}


/* ================================================================
   GỬI EMAIL BÁO CÁO – Resend API
================================================================ */

async function sendReportEmail(env, { name, email, segment, orderId }) {
  if (!env.RESEND_API_KEY) return;

  const htmlBody = `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><style>
body{font-family:Arial,sans-serif;background:#f8f5ee;padding:32px;color:#1a2a3a}
.card{background:#fff;border-radius:12px;padding:36px;max-width:540px;margin:0 auto;box-shadow:0 2px 24px rgba(0,0,0,.08)}
h1{font-size:22px;color:#0D1B2E;margin-bottom:8px}.accent{color:#D98E22}
p{font-size:15px;line-height:1.7;color:#445}
.badge{background:#FEF6E4;border:1px solid #F5BF62;color:#854F0B;border-radius:20px;padding:4px 14px;font-size:12px;display:inline-block;margin-bottom:18px}
.btn{display:inline-block;background:#D98E22;color:#07101E;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;margin-top:18px}
.disclaimer{background:#fff8f0;border-left:3px solid #D98E22;padding:12px 16px;font-size:12px;color:#7a5c2a;margin-top:24px}
</style></head><body><div class="card">
<span class="badge">✓ Xác nhận đơn hàng ${orderId}</span>
<h1>Xin chào, <span class="accent">${name}</span>!</h1>
<p>Cảm ơn bạn đã tin tưởng <strong>ValuitBiz</strong>. Báo cáo phân tích chuyên sâu cho phân khúc <strong>${segment.toUpperCase()}</strong> đang được chuẩn bị và sẽ gửi đến email này trong vòng <strong>15 phút</strong>.</p>
<p>Nếu quá thời gian trên mà chưa nhận được, vui lòng liên hệ hỗ trợ kèm ảnh bill chuyển khoản.</p>
<a href="https://valuitbiz.com/ho-tro?order=${orderId}" class="btn">Liên hệ hỗ trợ →</a>
<div class="disclaimer">⚠ Kết quả chỉ mang tính tham khảo nội bộ. Không phải chứng thư thẩm định giá theo quy định Bộ Tài chính Việt Nam và không có giá trị pháp lý trong giao dịch đầu tư, thế chấp, M&A hoặc kê khai thuế.</div>
</div></body></html>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'ValuitBiz <bao-cao@valuitbiz.com>',
      to:      [email],
      subject: `[ValuitBiz] Xác nhận ${orderId} – Báo cáo đang được chuẩn bị`,
      html:    htmlBody,
    }),
  });

  if (!resp.ok) console.error('[EMAIL]', resp.status, await resp.text());
  else console.log('[EMAIL SENT]', email, orderId);
}


/* ================================================================
   UTILITIES
================================================================ */

function jsonRes(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function safeFloat(val) {
  const n = parseFloat(String(val || '0').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function safeInt(val) {
  const n = parseInt(String(val || '0').replace(/,/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function generateSessionId() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function sanitizeAnswers(ans) {
  const safe = { ...ans };
  delete safe.owner_name;
  delete safe.email;
  delete safe.phone;
  return safe;
}

// Gọi bất đồng bộ mà không chặn response chính
function fire(fn) {
  fn().catch(err => console.error('[FIRE ERROR]', err.message));
}
