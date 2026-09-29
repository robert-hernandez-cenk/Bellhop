# Data Model: Prompt banner copy per detection origin

No stored data changes. The only new shape is the view the banner renders
from.

## PromptBannerView

Returned by `promptBannerView(origin, matchedIndex, expectedCount)`.

| Field | Type | Meaning |
| --- | --- | --- |
| `hint` | `string \| null` | Explanation line under the prompt text; `null` renders nothing. |
| `hintStrong` | `boolean` | `true` renders the hint with the full-contrast stall style. |
| `dismissLabel` | `string` | Label of the button that dismisses the pause. |
| `quiet` | `'answers' \| 'dismiss' \| null` | Which controls get the de-emphasised style: Yes/No/Submit, the dismiss button, or none. |

## Inputs

| Input | Source | Notes |
| --- | --- | --- |
| `origin` | `useJobStream().promptOrigin` (`PromptOrigin \| null`) | `null` is looked up as `'none'`. |
| `matchedIndex` | `useJobStream().promptMatchedIndex` (`number \| null`) | Used only by `expected`. |
| `expectedCount` | `useJobStream().expectedPrompts.length` | Numbering for `expected`; variant choice for `heuristic`. |

Exact values per origin: [contracts/banner-copy.md](contracts/banner-copy.md).
