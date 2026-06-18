/**
 * Post a top-level comment on a FB post (lead) — used by AI-suggested reply
 * approval flow. Ported from autonow_local/internal/skills/fb_scripts/
 * comment_on_post.mjs. IMPORTANT: do NOT press Escape — that closes the
 * post modal dialog.
 */
import type { Page } from 'playwright';
import { openPage } from '../browser.js';
import { human, humanizedType, ensureLoggedIn, detectBlocked } from './_human.js';

export interface CommentOnPostArgs {
  post_url: string;       // permalink (https://www.facebook.com/groups/{gid}/permalink/{pid}/)
  content:  string;       // comment body
}

export interface CommentOnPostResult {
  status:     'commented' | 'submitted' | 'rate_limited' | 'post_unavailable' | 'comments_disabled' | 'failed';
  duration_ms: number;
  error?:     string;
}

export async function commentOnPost(args: CommentOnPostArgs): Promise<CommentOnPostResult> {
  const t0 = Date.now();
  // Strip comment_id from URL — if present, FB focuses on a reply box instead
  // of the top-level comment box.
  const cleanPostUrl = args.post_url
    .replace(/([?&])comment_id=[^&]*&?/, '$1')
    .replace(/[?&]$/, '');

  let page: Page;
  try {
    page = await openPage('crawl');
  } catch (e: any) {
    return { status: 'failed', duration_ms: Date.now() - t0, error: `open_page: ${e?.message ?? e}` };
  }

  try {
    await page.goto(cleanPostUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await human(3500, 5000);
    await ensureLoggedIn(page);
    // DO NOT press Escape — that would close the post modal dialog.

    // Wait for post dialog with top-level comment editor. Multiple locale variants.
    let editorReady = false;
    try {
      await page.waitForFunction(() => {
        const dlg = [...document.querySelectorAll('div[role=dialog]')]
          .find((d: any) => d.offsetParent !== null);
        if (!dlg) return false;
        return [...dlg.querySelectorAll('[contenteditable=true]')]
          .some((el) => {
            const a = el.getAttribute('aria-label') || '';
            return a.includes('Bình lu') || a.includes('Comment as')
                || a.includes('Trả lời dưới tên') || a.includes('Reply as');
          });
      }, null, { timeout: 15000 });
      editorReady = true;
    } catch {
      // No top-level editor → check if comments are disabled or post is gone.
      const state = await page.evaluate(() => {
        const dlg = [...document.querySelectorAll('div[role=dialog]')]
          .find((d: any) => d.offsetParent !== null);
        if (!dlg) return { has_dialog: false, comments_disabled: false };
        const txt = (dlg as HTMLElement).innerText || '';
        return {
          has_dialog: true,
          comments_disabled: /(tạm thời tắt tính năng bình luận|đã tắt tính năng bình luận|comments are turned off|comments are temporarily disabled|commenting is turned off)/i.test(txt),
        };
      });
      if (!state.has_dialog) {
        return { status: 'post_unavailable', duration_ms: Date.now() - t0 };
      }
      if (state.comments_disabled) {
        return { status: 'comments_disabled', duration_ms: Date.now() - t0 };
      }
      throw new Error('dialog_open: post dialog opened but comment editor did not appear');
    }
    if (!editorReady) throw new Error('dialog_open: editor not ready');

    // Find + click editor via JS handle (avoids Playwright Unicode selector quirks)
    const editorHandle = await page.evaluateHandle(() => {
      const dlg = [...document.querySelectorAll('div[role=dialog]')]
        .find((d: any) => d.offsetParent !== null);
      if (!dlg) return null;
      return [...dlg.querySelectorAll('[contenteditable=true]')]
        .find((el) => {
          const a = el.getAttribute('aria-label') || '';
          return a.includes('Bình lu') || a.includes('Comment as')
              || a.includes('Trả lời dưới tên') || a.includes('Reply as');
        });
    });
    const editorEl = editorHandle.asElement();
    if (!editorEl) throw new Error('dialog_open: comment editor not found in dialog');
    await editorEl.click();
    await human(700, 1300);

    await humanizedType(page, args.content);
    await human(800, 1500);

    // Submit by pressing Enter
    await page.keyboard.press('Enter');
    await human(2500, 4500);

    // Verify: comment text appears + check for rate-limit banner.
    const snippet = args.content.slice(0, 30);
    const post = await page.evaluate((s) => {
      const body = (document.body as HTMLElement).innerText || '';
      return { contains: body.includes(s), bodySample: body.slice(0, 8000) };
    }, snippet);

    if (detectBlocked(post.bodySample)) {
      return { status: 'rate_limited', duration_ms: Date.now() - t0 };
    }
    return {
      status: post.contains ? 'commented' : 'submitted',
      duration_ms: Date.now() - t0,
    };
  } catch (e: any) {
    return { status: 'failed', duration_ms: Date.now() - t0, error: e?.message ?? String(e) };
  } finally {
    await page.close().catch(() => {});
  }
}
