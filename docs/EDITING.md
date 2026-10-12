# Shipyard 2.3.2 editing

The editor has seven clickable steps. Existing games can jump directly to any
step. New imports unlock steps as you advance. Continue moves exactly one step;
the final Save also checks all required listing and identity fields.

Edit listing opens directly at step 4. Name, descriptions, keywords, subtitle,
release notes, category, orientation, background, version, price, privacy,
icon, and screenshots can be edited. Review includes an Edit button beside
each group. The existing folder and App ID can be copied but remain fixed,
so an update stays connected to the same store record.

Replacing a game's source reads its current HTML title. Untouched old names
and references in the listing change to the new name. Your manually edited
fields are preserved. Slow repository responses cannot replace fields you
have already changed or send you to another step.

Artwork always comes from the current selection. Replacing source clears
the old icon selection and screenshot selection. The review banner uses the
current name, subtitle, color, and icon. Saving clears previous generated
previews; the next build recreates them. Selected PNGs save to both stores,
and removing all selections removes previous custom screenshots too.

## Drafts and saving

- Save draft writes to this browser only. Uploaded files, selected icons and
  screenshots, listing fields, privacy answers, and price are retained.
- Drafts also save after edits and closing the editor. Credentials are not
  included in draft records.
- Reopening a draft restores its editing step. A completed review reopens
  at Listing, so reopening never jumps directly to send.
- Save edits to GitHub without a build commits the changes without dispatching
  a workflow or uploading to a store.
- Save and build/send commits the same edits, then starts the selected workflow.

Drafts belong to a repository, branch, and game on this browser. Changing browser
or port creates a different browser storage area. A successful GitHub save
clears the corresponding local draft.

## Restart behavior

Start Shipyard.command stops older Shipyard Node servers and .command launchers
whose project folder is verified as Shipyard, before installing or building.
The current launcher and its ancestors are excluded. The script closes separate
Terminal windows matching old Shipyard TTYs. For a window with multiple tabs,
it exits the old Shipyard tab's shell; the Terminal profile determines whether
that cleanly exited tab automatically disappears. Other tabs remain open.

macOS may ask for Terminal automation permission the first time. If denied,
the old server still stops but its Terminal window may remain open. Windows
stops verifiable servers using absolute script paths; macOS window closing
does not apply there.

The browser opens only after the new server is listening. If another project
owns the normal port, Shipyard uses a free port instead of opening that project.
The version is shown in the panel and in the /__shipyard health response.

Validation here covers browser editing, draft restoration, actual PNG captures,
GitHub payloads, target selection for restarts, and occupied-port handling.
macOS Terminal automation and signed native store builds require testing on
their respective platforms.
