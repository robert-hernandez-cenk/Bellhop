# Contract: `FieldHelp` placement

`web-client/src/components/FieldHelp.tsx` gains one optional prop:

```ts
placement?: 'row' | 'anchored'   // default 'row'
```

## `'row'` (default)

Unchanged from issue #34:
- the popover's class is exactly `field-help-popover`
- no inline positioning style is set
- it is scrolled into view (`block: 'nearest'`) when it opens

Every existing caller (the Advanced modal) omits the prop and keeps this.

## `'anchored'`

- The popover's class is `field-help-popover field-help-popover-anchored`
  (`position: fixed; width: max-content`).
- While it is open, its `maxWidth`, `top` and `left` inline styles are set
  from `popoverMaxWidth`/`placePopover`
  ([data-model.md](../data-model.md)). They are set before first paint and
  again on window `scroll` (capture phase) and `resize`, at most once per
  animation frame. The listeners are removed on close and on unmount.
- `scrollIntoView` is never called.

## Both modes

Open/pin/close semantics, hover-out delay, Escape, outside-pointerdown,
blur-close and ARIA wiring are identical in both modes.

`AppUpdateBadge` passes `placement="anchored"`.
