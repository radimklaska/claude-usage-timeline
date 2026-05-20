// ==UserScript==
// @name         Claude Usage Timeline Overlay
// @namespace    https://klaska.net
// @version      1.0.3
// @description  Overlay a day timeline over Claude usage progress bars, from last reset to next reset
// @author       Radim Klaška
// @match        https://claude.ai/settings/usage*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/radimklaska/claude-usage-timeline/main/claude-usage-timeline.user.js
// @updateURL    https://raw.githubusercontent.com/radimklaska/claude-usage-timeline/main/claude-usage-timeline.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────

  /**
   * Parse the reset text shown next to each progress bar and return
   * { periodMs, nextReset: Date, lastReset: Date }
   * Returns null when the text cannot be parsed.
   *
   * sectionType disambiguates the "Resets in N hr M min" format, which the
   * page uses for both the 5h session bar and the 7d weekly bars.
   */
  function parseResetText(text, sectionType) {
    if (!text) return null;
    const now = new Date();

    // ── "Resets in N day(s) X hr Y min" (session / weekly when <7d left) ──
    const inMatch = text.match(
      /Resets in\s+(?:(\d+)\s*day(?:s)?)?\s*(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?/i
    );
    if (inMatch && (inMatch[1] || inMatch[2] || inMatch[3])) {
      const days = parseInt(inMatch[1] || '0', 10);
      const hrs  = parseInt(inMatch[2] || '0', 10);
      const mins = parseInt(inMatch[3] || '0', 10);
      const msLeft = (days * 86400 + hrs * 3600 + mins * 60) * 1000;
      const nextReset = new Date(now.getTime() + msLeft);
      const periodMs  = sectionType === 'weekly'
        ? 7 * 24 * 3600 * 1000
        : 5 * 3600 * 1000;
      const lastReset = new Date(nextReset.getTime() - periodMs);
      return { periodMs, nextReset, lastReset };
    }

    // ── "Resets Thu 7:00 AM" (weekly) ──────────────────────
    const weekdayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
    const wkMatch = text.match(
      /Resets\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i
    );
    if (wkMatch) {
      const targetDay = weekdayMap[wkMatch[1]];
      let hour   = parseInt(wkMatch[2], 10);
      const min  = parseInt(wkMatch[3], 10);
      const ampm = (wkMatch[4] || '').toUpperCase();
      if (ampm === 'PM' && hour !== 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour  = 0;

      // Find next occurrence of that weekday/time
      const next = new Date(now);
      next.setSeconds(0, 0);
      next.setHours(hour, min);
      const diff = (targetDay - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + (diff === 0 && next <= now ? 7 : diff));

      const periodMs  = 7 * 24 * 3600 * 1000; // 7 days
      const lastReset = new Date(next.getTime() - periodMs);
      return { periodMs, nextReset: next, lastReset };
    }

    // ── "Resets Jun 1" / "Resets Jun 15" (monthly) ─────────
    const monthMap = {
      Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
      Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
    };
    const moMatch = text.match(/Resets\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i);
    if (moMatch) {
      const month = monthMap[moMatch[1]];
      const day   = parseInt(moMatch[2], 10);
      let next = new Date(now.getFullYear(), month, day, 0, 0, 0, 0);
      if (next <= now) next = new Date(next.getFullYear() + 1, month, day, 0, 0, 0, 0);
      // Approximate: last reset was one month prior
      const lastReset = new Date(next);
      lastReset.setMonth(lastReset.getMonth() - 1);
      const periodMs = next.getTime() - lastReset.getTime();
      return { periodMs, nextReset: next, lastReset };
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────
  // Build the overlay for one progress bar
  // ─────────────────────────────────────────────────────────

  const MARKER_COLOR   = 'rgba(100, 120, 200, 0.55)';
  const TODAY_COLOR    = 'rgba(255, 80, 80, 0.9)';
  const LABEL_COLOR    = '#555';
  const TODAY_LABEL_COLOR = '#c00';
  const OVERLAY_ID_ATTR = 'data-timeline-overlay';

  function buildOverlay(pb, resetInfo) {
    const { periodMs, nextReset, lastReset } = resetInfo;
    const now       = new Date();
    const elapsed   = now.getTime() - lastReset.getTime();
    const totalDays = periodMs / (24 * 3600 * 1000);

    // Mount the overlay on the bar's parent rather than the bar itself —
    // the bar uses overflow:hidden to clip its fill, which also clips our
    // day labels above it.
    const host = pb.parentElement;
    if (!host) return;

    // Remove any prior overlay (either in the new host or, for upgrades
    // from earlier versions, inside the bar itself).
    host.querySelectorAll(':scope > [' + OVERLAY_ID_ATTR + ']').forEach(n => n.remove());
    pb.querySelectorAll('[' + OVERLAY_ID_ATTR + ']').forEach(n => n.remove());

    // Establish a positioning context on the host if it doesn't have one.
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }

    // Wrapper that overlays the bar exactly, sized from the bar's box.
    const overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_ID_ATTR, '1');
    overlay.style.cssText = [
      'position:absolute',
      `left:${pb.offsetLeft}px`,
      `top:${pb.offsetTop}px`,
      `width:${pb.offsetWidth}px`,
      `height:${pb.offsetHeight}px`,
      'pointer-events:none',
      'z-index:10',
      'overflow:visible',
    ].join(';');

    // Draw a tick + label for each day boundary (day 1 .. floor(totalDays))
    const wholeDays = Math.floor(totalDays);
    for (let d = 1; d <= wholeDays; d++) {
      const frac    = d / totalDays;
      const pct     = (frac * 100).toFixed(3);
      const isToday = (d * 24 * 3600 * 1000 > elapsed) &&
                      ((d - 1) * 24 * 3600 * 1000 <= elapsed);

      // Vertical tick line
      const tick = document.createElement('div');
      tick.style.cssText = [
        'position:absolute',
        `left:${pct}%`,
        'top:-6px',
        'bottom:-6px',
        `width:${isToday ? 2 : 1}px`,
        `background:${isToday ? TODAY_COLOR : MARKER_COLOR}`,
        'transform:translateX(-50%)',
      ].join(';');
      overlay.appendChild(tick);

      // Label above bar (day number)
      const label = document.createElement('div');
      label.textContent = 'd' + d;
      label.style.cssText = [
        'position:absolute',
        `left:${pct}%`,
        'bottom:calc(100% + 4px)',
        'transform:translateX(-50%)',
        'font-size:9px',
        'font-weight:600',
        'white-space:nowrap',
        'line-height:1',
        `color:${isToday ? TODAY_LABEL_COLOR : LABEL_COLOR}`,
        'font-family:monospace',
        'pointer-events:none',
      ].join(';');
      overlay.appendChild(label);
    }

    // Current-time indicator (red dot on the bar at elapsed %)
    const elapsedFrac = Math.min(1, elapsed / periodMs);
    const dot = document.createElement('div');
    dot.title = 'Now: ' + now.toLocaleString();
    dot.style.cssText = [
      'position:absolute',
      `left:${(elapsedFrac * 100).toFixed(3)}%`,
      'top:50%',
      'transform:translate(-50%,-50%)',
      'width:8px',
      'height:8px',
      'border-radius:50%',
      `background:${TODAY_COLOR}`,
      'box-shadow:0 0 0 2px white',
      'z-index:20',
    ].join(';');
    overlay.appendChild(dot);

    host.appendChild(overlay);
  }

  // ─────────────────────────────────────────────────────────
  // Find all progress bars with a reset time and apply
  // ─────────────────────────────────────────────────────────

  // The page uses the same "Resets in N hr M min" text for the 5h session
  // bar and the 7d weekly bars; disambiguate by the enclosing section's H3.
  function getSectionType(node) {
    const section = node.closest?.('section');
    if (!section) return null;
    const h3 = section.querySelector('h3');
    if (!h3) return null;
    const title = h3.textContent.trim().toLowerCase();
    if (title.includes('weekly')) return 'weekly';
    if (title.includes('usage credits')) return 'monthly';
    return 'session';
  }

  function findResetText(row) {
    // Reset text lives in different elements per section (span for session/
    // weekly, div for monthly credits), so walk text nodes instead of querying
    // a specific tag.
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (/^Resets /i.test(t)) return t;
    }
    return null;
  }

  function processAllBars() {
    const pbs = document.querySelectorAll('[role="progressbar"]');
    pbs.forEach((pb) => {
      // Walk up to the "row" element (3 levels for Claude's DOM)
      const row = pb.parentElement?.parentElement?.parentElement;
      if (!row) return;

      const resetText  = findResetText(row);
      const sectionTy  = getSectionType(pb);
      const info       = parseResetText(resetText, sectionTy);
      if (!info) return; // Skip bars with no parseable reset time

      buildOverlay(pb, info);
    });
  }

  // ─────────────────────────────────────────────────────────
  // Run on load + watch for DOM changes (React re-renders)
  // ─────────────────────────────────────────────────────────

  // Debounced runner — coalesces bursts of mutations into a single rAF tick
  // and ignores mutations our own overlay caused (otherwise the observer
  // would fire on every appendChild we make and lock the page).
  let scheduled = false;
  function scheduleProcess() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      processAllBars();
    });
  }

  function isOurMutation(mutation) {
    const target = mutation.target;
    if (target && target.nodeType === 1 &&
        (target.hasAttribute?.(OVERLAY_ID_ATTR) ||
         target.closest?.('[' + OVERLAY_ID_ATTR + ']'))) {
      return true;
    }
    for (const n of mutation.addedNodes) {
      if (n.nodeType === 1 && n.hasAttribute?.(OVERLAY_ID_ATTR)) return true;
    }
    for (const n of mutation.removedNodes) {
      if (n.nodeType === 1 && n.hasAttribute?.(OVERLAY_ID_ATTR)) return true;
    }
    return false;
  }

  function init() {
    processAllBars();

    // Re-run when the usage page updates its counters — but skip mutations
    // we made ourselves, and debounce to one run per animation frame.
    const observer = new MutationObserver((mutations) => {
      if (mutations.every(isOurMutation)) return;
      scheduleProcess();
    });
    const target = document.querySelector('main') || document.body;
    observer.observe(target, { childList: true, subtree: true });

    // Bar width changes on window resize — overlay is pixel-sized, so realign.
    window.addEventListener('resize', scheduleProcess);

    // Also refresh every 60 s so the "now" dot stays accurate
    setInterval(processAllBars, 60_000);
  }

  // Wait for the progress bars to appear (React app may load them async)
  if (document.querySelector('[role="progressbar"]')) {
    init();
  } else {
    const waitObserver = new MutationObserver(() => {
      if (document.querySelector('[role="progressbar"]')) {
        waitObserver.disconnect();
        init();
      }
    });
    waitObserver.observe(document.body, { childList: true, subtree: true });
  }
})();
