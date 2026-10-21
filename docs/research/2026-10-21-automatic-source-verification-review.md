# Final read-only review: bounded automatic work availability

Reviewed base `7126c5d9d8a079242faa89a0ceb5ec9ec53afa3b` to head `332d72d0a2bf899801ee682a0bbb5a5d7d3e37fe` on `codex/automatic-source-verification`.

## Strengths

The supplied privacy tuple is classified narrowly as current account inaccessibility, retaining its privacy reason. Page verification checks the bound work ID, official origin and authenticated cookie fingerprint before and after the probe. The probe uses an owned hidden target, a usable viewport, cache/service-worker bypass, media blocking and bounded cleanup. Existing download retirement preserves records and files, excludes NAS tasks, and restoration does not restart downloads.

## Confirmed findings

### [P1] Wait for matching detail requests before committing a missing DOM result

Location: `electron/work-page-probe.mjs:45` (request tracking at lines 22–28).

The missing decision checks `bodies.size` but not matching requests that have started or received headers and have not yet reached `Network.loadingFinished`. Two missing snapshots can therefore close the target and mark a valid work unavailable before its positive detail body can be read. A normal slow detail transfer can trigger this with the default 200 ms poll interval; the short poll reproduction simply makes it deterministic.

Reproduction: use the existing `probeFixture` shape; during `Page.navigate`, emit a matching `Network.responseReceived` with HTTP 200, delay its `Network.loadingFinished` by 100 ms, and return matching `kind:'missing'` snapshots from `Runtime.evaluate`. Arrange `Network.getResponseBody` to return status_code 0 and a matching detail with image URLs. Call `verifyWorkPage(id,{pollMs:2,timeoutMs:1000})`.

Observed: `state:'unavailable',kind:'missing'`; `positiveResponseFinished:false`; `Network.getResponseBody` was never called; the owned target was closed. Collector will persist this result and retire that work's Douyin task.

Fix: track matching detail requests from initiation through response/body completion and require the absence of in-flight or unread matching evidence before accepting DOM missing. Unresolved matching evidence at the deadline must remain unknown. Add delayed request/header/body regression cases.

### [P1] Preserve API access and transport failures as unknown evidence

Location: `electron/work-page-probe.mjs:22` through `electron/work-page-probe.mjs:28`.

The response listener silently discards matching HTTP failures, login/challenge/rate-limit business messages and loading failures. None of those conditions prevents the DOM path from subsequently accepting a stale missing view. This violates the approved conservative handling of login, frequency and network conditions, and bypasses Collector's existing page login/frequency handling.

Reproduction: retain matching `kind:'missing'` snapshots and separately emit each of these cases from the owned probe session during navigation: (1) matching HTTP 200 detail body with `status_code:0,status_msg:'请登录后观看',aweme_detail:null,filter_detail:{aweme_id:id,filter_reason:''}`; (2) matching detail HTTP 429 followed by loadingFinished; (3) matching detail HTTP 200 responseReceived followed by `Network.loadingFailed` / `net::ERR_CONNECTION_RESET`. Call `verifyWorkPage(id,{pollMs:2,timeoutMs:1000})`.

Observed: all three return `state:'unavailable',kind:'missing'`. None returns unknown/login/frequency/network, despite the contradictory access/transport evidence.

Fix: record matching detail HTTP/access/transport failures and give those states precedence over DOM missing. Return the appropriate bounded unknown kind so Collector can invoke its existing login or access-hold handling. Add these three deterministic regressions.

## Verification and limits

Ran `node --test tests/source-page.test.mjs`: 18 passed, 0 failed. Ran the deterministic inline Node reproductions above without modifying product files. Independently inspected the source-state changes, Collector binding and persistence paths, SystemBrowser ownership and browser API/session checks, probe event/body handling, DOM extraction, tests and download retirement. No real account, profile, device, files or NAS was accessed by this review. Parent is running broader validation; real official-origin synthetic browser checks are not live service acceptance.

Declined to judge: actual current Douyin DOM/site compatibility and real signed-in service behavior, because this review has no real-profile authorization/evidence and controlled pages cannot establish those properties. No additional scope was inferred.

Assessment: not ready to merge until the two false-unavailable paths are fixed and their regressions pass. No additional confirmed ownership, cancellation, privacy or retention findings in the bounded changes reviewed.

## Implementer disposition

Both P1 findings were reproduced by failing deterministic regression tests, then fixed in c2ac9e004122709bccb5a1874a54587461f62e63.

The probe now tracks matching detail requests from initiation through headers, loading completion and response-body parsing. In-flight or unread evidence blocks a missing DOM verdict; an unresolved request at the deadline remains unknown. Matching HTTP, login/challenge/rate-limit, transport, malformed or failed-business responses latch conservative unknown evidence. A matching positive detail can still establish availability, while stale DOM cannot overrule those failures.

Added regressions for delayed initiation/header/body completion, an unresolved request, and seven access/transport/invalid-response cases. The focused source verification suite passed 63 tests with no failures or skips. Actual isolated Chrome checks also passed a delayed positive response plus matching login, HTTP 429 and network failures, in addition to the original scenarios (14 checks total).

This is the single independent final review, followed by implementer fixes and regression checks; no additional independent review after the fixes is claimed. Full suite, native and packaged validation are recorded in the release verification record.

The implementer also added nested filter access-notice regressions after the initial fixes. The probe reuses the shared strict empty-response eligibility gate; nested login notices and unsupported access notices cannot be overruled by a stale missing DOM. Both regressions failed before the guard change and passed after it (a7c1741).
