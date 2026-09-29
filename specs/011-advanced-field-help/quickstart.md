# Quickstart: verifying the Advanced modal field explanations

## Automated

```bash
npm run typecheck
npm test               # includes test/web-client/advanced-field-help.test.ts
npm run web:build
```

`advanced-field-help.test.ts` MUST confirm that:

- the map's keys equal the labels rendered by `AdvancedGuestModal.tsx`;
- every value has one or two sentences;
- the four required facts in spec FR-003 are present.

## Browser (desktop and ≤640px)

1. Run `npm run web:dev` against a worktree seeded with an inventory database, and
   open the Dashboard at `http://localhost:5173`.
2. Open **Advanced** on any guest.
3. **Desktop (e.g. 1280×800):**
   - Hover each ⓘ: the explanation appears under the row, and no other row moves.
     Moving the mouse away hides it.
   - Click an ⓘ: it stays open. Clicking another ⓘ swaps to that one. Clicking
     outside closes it.
   - Keyboard: Tab to an ⓘ. Enter opens it, Space closes it, Escape closes it with
     focus left on the button, and Tab away closes it.
4. **Mobile (375×812):**
   - Tap each ⓘ: the explanation is fully visible inside the modal, with no
     horizontal scroll.
   - Tap it again, or tap elsewhere, to close it.
   - The last row (`app`) is still readable.
5. Repeat one open/close in the dark theme.
6. For a guest in OIDC mode, confirm the `oidc client` row has its own ⓘ.
