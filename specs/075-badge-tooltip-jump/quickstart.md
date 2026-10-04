# Quickstart: verify the anchored badge explanation

## Automated

```bash
npm run typecheck
npm test               # includes test/web-client/popover-position.test.ts
npm run web:build
```

## Browser (demo instance, example data only)

1. `npm run web:build`, then start the demo:
   `PORT=3275 npm run demo` (any free port), and open `/update`.
2. Desktop (about 1280 px wide), in the dark theme and then the light theme:
   - Run this in the console before opening anything:
     `const s=document.scrollingElement; [s.scrollTop, s.scrollHeight, s.scrollWidth]`.
   - Hover over the ⓘ on jellyfin's "Update available" pill. The
     explanation appears just under the ⓘ and is only as wide as its text.
     Re-run the console line: all three values are unchanged.
   - Click to pin it, then scroll the page. It stays attached to the ⓘ.
   - Open the ⓘ on the rightmost card's badge. It stays inside the window,
     with no horizontal scrollbar.
   - Scroll so a badge sits near the bottom of the window, then open it. It
     flips above the ⓘ.
3. Mobile (≤640 px, for example 390×844): tap each badge's ⓘ. Each
   explanation stays at least 16 px from both screen edges, and the page
   doesn't scroll. Tapping elsewhere closes it.
4. Regression: open a guest's Advanced modal from the Dashboard. Field
   explanations still drop down across their row, and a bottom row's
   explanation on a short window still scrolls into view inside the modal.
