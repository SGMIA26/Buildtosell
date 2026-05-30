# ValuitBiz – Hướng Dẫn Triển Khai End-to-End

## Cấu trúc file

```
valuitbiz/
├── index.html          ← Frontend (Cloudflare Pages)
├── worker.js           ← Backend Engine (Cloudflare Worker)
├── wrangler.toml       ← Cấu hình Worker
└── HUONG_DAN_TRIEN_KHAI.md
```

---

## BƯỚC 1 – Chuẩn bị Google Sheets

1. Tạo 1 Google Sheet mới → đặt tên bất kỳ (vd: **ValuitBiz DB**).
2. Lấy Sheet ID từ URL: `https://docs.google.com/spreadsheets/d/**{SHEET_ID}**/edit`
3. Tạo 3 tab sheet với tên chính xác:
   - `DuLieuDinhGia` – Cột: Timestamp / SessionID / Segment / BizModel / BCTC / Revenue / NetProfit / Equity / Shares / FinalValuation / PricePerShare / IsLoss
   - `DuLieuLead`    – Cột: Timestamp / OrderID / SessionID / Segment / Name / Email / Status / GhiChu
   - `LichSuThanhToan` – Cột: Timestamp / OrderID / Action / Status / TxnID / Amount / RefCode / Payload
4. **Service Account:**
   - Vào [Google Cloud Console](https://console.cloud.google.com) → IAM & Admin → Service Accounts → Create.
   - Cấp quyền **Editor** cho Sheet: Share sheet với email service account.
   - Tải JSON key → copy toàn bộ nội dung JSON (dùng ở Bước 3).

---

## BƯỚC 2 – Thiết lập Telegram Bot

1. Nhắn tin `@BotFather` trên Telegram → `/newbot` → Lấy **BOT_TOKEN**.
2. Thêm bot vào kênh/nhóm nhận thông báo.
3. Lấy **CHAT_ID**: Gửi `/start` vào nhóm → truy cập `https://api.telegram.org/bot{TOKEN}/getUpdates` → lấy `chat.id`.

---

## BƯỚC 3 – Deploy Cloudflare Worker

```bash
# Cài đặt Wrangler CLI
npm install -g wrangler

# Đăng nhập Cloudflare
wrangler login

# Cập nhật wrangler.toml:
# - Thay YOUR_CLOUDFLARE_ACCOUNT_ID bằng Account ID thực
# - Thay SEPAY_BANK_ACCOUNT, SEPAY_BANK_BIN

# Đặt các secret (nhập từng lệnh, Wrangler sẽ prompt nhập giá trị)
wrangler secret put GOOGLE_SHEET_ID
wrangler secret put GOOGLE_SERVICE_ACCOUNT   # paste nguyên JSON string
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put SEPAY_WEBHOOK_SECRET     # tự đặt chuỗi bí mật bất kỳ
wrangler secret put RESEND_API_KEY

# Deploy Worker
wrangler deploy
```

**URL Worker sau deploy:** `https://valuitbiz-backend.YOUR_SUBDOMAIN.workers.dev`

---

## BƯỚC 4 – Deploy Frontend (Cloudflare Pages)

1. Cloudflare Dashboard → **Pages** → Create Project → Connect Git hoặc Direct Upload.
2. Upload file `index.html`.
3. **Quan trọng:** Mở `index.html`, tìm comment `// TODO Giai đoạn 4` và thay:
   ```js
   // Thay URL Worker thực tế vào đây:
   const API_BASE = 'https://valuitbiz-backend.YOUR_SUBDOMAIN.workers.dev';
   ```
4. Trong hàm `nextStep()` (cuối luồng câu hỏi), thêm fetch đến `/api/valuate`:
   ```js
   const resp = await fetch(`${API_BASE}/api/valuate`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ segment: state.segment, answers: state.answers })
   });
   const { result } = await resp.json();
   state.calcResult = result;
   renderResult(result);
   ```

---

## BƯỚC 5 – Cấu hình SePay Webhook

1. Đăng ký tài khoản tại [SePay.vn](https://sepay.vn).
2. Dashboard → API → Webhooks → Thêm URL:
   ```
   https://valuitbiz.com/api/webhook/sepay
   ```
3. Đặt **Secret Key** = giá trị đã set ở `SEPAY_WEBHOOK_SECRET`.
4. SePay sẽ gửi POST đến URL này khi phát hiện giao dịch khớp pattern trong nội dung CK.

---

## BƯỚC 6 – Cấu hình Resend (Gửi Email)

1. Đăng ký tại [Resend.com](https://resend.com) (miễn phí 100 email/ngày).
2. Verify domain `valuitbiz.com` (thêm DNS record theo hướng dẫn).
3. API Keys → Create API Key → Copy vào secret `RESEND_API_KEY`.

---

## Kiểm tra hệ thống

```bash
# Health check
curl https://valuitbiz.com/api/health

# Test định giá SME (mẫu)
curl -X POST https://valuitbiz.com/api/valuate \
  -H "Content-Type: application/json" \
  -d '{
    "segment": "sme",
    "answers": {
      "industry": "F&B",
      "biz_model": "franchise",
      "bctc_transparency": "A",
      "revenue": "12000",
      "net_profit": "2000",
      "equity": "10000",
      "total_shares": "2000000",
      "dividend_pct": "10"
    }
  }'
```

**Kết quả mong đợi:** `finalValuation ≈ 25,000,000,000 VNĐ`, `pricePerShare ≈ 12,500`

---

## Cấu trúc Google Sheets (Dashboard CRM)

Sau khi hệ thống chạy, dùng Conditional Formatting trong Google Sheets:

| Sheet           | Màu dòng                                      |
|-----------------|-----------------------------------------------|
| DuLieuLead      | Xanh lá = `status = paid` / Vàng = `pending`  |
| LichSuThanhToan | Xanh = `PAID` / Cam = `PARTIAL_PAYMENT`       |

→ Nhìn vào Sheet là biết ngay tình hình doanh thu hằng ngày, không cần xây Admin panel.

---

## Lưu ý pháp lý (bắt buộc duy trì)

- **Tuyệt đối không** dùng từ "Thẩm định giá" / "Chứng thư thẩm định giá" trên bất kỳ giao diện nào.
- Disclaimer phải hiển thị tại: Footer, Checkbox kết quả, File PDF gửi email.
- Ẩn danh hóa: Sheet `DuLieuDinhGia` KHÔNG chứa tên/email. Sheet `DuLieuLead` chứa PII nhưng TÁCH BIỆT hoàn toàn. Tuân thủ NĐ 13/2023/NĐ-CP.
