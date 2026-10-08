# zalo-agent

Trợ lý gia đình trên Zalo (Zalo Bot Platform) chạy trên Cloudflare Workers.

- `src/index.js` — webhook, lệnh, cron nhắc việc, `/setup`, `/debug`
- `src/brain.js` — gọi Workers AI (trò chuyện, tách lịch nhắc)
- `src/db.js` — D1: lịch sử trò chuyện, sổ ghi nhớ gia đình, lịch nhắc
- `src/zalo.js` — gọi Zalo Bot API
- `src/vision.js` — đọc ảnh (Workers AI Gemma 3, hoặc Gemini nếu có `GEMINI_API_KEY`)
- `src/kb.js` — kho tài liệu: trang `/kb?key=…` để tải file, tra cứu bằng D1 FTS5
- `src/tools.js` — tạo file Word/Excel (R2, link `/f/…`), thời tiết (Open-Meteo), vẽ tranh (FLUX)
- `schema.sql` — cấu trúc D1

Cấu hình trên Cloudflare: secret `BOT_TOKEN`, `WEBHOOK_SECRET`; biến `ALLOWED_IDS` (ID Zalo cách nhau bằng dấu phẩy).
Webhook: `https://zalobot.hiutmc.com/webhook` (đăng ký bằng `/setup?key=<WEBHOOK_SECRET>`).
