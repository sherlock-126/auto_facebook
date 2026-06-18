/**
 * Post a composed message (+ optional images) into a Facebook group. Reuses
 * the agent's persistent Chrome profile (already logged in via noVNC).
 *
 * Ported from autonow_local/internal/skills/fb_scripts/post_to_group.mjs but
 * inlined into our TS agent — no CDP, no subprocess. Shares the same
 * BrowserContext as the crawler; serialized through the scheduler in-flight
 * mutex by the caller (commands.ts).
 */
import type { Page } from 'playwright';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openPage } from '../browser.js';
import { human, humanizedType, ensureLoggedIn, detectBlocked } from './_human.js';
import { log } from '../../log.js';

export interface PostToGroupArgs {
  group_url:   string;       // https://www.facebook.com/groups/{id}
  content:     string;       // body text
  image_urls?: string[];     // optional, downloaded then setInputFiles
}

export interface PostToGroupResult {
  status:     'posted' | 'pending_review' | 'rate_limited' | 'failed';
  group_name?: string | null;
  duration_ms: number;
  error?:     string;
}

/** Download a list of image URLs to /tmp/post-*.{ext}. Returns local paths. */
async function downloadImages(urls: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[1]?.toLowerCase() ?? 'jpg';
      const p = join(tmpdir(), `fb-post-${randomBytes(8).toString('hex')}.${ext}`);
      await fs.writeFile(p, buf);
      paths.push(p);
    } catch (e: any) {
      log('warn', `image download failed: ${url} — ${e?.message ?? e}`);
    }
  }
  return paths;
}

async function cleanupTempFiles(paths: string[]): Promise<void> {
  for (const p of paths) { await fs.unlink(p).catch(() => {}); }
}

export async function postToGroup(args: PostToGroupArgs): Promise<PostToGroupResult> {
  const t0 = Date.now();
  const tempImages = args.image_urls?.length ? await downloadImages(args.image_urls) : [];

  let page: Page;
  try {
    page = await openPage('crawl');
  } catch (e: any) {
    return { status: 'failed', duration_ms: Date.now() - t0, error: `open_page: ${e?.message ?? e}` };
  }

  try {
    await page.goto(args.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await human(2500, 4500);
    await ensureLoggedIn(page);

    await page.keyboard.press('Escape').catch(() => {});
    await human(300, 600);

    if (!/facebook\.com\/groups\//i.test(page.url())) {
      throw new Error('navigation: did not land on a group page');
    }

    const groupName = await page.evaluate(() => {
      const main = document.querySelector('div[role=main]') || document.body;
      const h1 = main.querySelector('h1');
      return h1 ? h1.textContent?.slice(0, 100) ?? null : null;
    });

    // 1) Click composer trigger ("Bạn viết gì..." / "Write something")
    const composer = page.locator('div[role=button]', {
      hasText: /Bạn viết gì|Write something|Create post|Tạo bài viết/i,
    }).first();
    try {
      await composer.click({ timeout: 8000 });
    } catch {
      throw new Error('composer_click: group composer trigger not found. Customer may not be a member or group restricts posting.');
    }

    // 2) Wait for composer dialog
    try {
      await page.waitForFunction(() => {
        return [...document.querySelectorAll('div[role=dialog]')]
          .some((d: any) => d.offsetParent !== null && d.querySelector('[contenteditable=true]'));
      }, null, { timeout: 10000 });
    } catch {
      throw new Error('dialog_open: composer dialog did not open within 10s');
    }

    const composerDialog = page.locator('div[role=dialog]')
      .filter({ has: page.locator('[contenteditable=true]') })
      .first();
    await human(1500, 2500);

    // 3) Optional: attach images
    if (tempImages.length > 0) {
      const fileInput = composerDialog.locator('input[type=file]').first();
      try {
        await fileInput.setInputFiles(tempImages);
      } catch (e: any) {
        throw new Error(`attach_files: ${e?.message ?? e}`);
      }
      try {
        await page.waitForFunction(
          (n) => {
            const dlgs = [...document.querySelectorAll('div[role=dialog]')]
              .filter((d: any) => d.offsetParent !== null && d.querySelector('[contenteditable=true]'));
            if (!dlgs.length) return false;
            return dlgs[0].querySelectorAll('img[src^="blob:"], img[src^="data:"]').length >= n;
          },
          tempImages.length,
          { timeout: 30000 },
        );
      } catch { /* not fatal — proceed even if previews didn't show */ }
      await human(2000, 3500);
    }

    // 4) Type caption
    if (args.content) {
      const editor = composerDialog.locator('[contenteditable=true]').first();
      await editor.click();
      await human(400, 800);
      await humanizedType(page, args.content);
      await human(1800, 3500);
    }

    // 5) Click Post button
    const postBtn = composerDialog.locator(
      '[role=button][aria-label="Đăng"], [role=button][aria-label="Post"]',
    ).first();
    try {
      await postBtn.click({ timeout: 5000 });
    } catch {
      throw new Error('post_click: Post button not clickable');
    }

    // 6) Wait for dialog to disappear (= success indicator)
    try {
      await page.waitForFunction(() => {
        return ![...document.querySelectorAll('div[role=dialog]')]
          .some((d: any) => d.offsetParent !== null && d.querySelector('[contenteditable=true]'));
      }, null, { timeout: 90000 });
    } catch {
      throw new Error('post_submit: composer dialog did not close within 90s');
    }

    await human(2000, 3500);

    // 7) Detect final state (posted / pending_review / rate_limited)
    const post = await page.evaluate(() => {
      const body = ((document.body as HTMLElement).innerText || '').slice(0, 8000);
      return {
        pending_review: /(đang chờ duyệt|pending review|chờ phê duyệt|sẽ được hiển thị sau khi quản trị viên|will be visible after a group admin)/i.test(body),
        bodySample: body,
      };
    });

    if (detectBlocked(post.bodySample)) {
      return { status: 'rate_limited', group_name: groupName, duration_ms: Date.now() - t0 };
    }
    return {
      status: post.pending_review ? 'pending_review' : 'posted',
      group_name: groupName,
      duration_ms: Date.now() - t0,
    };
  } catch (e: any) {
    return { status: 'failed', duration_ms: Date.now() - t0, error: e?.message ?? String(e) };
  } finally {
    await page.close().catch(() => {});
    await cleanupTempFiles(tempImages);
  }
}
