# dsh-slick details

## Paste a table → Excel

Pasting **tab-separated** content of at least **2 rows × 2 columns** turns it into a real `.xlsx` attachment in the draft, instead of dumping the raw text into the composer.

- Comma-separated CSV is **not** detected (tabs only).
- Anything smaller stays as normal text.
- The file is standard xlsx (ZIP + SpreadsheetML) and opens in Excel, Numbers or LibreOffice.

## Long text → txt

Plain text longer than the threshold (500 characters by default) is saved as a `.txt` attachment.

- Change the threshold in **Settings → Enhancement kit**.
- Set it to `0` to turn this off.

## Image annotation

Click a draft image thumbnail to open the annotation editor.

- Tools: pen, rectangle, circle, line, arrow, eraser
- Existing shapes can be selected, moved and resized
- Scroll wheel zooms the canvas
- Undo / redo / clear
- Saving produces a new image attachment (the original is untouched)

## Enter-to-steer

While the agent is running, pressing Enter:

- **On** (default): steers immediately
- **Off**: queues until the current turn ends

This is the same setting as *Settings → General → send behavior while busy*; changing one updates the other.

## Reasoning-effort slider

Replaces the model menu's "Reasoning effort" row with a draggable, continuous Codex-style slider.

- The slider widget itself comes from [`dsh-codex-effort-slider`](https://github.com/Microqian2th/dsh-codex-effort-slider); this plugin wires it to the model directory, keeps the official level list from opening, and hides the shipped teamwork switch while the slider is active.
- Turning "Reasoning effort as a slider" off restores the official row: clicking it opens the shipped level list.

## Agent teamwork

A ⚡ button on the model row:

- Blue = on, click to turn off
- Grey = off, click to turn on
- No confirmation dialog

While the slider mode is active, the shipped "Enable agent teamwork" switch row is hidden so the two do not duplicate.

## Settings

| Setting | Effect |
| --- | --- |
| Paste table → Excel | toggle |
| Long text → txt threshold | character count, 0 disables |
| Enter-to-steer | toggle (mirrors the general setting) |
| Reasoning effort as a slider | on: slider + ⚡; off: official UI |

"Reset to defaults" restores everything to the plugin's configured defaults.
