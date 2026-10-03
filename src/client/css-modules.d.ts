/**
 * Ambient typing for CSS Modules imported by the browser half.
 *
 * tsdown/rolldown resolve `*.module.css` to a class-name map at build time; this
 * declaration is what makes `import styles from './panel.module.css'` typecheck.
 * It covers every `*.module.css` import in the project, so it lives at
 * `src/client/` root rather than next to one component.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
