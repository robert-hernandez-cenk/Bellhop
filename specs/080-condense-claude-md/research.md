# Research: Condense CLAUDE.md

## R1. How nested CLAUDE.md files load

**Decision**: place subsystem guidance in `CLAUDE.md` files inside the source directories it describes.

**Rationale**: Claude Code reads every `CLAUDE.md` from the working directory up to the repository root when a session starts. A `CLAUDE.md` in a *subdirectory* is not loaded then. It loads the first time Claude reads a file in that directory's subtree. A file deep in the tree brings its ancestors' nested files with it. For example, reading `src/lib/proxy/drivers/caddy.ts` loads `src/lib/CLAUDE.md`, `src/lib/proxy/CLAUDE.md`, and `src/lib/proxy/drivers/CLAUDE.md`. Detail therefore arrives exactly when the code it describes is opened, and nobody has to follow a pointer.

**Consequence**: an ancestor file's content is paid for by every descendant read. So `src/lib/CLAUDE.md` holds only core-library material, and proxy detail sits one and two levels deeper. There is deliberately no `src/CLAUDE.md`, since it would load for every source file.

**Alternatives considered**:

- A `docs/architecture/` reference set with an index in the root file. It would be link-checked, but nothing loads it automatically, so it depends on Claude remembering to read it. Rejected by the operator.
- `@path` imports from the root file. These load eagerly at session start, which defeats the purpose.

## R2. Where a cross-cutting topic lives

**Decision**: each topic gets one primary home. Other affected directories carry a one-line pointer, such as "OIDC confirmation rule for guest edits: see `src/operations/CLAUDE.md`".

**Rule for choosing the home**: put it with the file that *implements* the behavior, not the file that triggers it. The `sync-authentik` bullet in the original is an example. Its tier raise/lower authorization lives in the Dashboard route, so it moves to `src/web/CLAUDE.md`. Its `commitGuestEdit` confirmation rule moves to `src/operations/CLAUDE.md`. Its Advanced-modal tab layout moves to `web-client/CLAUDE.md`. The Authentik reconcile itself stays in `src/commands/networking/CLAUDE.md`.

**Rules that apply everywhere stay in the root file** even when the original states them inside one subsystem's bullet:

- POSIX sh for guest commands, with its exceptions;
- the dry-run convention and its "live call during preview" list;
- `runRemote` as the only remote path;
- `saveInventory` as a full replace;
- secrets never leaving the store;
- web UI authorization rigor;
- recording single-operator assumptions;
- example data only.

## R3. Tightening rules

**Keep**:

- every rule, invariant, and edge-case behavior;
- every gotcha and the reason behind it (a "why" is what stops a regression);
- every file, function, type, setting key, env var, constant, and table name;
- quoted error or message text;
- live-verified external-API quirks;
- known limitations;
- single-operator assumptions.

**Drop**:

- **Rename history**, for example "renamed from `caddy: true` in issue #10" or "`CADDYFILE_PATH` is gone". One exception: keep a historical name when it still exists somewhere, such as a migration that reads the old column. In that case, say what the migration does.
- **Narrative of how something was found or tried**, such as "discovered live, debugging a real stuck job" or "an earlier draft tried...". The rationale such a story carries is kept; the story is not.
- **Repetition**: restating the same rule in several bullets, and "see above/below" chains.
- **Spec artifact references** like `research.md R4` and `FR-013`. Keep an issue number only where it is the shortest pointer to the design record.
- **Prose an identifier already carries**, for example "a function called `x` that does x".

**Style**: one heading per topic (`##`/`###`). Short paragraphs or bullets. Code identifiers in backticks. No hard-wrapped stream-of-consciousness sentences.

**Size target**: about 40–60% of the original byte count for each destination.

## R4. Code comments that cite "CLAUDE.md's X"

About fifteen source and test comments cite sections by name, for example "CLAUDE.md's 'sortInventoryForFile' precedent", "'Web UI authentication' section", "'Dry-run convention'", "'Project philosophy'", and "the Settings bullet".

**Decision**: leave code untouched (FR-009). Instead, keep each cited name findable as a heading or bold label in some `CLAUDE.md`, so that `grep -r` over `CLAUDE.md` files still resolves the citation.

The cited names to preserve:

- `sortInventoryForFile`
- Web UI authentication
- Dry-run convention
- Project philosophy
- Settings store/page
- the runRemote note
- the cluster note
- the `--storage` note
- phantom-success failure
- single-operator assumptions

## R5. What "CLAUDE.md" means in the constitution, CONTRIBUTING, and the PR template

**Decision**: from now on, "`CLAUDE.md`" refers to the root file together with the nested files.

- The root file says this in its first lines, and adds: "a convention or architecture change updates whichever of these files describes it".
- The bash-exception list stays in the root file, so constitution Principle II's wording stays literally true.
- No constitution amendment is needed. The text already treats `CLAUDE.md` as the runtime guidance and requires consistency, and this change preserves both.
- `CONTRIBUTING.md` line 155 ("a change to architecture or conventions updates `CLAUDE.md`") stays true under this reading. It gets "(the root file or the nested one for that directory)" so outside contributors know.

## R6. Verification without the full suite

**Decision**: verification has five parts.

1. Run `node --import tsx --test test/docs/links.test.ts` alone.
2. Compare line and byte counts before and after.
3. Check the topic-map coverage (every row in data-model.md has an existing destination heading).
4. For each destination, an independent reviewer subagent reads the original line range next to the new text and lists any dropped rule, then the findings are fixed.
5. Check that the citation names from R4 still resolve with grep.

The operator ruled out the full test suite for this documentation-only change.
