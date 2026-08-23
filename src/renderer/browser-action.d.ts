import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /** electron-chrome-extensions が preload で注入する Web Component。 */
      'browser-action-list': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { partition?: string; tab?: string; alignment?: string },
        HTMLElement
      >
    }
  }
}
