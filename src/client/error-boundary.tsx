/**
 * dsh-codehub — a seat-level render guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a component in a seat throws, React unmounts that subtree and the shell
 * shows an EMPTY region. The user sees "点开什么都没有" and there is nothing to
 * report — no message, no stack, nothing in the UI.
 *
 * That is exactly what happened: the browser half imported four icons by their
 * 0.1.5-era names (`IconPlusOutline16`, …) while the live runtime is 0.2.0-rc.2,
 * where they were renamed. The imports were `undefined`, rendering `<undefined />`
 * threw, and BOTH the panel and the settings section silently came up blank. The
 * sidebar row kept working because it uses no SDK component — which is the sort of
 * partial failure that reads as a mystery.
 *
 * So every seat this plugin registers is wrapped in this boundary, which converts
 * a blank region into a readable message naming the failure and pointing at the
 * check that localises it. It deliberately imports NOTHING from the SDK: a guard
 * that can itself fail to load guards nothing.
 */

import { Component } from 'react'
import type { ComponentType, ErrorInfo, ReactElement, ReactNode } from 'react'

import styles from './panel.module.css'

interface BoundaryProps {
  readonly children?: ReactNode
}

interface BoundaryState {
  readonly error: Error | null
}

/** Catches a render/lifecycle error below it and renders a report instead. */
export class SeatErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      console.error('[dsh-codehub] 座位渲染失败 / seat render failed', error, info.componentStack)
    } catch {
      /* a console that rejects writes must not break the guard */
    }
  }

  override render(): ReactNode {
    const error = this.state.error
    if (error === null) return this.props.children
    return (
      <div className={styles.root}>
        <p className={styles.err}>codehub 渲染失败：{error.message}</p>
        <p className={styles.help}>
          最常见的两种原因：插件依赖的 DSH 接口改名/不存在了（例如 primitives 的图标前缀），
          或者某个必填配置写坏了。在插件目录里运行 <code>pnpm run verify:sdk</code> 可以定位到
          具体是哪个名字不存在。
        </p>
        <p className={styles.help}>
          The plugin failed to render. The usual cause is a renamed or missing DSH
          interface — run <code>pnpm run verify:sdk</code> in the plugin directory to
          see which imported name no longer exists on this runtime.
        </p>
      </div>
    )
  }
}

/**
 * Wrap a seat component so a throw becomes a readable message.
 *
 * Returns a FUNCTION component (not `ComponentType`) on purpose: the seats are
 * checked with `satisfies (props: X) => unknown`, which a `ComponentType` union
 * cannot satisfy.
 *
 * @param Seat - the seat component the shell will render.
 * @returns a component with the same props, guarded by {@link SeatErrorBoundary}.
 */
export function withSeatBoundary<P extends object>(Seat: ComponentType<P>): (props: P) => ReactElement {
  function GuardedSeat(props: P): ReactElement {
    return (
      <SeatErrorBoundary>
        <Seat {...props} />
      </SeatErrorBoundary>
    )
  }
  GuardedSeat.displayName = `withSeatBoundary(${Seat.displayName ?? Seat.name ?? 'Seat'})`
  return GuardedSeat
}
