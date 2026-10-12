---
name: Nivra Website
description: "Your thoughts, together."
colors:
  canvas: "var(--bg)"
  surface: "var(--surface)"
  soft-surface: "var(--soft)"
  ink: "var(--fg)"
  muted-ink: "var(--muted)"
  divider: "var(--line)"
  action: "var(--button)"
  action-ink: "var(--button-text)"
  selection: "var(--selection)"
typography:
  display:
    fontFamily: "Geist, sans-serif"
    fontSize: "clamp(48px, 5.55vw, 80px)"
    fontWeight: 540
    lineHeight: 1.03
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Geist, sans-serif"
    fontSize: "clamp(34px, 3.2vw, 46px)"
    fontWeight: 540
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Geist, sans-serif"
    fontSize: "23px"
    fontWeight: 540
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Geist, sans-serif"
    fontSize: "16px"
    lineHeight: 1.6
  link:
    fontFamily: "Geist, sans-serif"
    fontSize: "14px"
    fontWeight: 500
  action:
    fontFamily: "Geist, sans-serif"
    fontSize: "14px"
    fontWeight: 550
  tab:
    fontFamily: "Geist, sans-serif"
    fontSize: "14px"
    fontWeight: 520
  label:
    fontFamily: "Geist, sans-serif"
    fontSize: "11px"
    fontWeight: 450
    letterSpacing: "0.01em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "13px"
    lineHeight: 2
rounded:
  control: "8px"
  frame: "12px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
    height: "48px"
  button-primary-small:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
    width: "44px"
  text-link:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.link}"
    height: "44px"
  workflow-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.tab}"
    rounded: "{rounded.control}"
    padding: "10px 20px"
    height: "44px"
  workflow-tab-selected:
    backgroundColor: "{colors.soft-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.tab}"
    rounded: "{rounded.control}"
    padding: "10px 20px"
    height: "44px"
  framed-surface:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.frame}"
    width: "100%"
---

# Design System: Nivra Website

## Overview

**Creative North Star: "A Clear Space to Think"**

Nivra’s visual language is quiet, precise, and approachable. Local Geist carries the words, while a near-monochrome palette leaves attention on the product itself. A restrained hierarchy and generous spacing make a small amount of detail feel considered.

Real Nivra screens do the explaining. The website uses authored demonstration content and identifies it as an example; the N mark and product interface remain the recognizable identity.

**Key Characteristics:**

- Restrained grayscale with paired light and dark modes.
- Geist hierarchy, generous spacing, and thin framing.
- Real product screens with clearly identified demonstration content.

## Colors

The palette uses near-white and charcoal surfaces with quiet gray text and dividers. Semantic values in the frontmatter point to the live CSS properties, which swap with the active theme.

### Primary

- **Monochrome action:** The main action uses a solid fill and opposite-tone text; the pair reverses in dark mode.

### Neutral

- **Canvas and surface:** The page background and framed content surfaces establish the main contrast.
- **Soft surface:** Selected tabs and control hover states receive a subtle tonal lift.
- **Ink and muted ink:** Primary copy stays crisp while supporting text recedes.
- **Divider:** Thin outlines separate framed regions without adding depth effects.
- **Selection:** Text selection remains visible in either theme.

**The Neutral-First Rule.** Use contrast, weight, and tonal surfaces for emphasis; keep the core UI monochrome.

## Typography

**Display Font:** Geist (bundled locally, with sans-serif fallback)

**Body Font:** Geist (bundled locally, with sans-serif fallback)

**Label/Mono Font:** Geist for labels; system monospace for installation commands

**Character:** Geist gives the page a compact, clear voice across headings, body copy, controls, and labels. The terminal block switches to a familiar system monospace.

### Hierarchy

- **Display** (`typography.display`): The large lead heading uses a responsive, tightly tracked line.
- **Headline** (`typography.headline`): Section headings keep the same weight and tracking at a quieter scale.
- **Title** (`typography.title`): Workflow titles remain direct and compact.
- **Body** (`typography.body`): Paragraphs use relaxed leading; individual sections tune size to their role.
- **Label** (`typography.label`): Small window labels sit quietly inside the screenshot frame.
- **Mono** (`typography.mono`): Docker commands use a separate system monospace stack.

