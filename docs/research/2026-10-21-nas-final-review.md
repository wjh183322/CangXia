# Final independent NAS release review

Candidate: `f0ccdeaa8bbd51b49cc98fe1ac0cd81aa00f8738`
Base: `008abb3ba2516052e185ed195921ec6e587b47eb`
Authority: approved cross-device deletion/recovery design and implementation plan dated 2026-10-20.

Verdict: **Changes required before release.** Three confirmed Important findings; no confirmed Critical or Minor findings. This is the single independent final review, with no product changes or further delegation.

## Important findings

### 1. [P1] Revalidate audio ownership even when the folder step is already complete

Location: `C:/Users/64689/Desktop/CangXia/electron/deletion-coordinator.mjs:30` (validation condition), consumed at line 51.

Trigger: delete local files for a work with permanent audio; the work folder is successfully trashed, but trashing the audio fails. Before retrying the incomplete operation, explicitly remove the old audio and save another version for that work. Retry the original operation.

Behavior: `dirDone` is already true, so `validate()` skips `directoryProof()` and its captured audio SHA/root/relative-path comparison. The remaining audio step calls `removeLocal()` against the current reference. An old confirmation therefore deletes the newly saved audio and reports success.

Evidence: reproduced using real `WorkAudio.saveLocal()` and `WorkAudio.removeLocal()`, real owned WAV files, a real Store/BackupClient, and a rename-based fixture trash adapter. The original SHA was `6f8ca56b0e8f8cb68e84940cb3b9081646555e11daa023a3ad7e9e09bc600c41`; the replacement SHA was `3140cb73a2dbe29b195ace0c0774e4ec52b36af682bc9a875ea68e3625174881`. Retrying removed the replacement and returned `phase:done`, `filesSucceeded:1`.

Spec impact: design section 7 requires confirming the original saved ownership/current state before each remaining local destructive step; changed ownership must stop the item. Validate the audio proof independently while `audioDone` is false, including on partial-operation retries.

### 2. [P1] Recheck receipted generations before each local item in a local-plus-NAS batch

Location: `C:/Users/64689/Desktop/CangXia/electron/deletion-coordinator.mjs:48`; the batch-only receipt check is at line 46.

Trigger: confirm local-plus-NAS deletion for at least two works. After the NAS batch succeeds and the first work begins its local step, the lease is lost/released and another computer restores the second work's files. The original client then reaches the second local item.

Behavior: `remoteBatch()` checks the generations once before the local loop. `localItem()` only performs another check for `followVersions`, which is empty for a directly initiated local-plus-NAS operation. It deletes the second local copy despite the newer restore, clears pending state, and reports the whole batch successful.

Evidence: reproduced with the existing isolated two-client fixture and real service APIs. During the first fixture trash callback B released its lease; A checked deletion state and explicitly restored work 2 through `DeletionConflicts.resolve()`. A returned `restored:1`, NAS work 2 had two media assets, but B then trashed work 2 and returned `phase:done`, `localSucceeded:2`, `failed:0`.

Spec impact: design sections 6.5 and 6.6 require a new delete/restore version to invalidate the old decision and prevent following obsolete deletion state. Carry the deletion receipt generations into the per-item guard, as already done for B's follow-delete path; require reconfirmation for changed items.

### 3. [P2] Clear the legacy account hiding field when explicitly restoring that source

Location: `C:/Users/64689/Desktop/CangXia/electron/nas-catalogue.mjs:51` (existing work body retained) and line 52 (only private masks cleared).

Trigger: a migrated profile contains `works.readHidden=true` plus its private account mask, while NAS still retains the account reading record. Explicitly restore that account record from the NAS catalogue.

Behavior: restoration retains the existing local work body, clears the private mask, and increments `restoredRecords`. However, `DeviceScopeState.visibleAccount()` at `electron/device-scope-state.mjs:45` also requires `!work.readHidden`. The work remains invisible after a reported successful restore. `Store.open()` at `electron/store.mjs:73` copies legacy hidden state into masks without clearing the original field, so this state is supported migration input.

Evidence: isolated fixture probe returned `restoredRecords:1`, `privateMask:false`, `readHidden:true`, and `hasRead:false` after account-source restoration.

Spec impact: sections 4 and 9 require explicit restoration to restore the selected local source while preserving legacy hidden choices until that action. Normalize the legacy account field only when restoring the account source; file-only or author-only restoration must keep account removal intact.

## Review evidence and limits

- Reviewed the frozen changed-file inventory and the service/client/UI boundary paths for scope validation, uploads, receipts, grant renewal, object reference protection, private masks, coordination, conflict choices, catalogue recovery, migration and retention.
- Executed `.superpowers/sdd/2026-10-20-nas-deletion-and-recovery/review-probes.mjs` successfully on Node 24.21.0. All three assertions confirm the undesired behaviors above. The script uses temporary fixtures, real isolated databases/service APIs and owned files; it never accesses a real NAS, user profile or Windows recycle bin. Only review artifacts were written in the repository.
- The parent's reported 594 Node / 165 UI / 76 desktop / 31 preview results and packaging checks were treated as existing candidate evidence, not rerun or represented as this review's independent measurements. These tests do not cover the three reproduced boundaries.
- Declined to judge real Zunyi/Chongqing machines, user data, actual NAS deployment, Windows recycle-bin behavior, final Linux image or published package integrity: these were outside this read-only review and require the separate release/device checks. No claim of real-machine acceptance is made.
- Other unproven concerns are not graded as findings. After the authorized fix pass, the parent should run focused regressions for these exact transitions and the applicable release gates; this report does not claim the corrected code has been reviewed or passed.

## Parent fix verification

All three findings retained as Important. Focused regressions reproduce all three failures before correction. The single fix pass adds an independent pending-audio identity check, fresh per-step NAS generation checks for initiating clients as well as follow-delete clients, and account-only normalization of the legacy hidden flag. Author-only recovery preserves account hiding. Legitimate partial audio retry remains covered. Full release validation follows on the corrected tree.
