import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'

/**
 * Just enough of a browser for `@excalidraw/excalidraw`'s element conversion to import and run in a Bun child process, with
 * one real part: the 2D canvas. Excalidraw sizes a label by `canvas.getContext('2d').measureText`, so measuring with
 * the package's own fonts (the same woff2 files the app loads) gives the widths the app gives. A DOM stub with a fake
 * `measureText` sized every label by a guess; without the app's font the widths come out about 30 % too narrow.
 *
 * Installs on the process's own `globalThis` and registers fonts in the process-wide native registry: only the hydration
 * child (`hydrate-child.ts`) calls it; never import it into the host process.
 */

/** Folder name under the package's `fonts/` → the family name Excalidraw puts in its CSS font strings. */
const FAMILIES: Record<string, string[]> = {
  Excalifont: ['Excalifont'],
  Virgil: ['Virgil'],
  Cascadia: ['Cascadia'],
  Nunito: ['Nunito'],
  Lilita: ['Lilita One'],
  ComicShanns: ['Comic Shanns'],
  // `Helvetica` has no file in the package; Liberation Sans is metric-compatible with it.
  Liberation: ['Liberation Sans', 'Helvetica'],
}

const noop = () => {}

/**
 * Registers the package's fonts under one alias per file, and returns the alias stack of every CSS family name.
 * Throws when a family registers no file: a missing family would not fail, the canvas would measure in a fallback
 * font and every label of that family would come out the wrong width.
 */
export function registerFonts(fontsDir: string): Map<string, string> {
  const stacks = new Map<string, string>()
  for (const [folder, names] of Object.entries(FAMILIES)) {
    // A family ships as several unicode-range subsets; a canvas font string takes one typeface per family name, so
    // every subset gets its own alias and the font string lists them all (per-glyph fallback down the list).
    const aliases: string[] = []
    for (const file of readdirSync(join(fontsDir, folder)).sort()) {
      const alias = `${folder}-${aliases.length}`
      if (GlobalFonts.registerFromPath(join(fontsDir, folder, file), alias)) aliases.push(alias)
    }
    if (aliases.length === 0)
      throw new Error(`font family ${folder}: no font file registered from ${join(fontsDir, folder)}`)
    for (const name of names) stacks.set(name, aliases.join(', '))
  }
  return stacks
}

export function installDomShim(fontsDir: string): void {
  const stacks = registerFonts(fontsDir)
  const family = new RegExp(`\\b(${[...stacks.keys()].join('|')})\\b`, 'g')
  const rewrite = (font: string) => font.replace(family, (name) => stacks.get(name) ?? name)

  const canvas = () => {
    const element = createCanvas(10, 10)
    const getContext = element.getContext.bind(element)
    // biome-ignore lint/suspicious/noExplicitAny: the shim hands Excalidraw a canvas it types as the DOM's
    ;(element as any).getContext = (type: '2d') => {
      const context = getContext(type)
      return new Proxy(context, {
        set(target, key, value) {
          Reflect.set(target, key, key === 'font' ? rewrite(String(value)) : value)
          return true
        },
        get(target, key) {
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
    return element
  }
  const element = (tag: string) =>
    tag === 'canvas'
      ? canvas()
      : {
          tagName: tag,
          style: {},
          setAttribute: noop,
          appendChild: noop,
          addEventListener: noop,
          classList: { add: noop, remove: noop },
        }

  const scope = globalThis as Record<string, unknown>
  scope.window = globalThis
  scope.self = globalThis
  scope.devicePixelRatio = 1
  scope.addEventListener = noop
  scope.removeEventListener = noop
  scope.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop })
  scope.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
  scope.location ??= {
    href: 'http://localhost/',
    origin: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
    search: '',
  }
  scope.document = {
    createElement: element,
    createElementNS: (_namespace: string, tag: string) => element(tag),
    documentElement: element('html'),
    body: element('body'),
    head: element('head'),
    addEventListener: noop,
    removeEventListener: noop,
    fonts: { add: noop, load: async () => [], ready: Promise.resolve(), check: () => true },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createTextNode: () => ({}),
  }
  // Classes the package touches at import (`instanceof`, `extends`); none is used by element conversion.
  for (const name of [
    'HTMLElement',
    'Element',
    'Node',
    'HTMLCanvasElement',
    'CanvasRenderingContext2D',
    'Image',
    'HTMLImageElement',
    'SVGElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'ResizeObserver',
    'IntersectionObserver',
    'MutationObserver',
    'FontFace',
    'Path2D',
    'OffscreenCanvas',
    'DOMMatrix',
    'DOMParser',
    'XMLSerializer',
    'FileReader',
  ])
    scope[name] ??= class {}
}
