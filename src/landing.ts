/**
 * Public marketing page for nextclaw (served to anonymous visitors at /).
 * Authenticated users get the dashboard instead.
 *
 * Design direction "The Catch": deep ink navy + a single vivid lime "signal"
 * accent for the one caught lead pulled out of the noise. Space Grotesk (display)
 * + Inter (body) + Space Mono (data). Self-contained inline CSS — no Tailwind dep.
 */

const BASE_URL = process.env.APP_PUBLIC_BASE_URL || 'https://nextclaw.vn';
const INSTALL_HOST = BASE_URL.replace(/^https?:\/\//, '');

export function renderLanding(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nextclaw — Catch buyers from Facebook groups, automatically</title>
<meta name="description" content="nextclaw reads the Facebook groups you've joined 24/7, scores every post with AI, and surfaces the people ready to buy — into a clean sales pipeline. Runs on your own server.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#0E1430; --ink-2:#131A3B; --ink-raise:#18204A;
    --text:#EAEDF7; --muted:#9AA3C7; --noise:#525a82;
    --signal:#C2F24A; --signal-ink:#0E1430; --mint:#7CE3C4;
    --line:#242C57; --line-soft:#1b224a;
    --display:'Space Grotesk',ui-sans-serif,system-ui,sans-serif;
    --body:'Inter',ui-sans-serif,system-ui,sans-serif;
    --mono:'Space Mono',ui-monospace,monospace;
    --wrap:1120px;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{font-family:var(--body);background:var(--ink);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased;
    background-image:radial-gradient(900px 500px at 78% -8%, rgba(194,242,74,.07), transparent 60%);}
  a{color:inherit;text-decoration:none;}
  ::selection{background:var(--signal);color:var(--signal-ink);}
  .wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px;}

  /* header */
  header{position:sticky;top:0;z-index:20;backdrop-filter:blur(10px);
    background:rgba(14,20,48,.72);border-bottom:1px solid var(--line-soft);}
  .hbar{display:flex;align-items:center;justify-content:space-between;height:64px;}
  .brand{display:flex;align-items:center;gap:9px;font-family:var(--display);font-weight:700;font-size:18px;letter-spacing:-.02em;}
  .brand .mark{color:var(--signal);font-size:19px;line-height:1;}
  nav.top{display:flex;align-items:center;gap:8px;}
  nav.top a{font-size:14px;color:var(--muted);padding:8px 12px;border-radius:8px;}
  nav.top a:hover{color:var(--text);}
  .btn{display:inline-flex;align-items:center;gap:8px;font-family:var(--body);font-weight:600;font-size:14px;
    padding:11px 18px;border-radius:10px;border:1px solid transparent;cursor:pointer;transition:transform .12s ease,background .15s,border-color .15s;}
  .btn:focus-visible{outline:2px solid var(--signal);outline-offset:2px;}
  .btn-go{background:var(--signal);color:var(--signal-ink);box-shadow:0 0 0 0 rgba(194,242,74,.5);}
  .btn-go:hover{transform:translateY(-1px);box-shadow:0 8px 30px -10px rgba(194,242,74,.55);}
  .btn-ghost{background:transparent;color:var(--text);border-color:var(--line);}
  .btn-ghost:hover{border-color:var(--noise);background:rgba(255,255,255,.02);}

  /* hero */
  .hero{display:grid;grid-template-columns:1.05fr .95fr;gap:48px;align-items:center;padding:84px 0 72px;}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;letter-spacing:.04em;
    color:var(--mint);border:1px solid var(--line);border-radius:999px;padding:5px 12px;margin-bottom:22px;}
  .eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--mint);box-shadow:0 0 10px var(--mint);}
  h1{font-family:var(--display);font-weight:700;font-size:clamp(34px,5vw,58px);line-height:1.04;letter-spacing:-.025em;margin:0 0 20px;}
  h1 .hit{color:var(--signal);position:relative;white-space:nowrap;}
  .sub{font-size:18px;color:var(--muted);max-width:520px;margin:0 0 30px;}
  .cta-row{display:flex;gap:12px;flex-wrap:wrap;}
  .hero .fineprint{margin-top:18px;font-family:var(--mono);font-size:12px;color:var(--noise);}

  /* signature: the catch */
  .stage{position:relative;background:linear-gradient(180deg,var(--ink-2),rgba(19,26,59,.4));
    border:1px solid var(--line);border-radius:18px;padding:20px;min-height:340px;overflow:hidden;}
  .stage .label{font-family:var(--mono);font-size:11px;color:var(--noise);display:flex;justify-content:space-between;margin-bottom:14px;}
  .feed{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
  .post{border:1px solid var(--line-soft);border-radius:11px;padding:11px 12px;background:rgba(255,255,255,.015);}
  .post .ln{height:7px;border-radius:4px;background:var(--noise);opacity:.5;margin:5px 0;}
  .post .ln.s{width:55%;} .post .ln.m{width:80%;}
  .post.caught{position:relative;border-color:var(--signal);background:rgba(194,242,74,.06);
    box-shadow:0 0 0 1px var(--signal),0 16px 50px -18px rgba(194,242,74,.5);transform:translateY(-2px);}
  .post.caught .ln{background:var(--signal);opacity:.85;}
  .post.caught .who{font-family:var(--body);font-weight:600;font-size:12px;color:var(--text);margin-bottom:2px;}
  .post.caught .score{position:absolute;top:-11px;right:10px;font-family:var(--mono);font-size:11px;font-weight:700;
    background:var(--signal);color:var(--signal-ink);padding:2px 8px;border-radius:999px;}
  /* claw brackets on the caught post */
  .post.caught::before,.post.caught::after{content:"";position:absolute;width:16px;height:16px;border:2px solid var(--signal);}
  .post.caught::before{left:-7px;top:-7px;border-right:0;border-bottom:0;border-radius:4px 0 0 0;}
  .post.caught::after{right:-7px;bottom:-7px;border-left:0;border-top:0;border-radius:0 0 4px 0;}
  .stage .readout{margin-top:16px;display:flex;align-items:center;justify-content:space-between;
    font-family:var(--mono);font-size:12px;color:var(--muted);border-top:1px dashed var(--line);padding-top:13px;}
  .stage .readout b{color:var(--signal);}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 1px var(--signal),0 16px 50px -18px rgba(194,242,74,.5);}
    50%{box-shadow:0 0 0 1px var(--signal),0 16px 60px -10px rgba(194,242,74,.85);}}
  .post.caught{animation:pulse 2.6s ease-in-out infinite;}

  /* sections */
  section{padding:64px 0;border-top:1px solid var(--line-soft);}
  .sec-head{max-width:640px;margin:0 0 40px;}
  .kicker{font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mint);margin:0 0 10px;}
  h2{font-family:var(--display);font-weight:700;font-size:clamp(26px,3.4vw,38px);letter-spacing:-.02em;margin:0 0 12px;}
  .sec-head p{color:var(--muted);font-size:16px;margin:0;}

  /* flow (real funnel, not decorative numbers) */
  .flow{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;}
  .step{background:var(--ink-2);border:1px solid var(--line);border-radius:16px;padding:24px;position:relative;}
  .step .tag{font-family:var(--mono);font-size:12px;color:var(--signal);margin-bottom:14px;display:flex;align-items:center;gap:8px;}
  .step .tag .i{width:24px;height:24px;border-radius:7px;border:1px solid var(--line);display:grid;place-items:center;color:var(--text);}
  .step h3{font-family:var(--display);font-size:18px;margin:0 0 8px;font-weight:600;}
  .step p{color:var(--muted);font-size:14px;margin:0;}
  .code{display:block;font-family:var(--mono);font-size:12px;color:var(--mint);background:#0a0f26;border:1px solid var(--line);
    border-radius:9px;padding:11px 12px;margin-top:14px;overflow-x:auto;white-space:nowrap;}

  /* features */
  .feats{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;}
  .feat{background:var(--ink-2);border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;gap:16px;}
  .feat .g{flex:0 0 auto;width:40px;height:40px;border-radius:11px;background:rgba(194,242,74,.1);border:1px solid var(--line);
    display:grid;place-items:center;color:var(--signal);font-family:var(--mono);font-weight:700;font-size:15px;}
  .feat h3{font-family:var(--display);font-size:16px;margin:0 0 6px;font-weight:600;}
  .feat p{color:var(--muted);font-size:14px;margin:0;}

  /* pricing */
  .tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;align-items:start;}
  .tier{background:var(--ink-2);border:1px solid var(--line);border-radius:18px;padding:26px;}
  .tier.feature{border-color:var(--signal);box-shadow:0 24px 70px -34px rgba(194,242,74,.5);}
  .tier .name{font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);}
  .tier .feature-flag{float:right;font-family:var(--mono);font-size:11px;color:var(--signal-ink);background:var(--signal);padding:2px 8px;border-radius:999px;}
  .tier .price{font-family:var(--display);font-size:38px;font-weight:700;margin:14px 0 2px;letter-spacing:-.02em;}
  .tier .price span{font-family:var(--mono);font-size:13px;font-weight:400;color:var(--noise);}
  .tier ul{list-style:none;padding:0;margin:18px 0 22px;}
  .tier li{font-size:14px;color:var(--muted);padding:7px 0 7px 24px;position:relative;border-top:1px solid var(--line-soft);}
  .tier li:first-child{border-top:0;}
  .tier li::before{content:"";position:absolute;left:2px;top:13px;width:9px;height:9px;border-radius:50%;
    background:rgba(194,242,74,.18);box-shadow:inset 0 0 0 2px var(--signal);}
  .tier .btn{width:100%;justify-content:center;}
  .pay-note{font-family:var(--mono);font-size:12px;color:var(--noise);text-align:center;margin-top:22px;}

  /* faq */
  .faq{max-width:760px;}
  details{border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:10px;background:var(--ink-2);}
  details[open]{border-color:var(--noise);}
  summary{cursor:pointer;font-family:var(--display);font-weight:600;font-size:15px;list-style:none;display:flex;justify-content:space-between;align-items:center;}
  summary::-webkit-details-marker{display:none;}
  summary::after{content:"+";font-family:var(--mono);color:var(--signal);font-size:18px;}
  details[open] summary::after{content:"\\2212";}
  details p{color:var(--muted);font-size:14px;margin:12px 0 0;}

  /* bottom cta */
  .endcta{text-align:center;background:linear-gradient(180deg,var(--ink-2),rgba(24,32,74,.5));
    border:1px solid var(--line);border-radius:22px;padding:56px 28px;}
  .endcta h2{margin-bottom:10px;}
  .endcta p{color:var(--muted);max-width:520px;margin:0 auto 26px;}

  footer{border-top:1px solid var(--line-soft);padding:30px 0;color:var(--noise);font-family:var(--mono);font-size:12px;}
  .foot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;}
  footer a:hover{color:var(--text);}

  @media (max-width:880px){
    .hero{grid-template-columns:1fr;padding:56px 0 48px;}
    .stage{order:2;}
    .flow,.feats,.tiers{grid-template-columns:1fr;}
  }
  @media (prefers-reduced-motion:reduce){.post.caught{animation:none;}.btn{transition:none;}}
