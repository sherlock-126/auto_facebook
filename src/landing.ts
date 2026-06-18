/**
 * Public landing page at fb.autonow.vn — served when anonymous visitor hits /.
 * Authenticated users get the dashboard instead. Dark theme matching the rest of the app.
 */

export function renderLanding(): string {
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fb.autonow.vn — Tìm khách hàng trong các nhóm Facebook tự động</title>
<meta name="description" content="Crawl posts từ Facebook Groups, phân loại lead bằng AI, theo dõi pipeline sale. Self-hosted trên VPS của bạn.">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0b1020; color: #e8ecf3; line-height: 1.55; }
  a { color: #7ea7ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { padding: 18px 24px; border-bottom: 1px solid #1c2546; display: flex; justify-content: space-between; align-items: center; }
  header .brand { font-weight: 700; font-size: 16px; }
  header .brand small { display: block; font-size: 10px; color: #8a96bd; font-weight: 400; margin-top: 2px; }
  header nav a { font-size: 13px; margin-left: 18px; color: #cad3ed; }
  header nav .cta { background: #3b6ef0; color: #fff; padding: 8px 16px; border-radius: 6px; font-weight: 600; }
  header nav .cta:hover { filter: brightness(1.1); text-decoration: none; }

  main { max-width: 1100px; margin: 0 auto; padding: 64px 24px; }

  .hero { text-align: center; margin-bottom: 80px; }
  .hero h1 { font-size: 44px; line-height: 1.15; margin: 0 0 18px; font-weight: 700; letter-spacing: -0.5px; }
  .hero h1 span { background: linear-gradient(135deg, #7ea7ff, #b89aff); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero p.sub { font-size: 18px; color: #a9b3d1; max-width: 640px; margin: 0 auto 32px; }
  .hero .cta-row { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
  .btn { padding: 13px 26px; border-radius: 8px; font-size: 15px; font-weight: 600; display: inline-block; transition: all .15s; }
  .btn-primary { background: #3b6ef0; color: #fff; }
  .btn-primary:hover { background: #2e5cc8; text-decoration: none; }
  .btn-ghost { background: transparent; color: #cad3ed; border: 1px solid #2a3560; }
  .btn-ghost:hover { background: #131a33; text-decoration: none; }
  .hero .hint { margin-top: 16px; font-size: 12px; color: #8a96bd; }

  section { margin-bottom: 80px; }
  section h2 { text-align: center; font-size: 30px; margin: 0 0 12px; font-weight: 700; }
  section .lead { text-align: center; color: #a9b3d1; max-width: 600px; margin: 0 auto 40px; font-size: 15px; }

  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
  @media (max-width: 800px) { .grid-3, .grid-4 { grid-template-columns: 1fr; } .hero h1 { font-size: 32px; } }

  .card { background: #131a33; border: 1px solid #222a4a; border-radius: 12px; padding: 24px; }
  .card .icon { width: 36px; height: 36px; background: #1c2546; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 14px; font-size: 18px; }
  .card h3 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  .card p { margin: 0; color: #a9b3d1; font-size: 13px; }

  .steps { counter-reset: step; }
  .step-card { position: relative; }
  .step-card .num { position: absolute; top: -14px; left: 24px; background: #3b6ef0; color: #fff; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; }
  .step-card .code { display: block; background: #0a0f24; border: 1px solid #1c2546; border-radius: 6px; padding: 10px 12px; font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; color: #9eecbe; margin-top: 12px; overflow-x: auto; white-space: nowrap; }

  .faq { max-width: 720px; margin: 0 auto; }
  details { background: #131a33; border: 1px solid #222a4a; border-radius: 8px; padding: 14px 18px; margin-bottom: 10px; }
  details summary { cursor: pointer; font-weight: 600; font-size: 14px; }
  details[open] summary { margin-bottom: 8px; }
  details p { margin: 0; color: #a9b3d1; font-size: 13px; }

  .cta-bottom { text-align: center; background: linear-gradient(135deg, #131a33, #1a2240); padding: 50px 24px; border-radius: 16px; border: 1px solid #2a3560; }
  .cta-bottom h2 { margin-bottom: 12px; }
  .cta-bottom p { color: #a9b3d1; margin-bottom: 24px; max-width: 500px; margin-left: auto; margin-right: auto; }

  footer { border-top: 1px solid #1c2546; padding: 24px; text-align: center; font-size: 12px; color: #8a96bd; }
</style>
</head><body>

<header>
  <div class="brand">
    fb.autonow.vn
    <small>FB Group Intelligence cho sale team</small>
  </div>
  <nav>
    <a href="/auth/login">Đăng nhập</a>
    <a class="cta" href="/auth/signup">Dùng thử miễn phí</a>
  </nav>
</header>

<main>

<div class="hero">
  <h1>Tìm khách hàng tiềm năng<br><span>trong các nhóm Facebook</span> — tự động</h1>
  <p class="sub">
    Hệ thống tự crawl bài viết từ các Facebook Groups bạn đã tham gia, dùng AI phân loại
    intent (hỏi giá, cần tư vấn, khiếu nại…), và quản lý pipeline sale 12 stage.
    Tất cả chạy trên VPS riêng — data của bạn không bao giờ rời khỏi server bạn kiểm soát.
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="/auth/signup">Đăng ký dùng thử →</a>
    <a class="btn btn-ghost" href="/auth/login">Đã có tài khoản</a>
  </div>
  <div class="hint">Miễn phí trong giai đoạn beta · Không cần thẻ tín dụng</div>
</div>

<section>
  <h2>Hoạt động như thế nào?</h2>
  <p class="lead">3 bước để bắt đầu — toàn bộ setup mất khoảng 10 phút.</p>
  <div class="grid-3 steps">
    <div class="card step-card">
      <div class="num">1</div>
      <div class="icon">📝</div>
      <h3>Đăng ký tài khoản</h3>
      <p>Tạo workspace bằng email + mật khẩu. Hệ thống cấp cho bạn một <code>license_key</code> để kết nối agent về cloud.</p>
    </div>
    <div class="card step-card">
      <div class="num">2</div>
      <div class="icon">🖥️</div>
      <h3>Cài agent trên VPS của bạn</h3>
      <p>Chạy 1 lệnh duy nhất. Agent sẽ tự động cài Chrome, Playwright và kết nối về fb.autonow.vn.</p>
      <code class="code">curl -fsSL https://fb.autonow.vn/install.sh \\<br>&nbsp;&nbsp;| LICENSE_KEY=lk_xxx bash</code>
    </div>
    <div class="card step-card">
      <div class="num">3</div>
      <div class="icon">🎯</div>
      <h3>Login FB 1 lần — xong</h3>
      <p>Mở noVNC từ dashboard, login Facebook 1 lần duy nhất. Hệ thống tự crawl 24/7, AI phân loại lead, bạn quản lý pipeline qua giao diện web.</p>
    </div>
  </div>
</section>

<section>
  <h2>Tính năng chính</h2>
  <p class="lead">Mọi thứ bạn cần để biến Facebook Groups thành kênh tìm khách hàng có thể đo lường.</p>
  <div class="grid-4">
    <div class="card">
      <div class="icon">🔍</div>
      <h3>Auto-crawl 24/7</h3>
      <p>Quét posts + comments mới mỗi 2 giờ từ tất cả groups bạn enable. Watermark-based — không bao giờ miss data.</p>
    </div>
    <div class="card">
      <div class="icon">🤖</div>
      <h3>AI phân loại lead</h3>
      <p>Gemini 2.5 Flash đọc tiếng Việt, phân loại 7 intent: hỏi giá, cần tư vấn, khiếu nại, khoe sản phẩm, seeding, spam, khác.</p>
    </div>
    <div class="card">
      <div class="icon">📊</div>
      <h3>Pipeline 12 stage</h3>
      <p>Theo dõi từng lead qua các stage: mới → liên hệ → báo giá → gửi mẫu → top-up 1 → first order → top-up 2 → ship → closed.</p>
    </div>
    <div class="card">
      <div class="icon">🔒</div>
      <h3>Self-hosted, data riêng</h3>
      <p>Agent chạy trên VPS của bạn. Cookie Facebook + post raw không bao giờ rời khỏi server bạn kiểm soát.</p>
    </div>
  </div>
</section>

<section>
  <h2>Câu hỏi thường gặp</h2>
  <div class="faq">
    <details>
      <summary>Tôi có cần VPS không? Cấu hình bao nhiêu?</summary>
      <p>Có. Khuyến nghị tối thiểu 4 CPU / 8GB RAM (vì cần Chrome headed). Ubuntu 22.04+. Chi phí ~$10-20/tháng tại các nhà cung cấp như Hetzner, Vultr, DigitalOcean.</p>
    </details>
    <details>
      <summary>Facebook có khóa account không?</summary>
      <p>Có rủi ro nếu dùng account chính. Khuyến nghị dùng account phụ đã tồn tại ≥3 tháng. Hệ thống đã built-in các best practice: persistent profile, mbasic-first, delay 10-25s giữa request, budget 3000 request/ngày.</p>
    </details>
    <details>
      <summary>AI phân loại có chính xác không?</summary>
      <p>Trên content tiếng Việt, Gemini 2.5 Flash đạt 90-95% confidence với các intent rõ ràng. Bạn có thể override classification thủ công trên dashboard, và hệ thống cache result để không gọi API lặp lại.</p>
    </details>
    <details>
      <summary>Chi phí AI API thế nào?</summary>
      <p>Bạn dùng Gemini API key của riêng mình (free tier 1500 request/ngày là đủ cho hầu hết use case). Nếu vượt: ước tính ~$1.50/tháng cho 1000 post/ngày được phân loại.</p>
    </details>
    <details>
      <summary>Đang beta — nghĩa là gì?</summary>
      <p>Hệ thống đang chạy production cho 1 user (tác giả). Đang mở dần cho beta tester. Agent installer Phase B sắp release — đăng ký để được ưu tiên invite.</p>
    </details>
  </div>
</section>

<section>
  <div class="cta-bottom">
    <h2>Sẵn sàng tìm lead trong FB Groups?</h2>
    <p>Đăng ký bây giờ để giữ chỗ. Khi agent installer sẵn sàng, bạn sẽ nhận email kèm lệnh cài đặt.</p>
    <a class="btn btn-primary" href="/auth/signup">Tạo tài khoản miễn phí →</a>
  </div>
</section>

</main>

<footer>
  © 2026 autonow.vn · <a href="mailto:support@autonow.vn">support@autonow.vn</a>
</footer>

</body></html>`;
}
