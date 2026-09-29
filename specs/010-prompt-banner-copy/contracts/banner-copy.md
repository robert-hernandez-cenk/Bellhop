# Contract: prompt banner copy and emphasis

The exact strings and emphasis for each detection origin. Tests assert these
verbatim.

| Origin | Hint | Hint style | Dismiss label | Quiet controls |
| --- | --- | --- | --- | --- |
| `expected`, position known and `expectedCount > 0` | `Question {matchedIndex + 1} of up to {expectedCount} — matches a known prompt in this app's install script.` | ordinary | `Ignore — keep waiting` | dismiss |
| `expected`, otherwise | `Matches a known prompt in this app's install script.` | ordinary | `Ignore — keep waiting` | dismiss |
| `heuristic`, `expectedCount > 0` | `Looks like a question, but it doesn't match any prompt in this app's install script — it may not be one.` | ordinary | `Not a question — keep waiting` | none |
| `heuristic`, `expectedCount === 0` | `Looks like a question, but there were no known prompts for this app to check it against — it may not be one.` | ordinary | `Not a question — keep waiting` | none |
| `stall` | `Output stopped for 5 minutes and this does not match any known prompt — it may not be a question at all. The line above is the last output received. Choose "Not a question — keep waiting" to keep waiting, or answer if it is in fact a prompt.` | strong | `Not a question — keep waiting` | answers (Yes, No, Submit) |
| no origin on the page (`null`; the server reports a stored NULL as `heuristic`) | none | — | `Not a question — keep waiting` | none |

Unchanged: the prompt text line, the Yes/No/free-text controls and their
labels, and what answering or dismissing sends to the server.
