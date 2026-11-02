import type { Locator } from '@playwright/test'

type PlaceProbe = { anchor: Element; scroller: HTMLElement; scrollTop: number; anchorTop: number }
type ProbeWindow = Window & { __typosePlaceProbe?: PlaceProbe }

/** Capture the actual pointerdown place, after Playwright has scrolled the link to its click point. */
export async function armPlaceProbe(anchor: Locator): Promise<void> {
  await anchor.evaluate((element) => {
    const scroller = element.closest('.md-scroller') as HTMLElement | null
    if (!scroller) throw new Error('Markdown anchor has no scroller')
    element.addEventListener('pointerdown', () => {
      const linkRect = element.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      ;(window as ProbeWindow).__typosePlaceProbe = {
        anchor: element, scroller, scrollTop: scroller.scrollTop, anchorTop: linkRect.top - scrollerRect.top
      }
    }, { capture: true, once: true })
  })
}

export async function readPlaceProbe(anchor: Locator): Promise<{
  sameNodes: boolean; originScrollTop: number; originAnchorTop: number; scrollTop: number; anchorTop: number
}> {
  return anchor.evaluate((element) => {
    const scroller = element.closest('.md-scroller') as HTMLElement
    const probe = (window as ProbeWindow).__typosePlaceProbe
    if (!probe) throw new Error('Markdown pointerdown place was not recorded')
    const linkRect = element.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    return {
      sameNodes: probe.anchor === element && probe.scroller === scroller,
      originScrollTop: probe.scrollTop, originAnchorTop: probe.anchorTop,
      scrollTop: scroller.scrollTop, anchorTop: linkRect.top - scrollerRect.top
    }
  })
}
