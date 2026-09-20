# Spine AI Generator

**English | [中文](README.md)**

A local tool that **splits a 2D illustration into parts, builds a skeleton, and exports a Spine project** — automatically.

Upload an image → a vision model figures out which parts exist and what covers what → pixel-level
cutout → bone hierarchy is inferred → one click exports the `.json` / `.atlas` / `.png` trio, plus a
`.spine` project you can open directly in the Spine editor.

<p align="center">
  <img src="docs/images/demo.gif" width="820" alt="Dashboard demo: assembled preview, bone hierarchy, idle animation playing">
</p>

---

## Contents

- [What this is](#what-this-is)
- [Results](#results)
- [Pipeline](#pipeline)
- [Minimal viable scope](#minimal-viable-scope)
- [Quick start](#quick-start)
- [Workflow](#workflow)
- [Output layout](#output-layout)
- [Tech stack](#tech-stack)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Documentation](#documentation)
- [Development](#development)

---

## What this is

Building a 2D game character with skeletal animation means manually splitting an illustration into
head, body, arms, accessories… then building bones, painting weights, and ordering draw calls in
Spine. It's repetitive and slow. This tool automates that stretch:

| Step | By hand | This tool |
|---|---|---|
| Split parts | Cut each one out in an image editor | Vision model lists parts + pixel-level segmentation |
| Build hierarchy | Reason out each parent/child by hand | Inferred from occlusion relationships |
| Place bones | Position manually, guess pivots | Pivots derived from part bboxes and pose |
| Build meshes | Draw edges and paint weights along seams | Grid triangulation + annulus stitching, shared seam weights |
| Fill occlusions | Clone-stamp what's hidden | Image model infers the covered regions |
| Export | Configure each skeleton/atlas | One click, multiple target formats |

**This is not "one-click finished animation."** What it produces is **a clean, editable starting
point**: parts separated, hierarchy built, weights painted. An artist picks up from there to tune
meshes and keyframes rather than starting from a blank project.

> Quality depends on the source art. Character illustrations with clear part boundaries and
> unambiguous occlusion work best. Heavily interleaved parts, or lots of semi-transparency,
> will need manual cleanup.

---

## Results

These are real outputs — nothing retouched. The source is `test_assets/12.png` from this repo:

<table>
<tr>
<td width="33%"><img src="docs/images/step-1-source.png" alt="Source"></td>
<td width="33%"><img src="docs/images/step-2-parts.png" alt="Cut-out parts"></td>
<td width="33%"><img src="docs/images/step-3-assembled.png" alt="Reassembled"></td>
</tr>
<tr>
<td align="center"><b>① Input</b><br><sub>one complete illustration</sub></td>
<td align="center"><b>② Parts, automatic</b><br><sub>basket_back / handle / watermelon<br>tomato / corn / basket_front</sub></td>
<td align="center"><b>③ Placed back by bbox</b><br><sub>parts + position + order → the original</sub></td>
</tr>
</table>

Step ③ is the real check: **the cut-out parts drop back into place seamlessly**, which means the
segmentation got both position and size right. Swap "follow the bbox" for "follow the bone" and you
have animation — that's what's playing in the GIF at the top.

<table>
<tr>
<td width="50%"><img src="docs/images/step-2-parts.png" alt="Parts"></td>
<td width="50%">
<b>Parts are isolated and complete</b>

Each carries its own alpha channel; pixels outside its boundary are cleared.
Regions hidden by a part in front are reconstructed by an image model,
so a part looks solid even on its own.

<b>Hierarchy comes from occlusion</b>

`basket_front` covers `tomato`, which covers `basket_back`. That ordering
is the draw order in Spine (slot order) and the main evidence for the
bone parent/child relationships.

<b>Seams share weights</b>

Adjacent parts are built as skinned meshes: vertices on both sides of a
seam carry the same bone weights, so rotation pulls them together instead
of tearing the seam open.
</td>
</tr>
</table>

---

## Pipeline

From one PNG to a Spine project, these are the stages:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ① Input                                                                  │
│     Illustration PNG (with alpha)                                         │
│     ↓ read dimensions, establish the global coordinate system             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ② Vision understanding (Claude vision model)                             │
│     Whole image + prompt go to the model. It answers:                     │
│       · which parts exist (names, semantics)                              │
│       · each part's bbox in pixels         ← coarse localisation          │
│       · each part's pivot                  ← where the joint is           │
│       · each part's parent                 ← inferred from occlusion      │
│       · each part's depth                  ← what covers what             │
│       · each part's polygon outline (opt.) ← fine localisation            │
│     ↓ yields parts[] — a part table with hierarchy                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
┌───────────────────────────────┐   ┌───────────────────────────────────────┐
│  ③a Pixel segmentation (SAM)   │   │  ③b Polygon outlines (fallback)       │
│     Optional, needs ~800MB     │   │     Uses the polygons from ②          │
│     Feed bboxes to MobileSAM   │   │     Zero extra dependencies           │
│     as prompts, get exact      │   │     Slightly coarser edges, but       │
│     per-part pixel masks       │   │     runs on plain Node                │
│       ↓                        │   │       ↓                               │
│   Exclusive mask ownership:    │   │                                       │
│     overlapping pixels go to   │   │                                       │
│     the highest depth          │   │                                       │
│     (covered parts don't grab  │   │                                       │
│      foreground)               │   │                                       │
│       ↓                        │   │                                       │
│   Clamp masks to their own box:│   │                                       │
│     stops a small accessory    │   │                                       │
│     (glasses) from spilling    │   │                                       │
│     over a big part (the face) │   │                                       │
│       ↓                        │   │                                       │
│   Claim orphan pixels by       │   │                                       │
│     connectivity: content no   │   │                                       │
│     mask covered goes to the   │   │                                       │
│     smallest box (accessories) │   │                                       │
└───────────────────────────────┘   └───────────────────────────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  ④ Cutout (sharp)                                                         │
│     · Mask out each part, write <part>.png (with alpha)                   │
│     · Write <part>.erased.png — the real pixels this part occludes        │
│       (ground truth for inpainting)                                       │
│     · Write <part>.front.png  — where this part is in front of others     │
│     · Background removal + edge cleanup                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ⑤ Occlusion inpainting (image model, optional)                           │
│     Where a part is covered by one in front, the cutout has a hole.       │
│     Left alone, rotating that part reveals a gap.                         │
│       · Input: the part's cutout + context (the matching region of        │
│         the original)                                                     │
│       · Output: the covered content, written back into the cutout         │
│       · Against double-imaging: the covered region is pasted from         │
│         .erased.png ground truth, not redrawn by the model — otherwise    │
│         the model just paints the occluder again                          │
│     ↓ inpainted cutouts written back to _temp/Image/                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ⑥ Base plate and hole guards                                             │
│     · _base_plate: a full-image layer catching seams between parts        │
│     · Fill guards: near-white / near-black or mid-dark fills are judged   │
│       as failed inpainting and replaced with neighbouring real pixels     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ⑦ Mesh triangulation                                                     │
│     For each part with a parent:                                          │
│       · Grid triangulation — uniformly sampled triangle mesh              │
│       · Annulus stitching — vertices on both sides of a seam share        │
│         weights so rotation doesn't tear it                              │
│       · Max 4 bone influences per vertex (Spine's limit)                  │
│     Root parts stay as plain regions (no weights)                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ⑧ Skeleton generation (generateSkeleton)                                 │
│     · Bones in topological order (parents first); each bone's x/y is an   │
│       offset relative to its parent                                       │
│     · Synthetic root: every top-level part hangs off one synthetic root   │
│       — the Spine editor requires a single root bone and rejects the      │
│       whole file otherwise                                               │
│     · Slots = draw order: sorted by depth, not by bone order              │
│     · pivot → bone origin, so parts rotate around their pivot             │
│     · Pixel space → Spine space: origin centred, Y flipped                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ⑨ Animation (generateAnimations)                                         │
│     · idle: gentle vertical bob (root translate) + small per-part         │
│       rotation with staggered phases                                      │
│       Amplitude under 1.5° — assembled cutouts expose seams if they        │
│       rotate much more than that                                          │
│     · Rotation key name is version-dependent: angle on 3.8, value on 4.0+ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ⑩ Export (exportToSpine)                                                 │
│     · Skeleton JSON normalised: weights inlined into the vertices stream  │
│       instead of parallel arrays                                          │
│     · Atlas packing: all cutouts into one .png + .atlas                   │
│     · Target adaptation: Cocos 3.8 / Unity / Spine 4.0–4.2                │
│     · .spine project: generated via the Spine editor CLI (private binary  │
│       format, cannot be hand-authored)                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│  ⑪ Write artifacts                                                        │
│     See "Output layout". Trio for the engine, .spine for the editor,      │
│     intermediates kept in _temp                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### What each stage is actually solving

| Stage | Problem it solves | If you skipped it |
|---|---|---|
| ② Vision | Which parts exist, what covers what | No idea how many pieces to cut |
| ③ Segmentation | Exact pixel boundary per part | Cutouts overlap; parts interpenetrate when rotated |
| ④ Cutout | Get the pixels into separate files | Nothing to work with |
| ⑤ Inpainting | Covered regions are empty | Rotating a part reveals a hole |
| ⑥ Guards | Unfillable seams, failed fills | Black patches / white specks |
| ⑦ Mesh | How to share weights across seams | Seams tear |
| ⑧ Skeleton | Hierarchy, pivots, draw order | Everything breaks once it moves |
| ⑨ Animation | Some default motion to look at | Empty skeleton |
| ⑩ Export | A format the engine can load | Can't get it into a project |

---

## Minimal viable scope

**The core pipeline needs only Node plus an API key.** Everything else is optional:

| Feature | Requires | Without it |
|---|---|---|
| AI part analysis | **Required**: a vision model API key | The tool can't work |
| Cutout / assembly / skeleton / export | **Required**: Node 20+ | The tool can't work |
| Pixel-level segmentation | Optional: MobileSAM (~800MB) | Falls back to polygon masks — coarser edges, still works |
| Occlusion inpainting | Optional: an image generation model | Covered regions stay transparent; parts look holed in isolation |
| `.spine` project | Optional: Spine 4.x installed locally | The trio still exports, you just lose the editable project |

In other words: **`npm install` plus an API key gets you the export trio.** Install the other three
as needed — any one of them missing only affects that one artifact, never the whole pipeline.

---

## Quick start

```bash
# 1. Dependencies
npm install

# 2. Configure the API (either way)
cp .env.example .env
#   then edit .env and set ANTHROPIC_API_KEY
#   using a self-hosted gateway or relay? also set ANTHROPIC_BASE_URL
#   alternatively skip .env entirely and fill the form in the web UI

# 3. Run
npm run web
# → http://localhost:3000
```

No Python environment and no Spine editor needed to produce a usable project.

**Optional extras:**

```bash
# Pixel-level segmentation: creates a venv and pulls weights (~800MB, one-time)
npm run sam:setup && npm run sam:check

# .spine project: just install Spine 4.x; common locations are found automatically.
# Installed elsewhere? set SPINE_CLI_PATH
```

---

## Workflow

| # | In the UI | Under the hood |
|---|---|---|
| 1 | Upload an illustration PNG | Dimensions read, pixel coordinate system established |
| 2 | Write a prompt describing part structure and pivots | Prompt quality drives part-table quality — [see below](#writing-the-prompt) |
| 3 | Pick a target (Cocos 3.8 / Unity / Spine 4.x) | Determines skeleton version and skins shape |
| 4 | Click Generate | Runs stages ②–⑧; the log panel streams live |
| 5 | Check the assembled preview, play the idle animation | Seams or colour artefacts show up immediately |
| 6 | Click Export | Runs stages ⑩–⑪, producing the trio plus `.spine` |

### Writing the prompt

Four built-in templates (character / prop / effect / item), editable via the **Settings** button
next to "2. 提示词". They live in `config/prompt-templates.json`.

The key is **describing structure and pivots**, not describing the picture:

```
✅ Good
   A female character, left hand on hip, right hand holding scissors.
   Parts: head, hair bun, glasses, body, apron, left arm, right arm
   (including scissors), shoes.
   Head rotates around the neck; arms rotate around the shoulders;
   apron rotates around the waist.
   Draw order: body → apron → arms → head → hair bun → glasses.

❌ Bad
   An angry woman
   (no parts, no hierarchy, no pivots)
```

---

## Output layout

```
output/<project name>/
│
├── <source name>_temp/                 ← intermediates; kept for re-inpainting
│   └── Image/
│       ├── <part>.png                  cutout
│       ├── <part>.erased.png           real pixels of the occluded region (inpaint ground truth)
│       ├── <part>.front.png            where this part is in front of others
│       └── verify-input.json           input snapshot for verification
│
└── <source name>/
    ├── Spine工程/
    │   └── <source name>.spine         ← opens directly in the Spine editor
    │
    └── <target>/                       cocos-3.8 / unity / spine-4.2 ...
        └── <source name>/
            ├── <source name>.json      skeleton
            ├── <source name>.atlas     atlas descriptor
            ├── <source name>.png       atlas page
            ├── images/                 loose parts (for mesh editing back in the editor)
            └── README.txt              parameters and results of this export
```

**Why intermediates live in `_temp/`**: re-inpainting and re-cutting read from there. Clearing it on
export would mean re-running the expensive AI stages. Each export target gets its own directory
because 3.8 and 4.x skeleton/atlas formats are mutually incompatible — flattened together they'd
overwrite each other. Re-exporting Cocos leaves Unity untouched.

---

## Tech stack

| Layer | What | Why |
|---|---|---|
| Runtime | **Node.js 20+** (ESM) | No build step anywhere; edit and run |
| Web server | **Express** + SSE | SSE streams the log; pipeline progress is visible live |
| Image processing | **sharp** | Native libvips; cutting, compositing, assembly all in milliseconds |
| Vision | **Claude vision model** | Needs structured JSON (a part table), not a description of the picture |
| Inpainting | **Image generation model** (optional) | Reconstructs occluded regions |
| Segmentation | **MobileSAM** (optional, Python) | Bboxes as prompts for exact masks |
| Editor integration | **Spine CLI** (optional) | `.spine` is a private binary format only the official CLI can write |
| Browser tests | **Playwright** (dev) | UI regression |
| Frontend | Plain JS, no framework | Single-page tool; a framework would be overhead |

### A few deliberate trade-offs

**Why keep a polygon fallback instead of making SAM mandatory**: SAM needs an 800MB Python
environment, and plenty of people just want to see whether this works at all. The fallback uses the
polygons the vision model already returns — slightly coarser, zero dependencies — so you can run the
whole pipeline before deciding whether to install anything.

**Why `.spine` isn't generated in-house**: it's Spine's private binary project format (raw-deflate
wrapping a token stream) with no public spec, and it changes between 4.x patch versions. A
reverse-engineered writer would silently corrupt on an editor upgrade — worse than not producing it.
So it goes through the officially supported CLI.

**Why SSE rather than WebSocket**: logs are one-directional. SSE is sufficient, reconnects on its
own, and saves a handshake layer.

---

## Configuration

Everything lives in `.env` (see `.env.example`; gitignored).

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | API key, required (can also be set in the UI) |
| `ANTHROPIC_BASE_URL` | empty | Empty = direct to Anthropic. Set it for a self-hosted gateway or relay |
| `PORT` | `3000` | Listen port |
| `OUTPUT_DIR` | `./output` | Artifact root |
| `SPINE_CLI_PATH` | auto-detected | Spine editor executable |
| `SPINE_SAM_HOME` | `~/.spine-tool/mobilesam` | MobileSAM environment location |

**Changing the API endpoint**: edit `config/api-defaults.json` — the UI form reads its defaults from
there, so there's no hunting through code. Values in `.env` take precedence and are machine-local.

---

## FAQ

**Does it need network access?**
Analysis, inpainting, and segmentation call models, so yes. Cutting, assembly, skeleton generation,
and export are entirely local.

**Can I use it without installing MobileSAM?**
Yes. It falls back to polygon masks — coarser edges, complete pipeline. Worth a run before you
decide whether to install SAM.

**Parts came out broken, or there are black patches / white specks.**
Check the log panel for inpainting failures first; **Retry inpainting** re-runs only the failed ones.
The fill guards classify near-white, near-black, and mid-dark fills as failed and substitute
neighbouring real pixels.

**Skeleton is missing parts, or the hierarchy is wrong.**
Almost always the prompt. Go back to step 2 and state the part list, hierarchy, and pivots
explicitly, then regenerate. You can edit the templates in the UI directly.

**Can Spine open the export directly?**
The `.json` is **imported** into Spine (new project, then import). The `.spine` is **opened**. Both
are in the export directory; `.spine` sits under `Spine工程/`.

**Which input formats?**
PNG / JPG / WebP. Use PNG if you need transparency.

**Why is there a `_base_plate` part?**
It's a full-image backing layer that covers hairline seams between parts. Don't want it? Ask for no
base plate in the prompt, or delete it after generation.

---

## Documentation

| Document | Contents |
|---|---|
| [Web service usage](docs/guides/web-service.md) | UI walkthrough, prompt tips, environment variables |
| [Background removal & inpainting](docs/guides/background-removal.md) | Full technical detail and pitfalls of the inpainting pipeline |
| [Depth-based erasure](docs/notes/depth-based-erasure.md) | Why parts are assigned by depth |
| [MobileSAM feasibility](docs/notes/mobilesam-feasibility.md) | Why MobileSAM, measured data, prompt strategy comparison |

> These are written in Chinese — they're investigation records from development. `docs/notes/`
> documents how a specific problem was diagnosed and measured; if you want to know why some design
> decision was made, the measurements are usually in there.

---

## Development

```bash
npm install              # install

npm run web              # start the server
npm test                 # unit tests
npm run test:e2e         # end-to-end (really calls the API; slow)
npm run test:shot        # UI screenshot regression
npm run verify           # validate artifact structure
npm run shot             # capture preview screenshots
npm run check            # environment self-check
npm run sam:check        # MobileSAM environment status
```

### Layout

```
server/
├── index.js             HTTP routes + SSE log stream
├── generate-cli.js      CLI entry point
├── ai/
│   ├── claude.js        Vision: image → part table
│   ├── models.js        Text/vision model list
│   ├── image-models.js  Image generation model list
│   └── api-defaults.js  Endpoint defaults (reads config/api-defaults.json)
├── api/
│   ├── cutter.js        Cutout: masks → isolated PNGs
│   ├── isolate.js       Part isolation: overlap ownership, orphan claiming
│   ├── mesh.js          Grid triangulation + annulus stitching
│   ├── generator.js     Skeleton and animation generation
│   ├── targets.js       Target adaptation (3.8 vs 4.x shape differences)
│   ├── atlas.js         Atlas packing
│   ├── spine-project.js Spine CLI interaction, writes .spine
│   ├── inpaint.js       Occlusion inpainting
│   ├── background.js    Background removal
│   ├── baseplate.js     Base plate
│   ├── workspace.js     Directory layout (single source of truth)
│   └── env-file.js      .env read/write
└── sam/                 MobileSAM integration (optional)
    ├── client.mjs       Long-lived process client
    ├── worker.py        Python worker
    └── setup.mjs        One-command environment setup

web/                     Frontend (plain JS, no framework)
src/                     Standalone Spine read/write library (JSON/binary parsing, round-trip, validation)
scripts/                 Utility scripts
docs/                    Documentation and images
config/                  prompt-templates.json, api-defaults.json
temp/test/               Tests
```

### Tests

```bash
npm test                 # fast, no network
npm run test:e2e         # slow, really calls the API, validates the full chain
```

The Spine read/write library under `src/` is usable standalone — it doesn't depend on `server/` and
is handy for skeleton format conversion.

---

## License

MIT
