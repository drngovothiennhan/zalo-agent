# zalo-agent

Trợ lý gia đình trên Zalo (Zalo Bot Platform) chạy trên Cloudflare Workers.

- `src/index.js` — webhook, lệnh, cron nhắc việc, `/setup`, `/debug`
- `src/brain.js` — gọi Workers AI (trò chuyện, tách lịch nhắc)
- `src/db.js` — D1: lịch sử trò chuyện, sổ ghi nhớ gia đình, lịch nhắc
- `src/zalo.js` — gọi Zalo Bot API
- `schema.sql` — cấu trúc D1

Cấu hình trên Cloudflare: secret `BOT_TOKEN`, `WEBHOOK_SECRET`; biến `ALLOWED_IDS` (ID Zalo cách nhau bằng dấu phẩy).
Webhook: `https://zalobot.hiutmc.com/webhook` (đăng ký bằng `/setup?key=<WEBHOOK_SECRET>`).
