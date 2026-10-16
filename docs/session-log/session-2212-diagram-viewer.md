# Session 2212 — Diagrams and display math you can read (#5638)

Mermaid diagrams and display math were hard to read in several ways:

- Display math was clipped at phone width, and nothing could scroll it.
- Mermaid's stock themes ignored the app's tokens, so diagrams did not match
  the theme, and edge labels sat on grey boxes.
- Mermaid's `useMaxWidth` shrank a wide diagram to fit, without limit. On a
  phone its labels came out a few pixels tall.

**What changed:**

- **Display math** sits in a horizontal `ScrollArea`. KaTeX's error colour
  is now a token. Inline math is unchanged.
- **Mermaid** renders with `theme: 'base'` and `themeVariables` built from
  the design tokens, and re-renders when the theme changes. WebKitGTK
  returns `oklch()` unchanged from both `getComputedStyle` and a canvas
  `fillStyle`, so `readDiagramColors` paints each token onto a pixel and
  reads sRGB back. `securityLevel: 'strict'` stays.
- **Wide diagrams** stop shrinking where the smallest label would drop
  below a legible size, and scroll from there. Tall ones are capped, with a
  fade.
- **The viewer.** `ImageLightbox`'s zoom and pan became `useZoomPan` plus
  `ZoomControls`, which a new `DiagramViewer` shares. Its controls:
  - Expand, which is always visible on touch;
  - Fit, 100%, zoom and pan, including pinch;
  - Copy source and Download SVG.

  Display math gets the same viewer with Copy LaTeX. The lightbox's tests
  pass unchanged, and it gained pinch.
- **Edit mode.** The Expand button and the viewer stop clicks so a static
  block does not enter edit mode. Opened from the editor, the viewer
  carries `data-editor-portal`.

**One premise was partly false.** The issue expected the dark theme to fail
contrast. The stock dark theme already passed, so contrast alone could not
show the fix red. The e2e checks instead that text, edges and edge-label
backgrounds take the theme's tokens. With the stock theme forced back, all
six resolved themes fail that check.

**Not done:** the viewer's fit and the inline fade are not recomputed on
resize. Download SVG reuses `downloadBlob`, as export and bug reports do.

Review found that pinch, wheel and drag worked only on the diagram's own box.
On a phone the fitted diagram can be a thin strip, so a pinch across it did
nothing. The gesture handlers now sit on the whole viewer and the transform
stays on the diagram; a pinch that starts outside the strip was shown red
first. Review also cut twenty theme variables that Mermaid's `updateColors`
derives from the ones still set, and an unused `maxZoom` option.
