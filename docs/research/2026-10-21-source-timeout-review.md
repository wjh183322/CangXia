# Independent bounded review: source verification timeout

Reviewed base `fa8d2704d3b8a111d1bb7950718e94898e5347a9` to head `48e41525c9bf2e072f9b22349823214435f58b8c` (0.3.39).

No confirmed important or critical findings in the scoped change.

The official error-marker rule remains work-URL-bound, visibility-filtered, and excluded from comment/recommendation containers. Login/challenge/network/frequency evidence precedes missing classification. The collector still checks the account binding and cookie fingerprint before and after verification, and checks cancellation before committing state. Cached work-document or matching detail evidence is discarded before accepting a result; retry closes the prior owned target first, disables cache, bypasses service workers, and shares the original abort deadline. A second cached result remains unknown. Static asset cache alone does not trigger a retry. Diagnostic callbacks are bounded and cannot change the classification result.

Verification performed independently:

- `node --test tests/source-page.test.mjs`: 45 passed, 0 failed.
- Four additional in-memory falsification fixtures: cached detail followed by fresh login returned login/unknown; caching again in the fresh target returned cache/unknown with exactly two navigations; static-script cache did not trigger a retry; a failed first-target close stopped verification without creating a second target. Each emitted exactly one diagnostic and removed the event listener. The fixture asserted there was no overlapping owned target at creation.
- Inspected the complete scoped code/test diff, SystemBrowser probe ownership, collector binding/cancellation checks, and source-state classifiers. No build, release, account login, real-user file access, or product-file edits were performed.

## Optional minor refinement

The outer diagnostic loses the fresh attempt's stage on timeout (`electron/work-page-probe.mjs:72,84-85`). Reproduction: emit a cached work-document response on navigation one; navigation two continuously evaluates to `{kind:'pending',workId:id,stage:'document-loading'}`; use `timeoutMs:60,pollMs:1`. Observed result stays correctly unknown/timeout, with one diagnostic, but its code is `fresh-retry` and its reason is the generic timeout rather than document-loading. The child uses the default no-op diagnostic, while the outer function retains its own pre-retry stage; the shared deadline can also abort the child through the outer signal. Propagating only the child's bounded stage metadata to the outer diagnostic would improve debugging. This does not weaken classification, cancellation, or the deadline and is not a release blocker.

The native 14-check result and public anonymous sample observations supplied with the review request were not rerun here; they are not treated as real user account acceptance.
