import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Source-level regression guards for the two ways the floating Foreman overlay
// broke the surface behind it (RUSH-1522 follow-up):
//
//  1. The orb root is `position: fixed; bottom: 16; right: 16`, so it floats over
//     the Fleet detail column. With no reserved space the newest Activity line
//     rendered underneath the composer and could not be scrolled clear — measured
//     71px of the now-line covered at a 430px column.
//  2. The composer is `rows={1}` at width 260. The old placeholder wrapped to a
//     second line the one-row box then clipped — measured 17px of clipped text.

const orbPath = join(import.meta.dir, 'ForemanOrb.tsx')
const indexCssPath = join(import.meta.dir, '../../index.css')
const floorCssPath = join(import.meta.dir, '../mission-control/floor.css')
const panelCssPath = join(import.meta.dir, '../panel/panel.css')

const orb = readFileSync(orbPath, 'utf8')
const indexCss = readFileSync(indexCssPath, 'utf8')
const floorCss = readFileSync(floorCssPath, 'utf8')
const panelCss = readFileSync(panelCssPath, 'utf8')

/** The persistent overlay stack, from the real values in ForemanOrb.tsx. */
const ORB_SIZE_ACTIVE = 56 // OrbBlob: `const size = big ? 56 : 40`
const STACK_GAP = 10 // foreman-orb-root `gap: 10`
const SPEAKER_HEIGHT = 19 // 10px/1.3 text + 2+2 padding + 2 border
const COMPOSER_HEIGHT = 36 // 12.5px * 1.4 line + 8+8 padding + 2 border
const BOTTOM_OFFSET = 16 // foreman-orb-root `bottom: 16`
const OVERLAY_FOOTPRINT =
  ORB_SIZE_ACTIVE + STACK_GAP + SPEAKER_HEIGHT + STACK_GAP + COMPOSER_HEIGHT + BOTTOM_OFFSET

/** The composer's usable text width, from its inline style in ForemanOrb.tsx. */
const COMPOSER_WIDTH = 260
const COMPOSER_PADDING_X = 11
const COMPOSER_BORDER = 1
const COMPOSER_FONT_PX = 12.5
// Inter averages ~0.5em per glyph for mixed-case Latin; the browser check that
// motivated this test clipped a 44-character placeholder and fit a 28-character
// one at this width, which brackets the cap below.
const AVG_GLYPH_RATIO = 0.5
const MAX_PLACEHOLDER_CHARS = Math.floor(
  (COMPOSER_WIDTH - 2 * COMPOSER_PADDING_X - 2 * COMPOSER_BORDER) /
    (COMPOSER_FONT_PX * AVG_GLYPH_RATIO),
)

describe('Foreman overlay does not cover the surface behind it', () => {
  test('the orb root is a viewport-fixed bottom-right overlay', () => {
    expect(orb).toContain("position: 'fixed'")
    expect(orb).toMatch(/bottom:\s*16/)
    expect(orb).toMatch(/right:\s*16/)
  })

  test('index.css declares a clearance at least the overlay footprint', () => {
    const declared = indexCss.match(/--foreman-overlay-clear:\s*(\d+)px/)
    expect(declared).not.toBeNull()
    expect(Number(declared![1])).toBeGreaterThanOrEqual(OVERLAY_FOOTPRINT)
  })

  test('the Fleet detail column reserves that clearance', () => {
    const rule = floorCss.match(/\.swarmify-root \.detail-col \{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('padding-bottom: var(--foreman-overlay-clear)')
  })

  test('the Panel tab reserves that clearance', () => {
    // Rendered as a sibling of the overlay (App.tsx), full height, own scrollbar —
    // its bottom-right corner is under the orb exactly like the detail column's.
    const rule = panelCss.match(/\.sw-panel-tab \{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('padding-bottom: var(--foreman-overlay-clear)')
  })

  test('the placeholder fits the one-row composer', () => {
    expect(orb).toContain('rows={1}')
    const placeholder = orb.match(/placeholder="([^"]+)"/)
    expect(placeholder).not.toBeNull()
    expect(placeholder![1].length).toBeLessThanOrEqual(MAX_PLACEHOLDER_CHARS)
  })
})
