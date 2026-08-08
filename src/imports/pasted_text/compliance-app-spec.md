Product summary
Design a web application for federal compliance agents who review alcohol beverage labels against their submitted applications. The agent uploads a label image (or a batch of them) alongside application data, and the tool flags matches, mismatches, and low-confidence fields for human review. This is an internal government compliance tool, not a public-facing consumer app — prioritize clarity and speed over visual flair.
Users (design for the least tech-comfortable persona, not the most)
* Compliance agents aged 28–65+, wide range of tech comfort. Assume some users are uncomfortable with anything unfamiliar — think "just learned to video call" as the baseline, not "power user."
* They process labels all day, every day. Repetitive-use tool: reduce clicks, avoid modals/popups that interrupt flow, no hidden menus or icon-only buttons without labels.
* High information density is fine as long as it's organized — these are professionals doing detailed comparison work, not casual browsing.
Core screens to design
1. Dashboard / Queue view
* A table/list of label applications: status (Pending / Needs Review / Approved / Flagged), brand name, submission date, agent assigned.
* Prominent primary action: "Upload Label(s)" — supports both single upload and batch upload of 200+ files in one action.
* Simple filter/sort controls (by status, by date, by flagged fields) — no advanced query builder.
* Batch upload should show a progress summary (e.g., "212 of 300 processed") rather than blocking the whole screen.
2. Single Label Review screen (the core screen — spend the most design effort here)
* Split-screen layout: label image on one side (zoomable/pannable), extracted + application data on the other.
* A field-by-field comparison table, one row per required field:
    * Brand Name
    * Class/Type Designation
    * Alcohol Content (ABV)
    * Net Contents
    * Name & Address of Bottler/Producer
    * Country of Origin (imports only)
    * Government Health Warning Statement
* Each row shows: Application value | Detected label value | Status (Match / Mismatch / Needs Review / Low Confidence).
* Status should NOT be strictly binary. Include a "minor variance — likely match" state (e.g., punctuation/case differences like "STONE'S THROW" vs "Stone's Throw") distinct from a hard mismatch, since agents need judgment, not just pass/fail.
* The Government Warning field needs a visually distinct, stricter check state: it must flag deviations in exact wording, capitalization (must be ALL CAPS + bold), and placement — treat this row as higher-stakes than the others in the visual hierarchy.
* Clear agent actions: Approve, Reject, Flag for Manual Review, with a required short comment field on Reject/Flag.
* Design an explicit low-quality image state: when the label photo has glare, bad angle, or poor lighting and fields can't be confidently extracted, show a clear "couldn't read this clearly" state per field (not a silent wrong guess) with an option to request a re-upload.
3. Batch Upload / Review screen
* Drag-and-drop or multi-file picker supporting 200–300 files at once.
* After processing, show a summary table: file name/thumbnail, auto-detected status, count of flagged fields — so an agent can triage at a glance which applications need attention vs. which can be quickly approved.
* Allow clicking any row to drop into the Single Label Review screen for that item.
4. Processing / loading state
* Design this explicitly: processing should read as fast (target ~5 seconds per label). Use a lightweight inline spinner or skeleton state, not a full-screen blocking loader — agents have been burned before by slow tools and abandoned them. Never suggest "AI thinking" delays longer than a few seconds in the design.
Visual style direction
* Clean, high-contrast, professional/government tool aesthetic — think trustworthy and calm, not flashy or "startup."
* Generous text size and spacing by default (assume some users may not be great with small UI). Avoid icon-only controls; pair icons with text labels.
* Use color deliberately and consistently for status: e.g., green = match, amber = minor variance/needs judgment, red = mismatch, gray = low confidence/unreadable. Don't rely on color alone — pair with text labels and icons for accessibility.
* Avoid dense jargon or technical language in the UI copy; agents are compliance experts, not technologists.
States to include in the file
* Empty state (no applications in queue yet)
* Loading/processing state (single and batch)
* Successful match state
* Mismatch state
* "Needs human judgment" / minor variance state
* Low-quality image / unreadable field state
* Error state (upload failed, unsupported file type)
* Batch upload progress state
Explicitly out of scope for this design
* No integration mockups with the legacy COLA system — this is a standalone prototype.
* No account/login/admin settings screens unless you want a minimal one for context — focus effort on the upload → review → decision flow.
Deliverable
Produce high-fidelity screens for the 4 core screens above plus the listed states, using a consistent design system (color tokens, type scale, spacing) applied throughout.