On narrower screens the lead and section headings step down, while body copy and controls keep readable sizes. The heading values and the desktop baseline are recorded in the frontmatter.

## Layout

Content sits in a centered container capped at 1140px. The desktop page pairs columns for the introduction, ownership details, setup, and two compact feature panels; intermediate widths tighten the side gutters before content grids stack for mobile. Sections have measured separation, while controls stay compact.

The implemented responsive breakpoints are 1000px, 760px, 600px, and 360px. The page begins with the Nivra wordmark and hero; theme control sits in the footer. At 760px the main two-column groups become single-column. At 600px screenshot frames use portrait captures; at 360px gutters and action gaps tighten again. The sidecar records the exact breakpoint values.

## Elevation & Depth

There are no box shadows. A quiet surface shift and one-pixel outlines define the screenshot and command frames; content remains flat at rest.

**The Flat-Frame Rule.** Separate regions with tonal surfaces and thin strokes; do not add shadow elevation.

## Shapes

Controls and selected tabs have softly curved corners. Screenshot and installation frames use the larger shared corner, with clipped contents and a fine border. The N mark and small circular window dots are the only recurring geometric accents; there are no pill-shaped containers.

## Components

### Buttons

- **Primary:** The main calls to action use an opposite-tone solid fill, a compact label, and a small inline arrow.
- **Hover / Focus:** Hover slightly reduces opacity. Keyboard focus uses a visible foreground outline with offset; it does not rely on color change alone.
- **Icon controls:** Theme and copy buttons use a transparent square hit area with a soft hover fill. Each has a changing or purpose-specific accessible name.
- **Text links:** Secondary actions remain plain inline links with an arrow or external-link mark; hover underlines are reserved for these links.

### Cards / Containers

- **Screenshot frame:** Real application screenshots sit inside a thinly bordered, clipped frame with a quiet top bar and caption. Desktop images use the real 16:10 application capture; mobile selects the real portrait capture.
- **Feature panels:** Two flat, bordered preview panels show optional Smart Tags and meaning-based search with real product captures using synthetic demonstration content. The panels pair short behavior-focused copy with theme-specific desktop and portrait mobile screenshots; each screenshot opens its full-size desktop image for inspection.
- **Installation panel:** The Docker command block shares the framed surface language and allows horizontal scrolling when needed. Copy feedback is announced through a live status region.
- **Shadow strategy:** Flat; see Elevation & Depth.

### Page entry and footer

- **Hero:** The Nivra mark and wordmark sit directly above the tagline. There is no global header or menu.
- **Footer:** GitHub and MIT license links sit opposite a 44px theme control, aligned to the content gutter. No repeated logo or tagline appears in the footer.

### Workflow Tabs

Four tabs use a soft background and foreground ink when selected; inactive tabs stay transparent and muted. Left/Right arrows move between tabs, while Home and End jump to the first and last. Selecting a tab updates its corresponding copy and real screenshot.

### Smart Tags and Semantic Search

Two optional preview features appear after the core workflow demonstrations. Smart Tags presents suggestions from the owner's tag vocabulary, with review or automatic modes; semantic search helps locate related work by meaning. The copy stays concise and avoids accuracy or performance claims. Theme-specific screenshots use authored demonstration data, with portrait captures selected at phone widths.

## Do's and Don'ts

### Do:

- **Do** keep the grayscale palette, bundled Geist, and simple N mark as the website’s visual base.
- **Do** use real Nivra captures with authored demonstration content, visibly described as examples.
- **Do** retain visible keyboard focus, semantic labels, and reduced-motion behavior.

### Don't:

- **Don't** copy Linear or Polar assets or branding; they are references for restraint and hierarchy.
- **Don't** use unverified screenshots, personal data, invented metrics, or testimonials.
