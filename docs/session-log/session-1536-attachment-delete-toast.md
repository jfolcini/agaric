# Session 1536 — One toast per delete

A batch-issues session run alongside a second agent in another container. Three of the four open PRs (#4739, #4745, #4752) had been pushed to within the previous ninety minutes, so the board was left to that agent; #4727 is a draft whose only red check is the picker flake #4749 already fixed on `main`, left for the next boundary. #4737 needs a product call (drop, move, or re-role the page shortcut inside a listbox option) and was not taken.

This PR closes #4626. `AttachmentList` fired "Deleted *name*" on the line after dispatching the delete, so a failed delete showed that toast next to the hook's "Failed to delete attachment". The success toast now lives in the one place that knows the delete landed: the success arm of `handleDeleteAttachment` in `useBlockAttachments`, which reads the filename from its own state before filtering the row out. The component only dispatches.

Verified: the hook test asserts exactly one success toast on success and none on either failure path; the component test pins the count at one, which is the bug. Shown red by removing the toast line from a copy of the hook (`toHaveBeenCalledTimes` expected 1, got 0), restored `cmp`-identical. Full vitest: 807 files, 18590 passed, 1 expected fail, 37 skipped. Typecheck clean.

Shipped: fix for #4626. Sibling session 1537 carries #4628 from the same run.
