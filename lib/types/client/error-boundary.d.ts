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
import { Component } from 'react';
import type { ComponentType, ErrorInfo, ReactElement, ReactNode } from 'react';
interface BoundaryProps {
    readonly children?: ReactNode;
}
interface BoundaryState {
    readonly error: Error | null;
}
/** Catches a render/lifecycle error below it and renders a report instead. */
export declare class SeatErrorBoundary extends Component<BoundaryProps, BoundaryState> {
    state: BoundaryState;
    static getDerivedStateFromError(error: Error): BoundaryState;
    componentDidCatch(error: Error, info: ErrorInfo): void;
    render(): ReactNode;
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
export declare function withSeatBoundary<P extends object>(Seat: ComponentType<P>): (props: P) => ReactElement;
export {};
