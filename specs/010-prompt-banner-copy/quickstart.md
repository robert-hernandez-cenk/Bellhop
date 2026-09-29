# Quickstart: verifying the prompt banner per origin

## Automated

```bash
npm run typecheck
npm test            # includes test/web-client/prompt-banner.test.ts
npm run web:build
```

## Browser

1. Start the dev server from the worktree: `npm run web:dev` (API on 3001, client on Vite's port).
2. **After** the server has started (startup marks its own `owner = 'web'` rows interrupted), insert five paused jobs into the worktree's `data/jobs.sqlite3` (a throwaway local file — never the deployment checkout's), each with `status = 'awaiting_input'`, `owner = 'web'`, `command = 'install-app'`, `category = 'provisioning'`, `target = 'demo-app'`, `args_json = '{}'`, `log_file` pointing at an empty file, a `prompt_text`, and:
   - `prompt_origin = 'expected'`, `prompt_matched_index = 0`, `expected_prompts_json = '["Enter the API token: ","Enable IPv6? "]'`
   - `prompt_origin = 'heuristic'`, same `expected_prompts_json`
   - `prompt_origin = 'heuristic'`, `expected_prompts_json = NULL`
   - `prompt_origin = 'stall'`
   - `prompt_origin = NULL`
3. Open `/jobs/<id>` for each at 1280px and at 390px, in light and dark theme.

## Expected

Each banner matches its row in [contracts/banner-copy.md](contracts/banner-copy.md):
the hint text, the dismiss label, and which buttons render as outline
("quiet") buttons. The `prompt_origin = NULL` row renders as `heuristic`
(the "no known prompts" variant), because the server reports a stored NULL
origin as `heuristic`. At 390px the controls stack vertically and nothing is
clipped. No banner shows "Not stuck — keep waiting".
