# Pi Workbench HTML Guide

This directory contains the local documentation site for Pi Workbench. It turns
the canonical repository guides into a simpler, searchable browser reference
for commands, memory, review, cmux supervision, paired terminals, and the
floating pet.

The documentation sources mirrored into the site are:

- [`../README.md`](../README.md) -> [`public/README.md`](./public/README.md)
- [`../QUICKSTART.md`](../QUICKSTART.md) -> [`public/QUICKSTART.md`](./public/QUICKSTART.md)

Keep each public copy byte-for-byte identical to its canonical source. The root
test suite verifies this contract.

## Requirements

- Node.js `>=22.13.0`
- dependencies installed with `npm ci`

## Run locally

```bash
cd html-guide
npm ci
npm run dev
```

Open the local URL printed by vinext. The site is a read-only guide; Pi runtime
state, session content, credentials, and journal data are never loaded into it.

## Validate

```bash
npm run lint
npm test
```

`npm test` builds the site and verifies the rendered loading and guide surfaces.
From the repository root, `npm test` verifies that the public Markdown mirrors
have not drifted from their canonical files.

## Main files

- `app/page.tsx`: guide sections and command reference
- `app/globals.css`: documentation layout and visual styling
- `public/README.md`: mirrored Workbench overview
- `public/QUICKSTART.md`: mirrored complete guide
- `tests/rendered-html.test.mjs`: rendered-site contract

The app does not use a database or require the optional starter authentication
helpers for its current read-only documentation workflow.