</style>
</head><body>

<header><div class="wrap hbar">
  <a class="brand" href="/"><span class="mark">&#9670;</span>nextclaw</a>
  <nav class="top">
    <a href="#how">How it works</a>
    <a href="#pricing">Pricing</a>
    <a href="/auth/login">Log in</a>
    <a class="btn btn-go" href="/auth/signup">Get started</a>
  </nav>
</div></header>

<main class="wrap">

  <div class="hero">
    <div>
      <span class="eyebrow"><span class="dot"></span>Lead generation for Facebook groups</span>
      <h1>Your next customer is already posting.<br><span class="hit">We catch them.</span></h1>
      <p class="sub">nextclaw watches the Facebook groups you've joined around the clock, scores every post with AI, and pulls the people who are ready to buy into a clean sales pipeline — so you stop scrolling and start closing.</p>
      <div class="cta-row">
        <a class="btn btn-go" href="/auth/signup">Start catching leads &rarr;</a>
        <a class="btn btn-ghost" href="#how">See how it works</a>
      </div>
      <div class="fineprint">// runs on your own server &middot; your Facebook session never leaves it</div>
    </div>

    <div class="stage" aria-hidden="true">
      <div class="label"><span>group feed</span><span>scanning&hellip;</span></div>
      <div class="feed">
        <div class="post"><div class="ln m"></div><div class="ln s"></div></div>
        <div class="post"><div class="ln s"></div><div class="ln m"></div></div>
        <div class="post caught">
          <span class="score">94% buyer</span>
          <div class="who">Mai N. &middot; asking for a quote</div>
          <div class="ln m"></div><div class="ln s"></div>
        </div>
        <div class="post"><div class="ln m"></div><div class="ln s"></div></div>
        <div class="post"><div class="ln s"></div><div class="ln m"></div></div>
        <div class="post"><div class="ln m"></div><div class="ln s"></div></div>
      </div>
      <div class="readout"><span>1,000s of posts</span><span><b>1 caught</b> &rarr; pipeline</span></div>
    </div>
  </div>

  <section id="how">
    <div class="sec-head">
      <p class="kicker">Connect once, then it runs</p>
      <h2>From noisy feeds to a working pipeline</h2>
      <p>Three steps, about ten minutes. After that nextclaw does the watching for you.</p>
    </div>
    <div class="flow">
      <div class="step">
        <div class="tag"><span class="i">&#9670;</span>Connect</div>
        <h3>Create your workspace</h3>
        <p>Sign up and get a license key. It links the scraper agent on your server back to nextclaw.</p>
      </div>
      <div class="step">
        <div class="tag"><span class="i">&#8623;</span>Install</div>
        <h3>One command on your server</h3>
        <p>The agent installs everything it needs and logs into Facebook once, through a private browser only you can see.</p>
        <code class="code">curl -fsSL ${INSTALL_HOST}/install.sh \\<br>&nbsp;&nbsp;| sudo bash -s lk_&hellip;</code>
      </div>
      <div class="step">
        <div class="tag"><span class="i">&#9651;</span>Catch</div>
        <h3>Buyers land in your pipeline</h3>
        <p>nextclaw scores new posts 24/7, surfaces real buyers, pings your Telegram, and even drafts a reply for you to approve.</p>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head">
      <p class="kicker">What you get</p>
      <h2>Everything to turn groups into customers</h2>
    </div>
    <div class="feats">
      <div class="feat"><div class="g">24/7</div><div><h3>Always-on watching</h3><p>New posts and comments are pulled from every group you enable, on a schedule — nothing slips past while you sleep.</p></div></div>
      <div class="feat"><div class="g">AI</div><div><h3>Buyer scoring</h3><p>Each post is read and scored for buying intent, with a confidence percentage and a one-line reason — so you act on the right people first.</p></div></div>
      <div class="feat"><div class="g">&#8623;</div><div><h3>A real sales pipeline</h3><p>Every caught lead moves through stages from new to closed, with notes and history — built for following up, not just collecting.</p></div></div>
      <div class="feat"><div class="g">&#128274;</div><div><h3>Yours, on your server</h3><p>The agent runs on a server you control. Your Facebook session and the posts it reads stay with you — never on ours.</p></div></div>
    </div>
  </section>

  <section id="pricing">
    <div class="sec-head">
      <p class="kicker">Pricing</p>
      <h2>Simple plans, no surprises</h2>
      <p>Pick a plan and sign up. We'll confirm your payment and switch your account on by hand — usually within a few hours.</p>
    </div>
    <div class="tiers">
      <div class="tier">
        <div class="name">Starter</div>
        <div class="price">$19<span>/mo</span></div>
        <ul>
          <li>Up to 20 groups</li>
          <li>AI buyer scoring</li>
          <li>Sales pipeline + Telegram alerts</li>
          <li>Email support</li>
        </ul>
        <a class="btn btn-ghost" href="/auth/signup?plan=starter">Choose Starter</a>
      </div>
      <div class="tier feature">
        <span class="feature-flag">Most popular</span>
        <div class="name">Pro</div>
        <div class="price">$49<span>/mo</span></div>
        <ul>
          <li>Up to 100 groups</li>
          <li>Everything in Starter</li>
          <li>AI reply drafts for approval</li>
          <li>Custom lead rules &amp; topics</li>
          <li>Priority support</li>
        </ul>
        <a class="btn btn-go" href="/auth/signup?plan=pro">Choose Pro</a>
      </div>
      <div class="tier">
        <div class="name">Scale</div>
        <div class="price">Custom</div>
        <ul>
          <li>Unlimited groups</li>
          <li>Multiple Facebook accounts</li>
          <li>Your own AI key &amp; quotas</li>
          <li>Hands-on onboarding</li>
        </ul>
        <a class="btn btn-ghost" href="/auth/signup?plan=scale">Talk to us</a>
      </div>
    </div>
    <p class="pay-note">// you bring the server (~$5&ndash;10/mo) &middot; the agent runs there, not on ours</p>
  </section>

  <section>
    <div class="sec-head">
      <p class="kicker">Questions</p>
      <h2>Good to know</h2>
    </div>
    <div class="faq">
      <details><summary>Do I need my own server?</summary><p>Yes — a small VPS (about $5&ndash;10/month at providers like Hetzner, Vultr, or DigitalOcean). The scraper agent runs there so your Facebook session stays under your control. One command installs everything.</p></details>
      <details><summary>Will Facebook ban my account?</summary><p>There's always some risk with automation. We recommend a secondary account that's at least a few months old. nextclaw is conservative by default: a persistent browser profile, human-like delays between requests, and a daily request budget.</p></details>
      <details><summary>How accurate is the AI scoring?</summary><p>On clear posts it's strong, and every lead comes with a confidence score and a short reason so you can judge it yourself. You can correct any classification, and results are cached so the same post is never re-scored.</p></details>
      <details><summary>What does the AI cost?</summary><p>You can use your own AI key, whose free tier covers most use. Beyond that it's roughly a dollar or two a month for a thousand posts a day — small enough to ignore.</p></details>
      <details><summary>How do I get started?</summary><p>Sign up, pick a plan, and complete payment. We switch your account on, email you the one-line install command, and you're catching leads the same day.</p></details>
    </div>
  </section>

  <section>
    <div class="endcta">
      <h2>The buyers are already there.</h2>
      <p>Stop scrolling through group feeds hoping to spot them. Let nextclaw catch them for you.</p>
      <a class="btn btn-go" href="/auth/signup">Start catching leads &rarr;</a>
    </div>
  </section>

</main>

<footer><div class="wrap foot">
  <span>&copy; 2026 nextclaw</span>
  <span><a href="/auth/login">Log in</a> &middot; <a href="/auth/signup">Get started</a> &middot; <a href="mailto:support@${INSTALL_HOST}">support@${INSTALL_HOST}</a></span>
</div></footer>

</body></html>`;
}
